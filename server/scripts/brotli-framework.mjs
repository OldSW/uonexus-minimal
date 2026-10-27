#!/usr/bin/env node
// brotli-framework.mjs — generate `.br` twins for client/_framework/*.wasm
// + *.js so nginx's brotli_static serves the compressed bytes to clients
// that advertise Accept-Encoding: br. Halves the over-the-wire size of
// the dotnet.native.*.wasm payload (~84 MB → ~40 MB), which mitigates
// Cloudflare/cloudflared mid-stream aborts on the large file.
//
// Idempotent: skips files that already have an up-to-date .br twin
// (compares mtimes). Re-running after a build only compresses new
// files.
//
// Q11 by default. Run via:
//   node server/scripts/brotli-framework.mjs --in client/_framework
//
// To produce twins for a tree on the NAS via SMB, just pass the
// SMB path as --in.

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { brotliCompressSync, constants } from 'node:zlib';
import { join, basename } from 'node:path';
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const EXT_MATCH = /\.(wasm|js|mjs)$/i;

function parseArgs(argv) {
  // v0.3.21 audit fix: cap default worker count by AVAILABLE MEMORY,
  // not just CPU count. Each q11 brotli worker on the big wasm
  // (dotnet.native.<hash>.wasm ≈ 90 MB) peaks at ~700 MB-1 GB resident.
  // On a 16-core dev box that's 15 workers × 1 GB ≈ 15 GB transient
  // — fine on 32 GB but devastating on a smaller host. Cap at
  // min(cpus-1, mem/2GB, hard-ceiling 8) so memory-poor environments
  // serialise instead of OOM.
  // v0.3.36: hard-ceiling raised 4 → 8. Original 4 was conservative for
  // small dev boxes; on a 32 GB / 8-core host the cap was leaving 4
  // cores idle during the brotli step (~1-2 min wasted). The
  // mem-budget formula already protects 8/16 GB hosts (mem/2GB caps
  // earlier than 8 there).
  const memBudgetWorkers = Math.max(1, Math.floor(os.totalmem() / (2 * 1024 ** 3)));
  const cpuBudgetWorkers = Math.max(1, os.cpus().length - 1);
  const defaultWorkers = Math.min(cpuBudgetWorkers, memBudgetWorkers, 8);
  // v0.3.36: brotli quality 11 → 9. q11 was ~50% slower per file with
  // only ~5% better compression vs q9. On a 90 MB dotnet.native.wasm
  // that's ~30s saved per file. Total bundle weight goes up by ~700 KB
  // out of ~110 MB (<1% over the wire after CF caching). Worth it for
  // build iteration speed; CF edge cache amortises the size delta.
  const a = { workers: defaultWorkers, quality: 9 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--in') a.in = argv[++i];
    else if (k === '--quality') a.quality = parseInt(argv[++i], 10);
    else if (k === '--workers') a.workers = parseInt(argv[++i], 10);
  }
  if (!a.in) {
    console.error('usage: brotli-framework.mjs --in <dir> [--quality 1..11] [--workers N]');
    process.exit(1);
  }
  return a;
}

if (isMainThread) {
  const args = parseArgs(process.argv);
  const dir = args.in;
  const all = readdirSync(dir);

  // v0.4.45: purge orphan .br/.gz twins whose source .wasm/.js/.mjs no
  // longer exists. Fingerprinted file rebuilds (cuo.<oldhash>.wasm →
  // cuo.<newhash>.wasm) drop the source mirror via build.bat, but the
  // matching .br twin was never tracked there. After ~20 releases the
  // _framework dir was carrying ~340 MB of zombie dotnet.native.
  // <oldhash>.wasm.br files alone — 1.04 GB across all twins, vs an
  // expected <50 MB live working set. Verified via gh release view:
  // v0.4.31 = 864 MB → v0.4.44 = 1069 MB, ~30-50 MB/release growth.
  // Anyone downloading the GitHub zip was paying ~1 GB for ~50 MB of
  // signal. Keep the live source authoritative: any .br/.gz whose
  // base file isn't on disk gets deleted.
  const liveSources = new Set();
  for (const name of all) {
    if (name.endsWith('.br') || name.endsWith('.gz')) continue;
    if (!EXT_MATCH.test(name)) continue;
    liveSources.add(name);
  }
  let orphanCount = 0;
  let orphanBytes = 0;
  for (const name of all) {
    if (!name.endsWith('.br') && !name.endsWith('.gz')) continue;
    const baseName = name.slice(0, -3); // strip .br or .gz
    if (liveSources.has(baseName)) continue;
    if (!EXT_MATCH.test(baseName)) continue; // foreign twin, skip
    try {
      const orphanPath = join(dir, name);
      const sz = statSync(orphanPath).size;
      unlinkSync(orphanPath);
      orphanCount++;
      orphanBytes += sz;
    } catch (e) {
      console.warn(`[brotli-framework] could not purge orphan ${name}: ${e.message}`);
    }
  }
  if (orphanCount > 0) {
    console.log(`[brotli-framework] purged ${orphanCount} orphan twin(s), reclaimed ${(orphanBytes / 1024 / 1024).toFixed(1)} MB`);
  }

  const targets = [];
  for (const name of all) {
    if (!EXT_MATCH.test(name)) continue;
    if (name.endsWith('.br') || name.endsWith('.gz')) continue;
    const src = join(dir, name);
    const dst = src + '.br';
    let need = true;
    try {
      const srcSt = statSync(src);
      const dstSt = statSync(dst);
      if (dstSt.mtimeMs >= srcSt.mtimeMs) need = false;
    } catch { /* dst missing */ }
    if (need) targets.push({ src, dst, name });
  }
  if (targets.length === 0) {
    console.log('[brotli-framework] no targets need updating');
    process.exit(0);
  }
  console.log(`[brotli-framework] ${targets.length} files to compress at q${args.quality}, ${args.workers} workers`);
  let totalRaw = 0;
  let totalBr  = 0;
  let done = 0;
  let totalErr = 0;
  const startMs = Date.now();
  const __filename = fileURLToPath(import.meta.url);

  // Worker pool — message-passing, single Worker per CPU, drain queue.
  const queue = [...targets];
  const workers = [];
  let running = 0;

  function spawnNext(w) {
    if (queue.length === 0) {
      w.postMessage({ kind: 'shutdown' });
      return;
    }
    const t = queue.shift();
    w.postMessage({ kind: 'work', src: t.src, dst: t.dst, name: t.name, quality: args.quality });
  }

  for (let i = 0; i < args.workers; i++) {
    const w = new Worker(__filename, { workerData: {} });
    workers.push(w);
    running++;
    w.on('message', (m) => {
      if (m.kind === 'result') {
        if (m.err) { totalErr++; console.error(`  ERR  ${m.name}: ${m.err}`); }
        else {
          totalRaw += m.raw;
          totalBr  += m.br;
          done++;
          const idx = done.toString().padStart(3);
          const pct = Math.round((m.br / m.raw) * 100);
          console.log(`  [${idx}/${targets.length}] ${m.name.padEnd(50)} raw=${m.raw.toString().padStart(10)} br=${m.br.toString().padStart(10)} (${pct}%) ${m.ms}ms`);
        }
        spawnNext(w);
      } else if (m.kind === 'ready') {
        spawnNext(w);
      }
    });
    w.on('exit', () => {
      running--;
      if (running === 0) {
        const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
        console.log('');
        console.log(`[brotli-framework] === SUMMARY ===`);
        console.log(`[brotli-framework] ok=${done}  err=${totalErr}  elapsed=${elapsed}s`);
        if (totalRaw > 0) {
          console.log(`[brotli-framework] raw    = ${(totalRaw / 1024 / 1024).toFixed(1)} MB`);
          console.log(`[brotli-framework] br     = ${(totalBr  / 1024 / 1024).toFixed(1)} MB  (saved ${((totalRaw - totalBr) / 1024 / 1024).toFixed(1)} MB, ${Math.round(((totalRaw - totalBr) / totalRaw) * 100)}%)`);
        }
        if (totalErr > 0) process.exit(1);
      }
    });
  }
} else {
  parentPort.on('message', (m) => {
    if (m.kind === 'shutdown') { process.exit(0); }
    if (m.kind !== 'work') return;
    try {
      const t0 = Date.now();
      const raw = readFileSync(m.src);
      const br  = brotliCompressSync(raw, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: m.quality,
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_GENERIC,
        },
      });
      writeFileSync(m.dst, br);
      parentPort.postMessage({
        kind: 'result',
        name: m.name,
        raw: raw.length,
        br: br.length,
        ms: Date.now() - t0,
      });
    } catch (e) {
      parentPort.postMessage({ kind: 'result', name: m.name, err: e.message });
    }
  });
  parentPort.postMessage({ kind: 'ready' });
}
