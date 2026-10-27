#!/usr/bin/env node
/**
 * framework-names.mjs — every `_framework` file is named by the hash of the bytes it actually ships.
 *
 *   node server/scripts/framework-names.mjs client/cuo client/tuo client/mini     # rename in place
 *   node server/scripts/framework-names.mjs --check client/mini                   # report, change nothing
 *
 * 🚨 WHY. `_framework/*` is served `immutable, max-age=1y`: a browser that has a URL never asks for it
 * again. The SDK's fingerprint hashes the SOURCE, so every post-build rewrite (the build-path strip)
 * changed bytes under a name that had promised not to change. It happened three times on 2026-09-02,
 * and every browser caught in one of those windows was left holding a loader whose bytes no longer
 * match the integrity pin: the module graph is refused, `main.js` never runs, and the page is a black
 * screen with no error the page can see. `check-immutable-promise` stopped NEW poisoning; it could not
 * cure a browser that was already poisoned, and main.js said the only remedy was for the player to
 * clear site data.
 *
 * Operator, 2026-09-14, after his own phone hit exactly that in two browsers: "no podemos estar
 * dependiendo de que los jugadores borren la cache, no es aceptable". The only lever that reaches a
 * browser holding an immutable copy is a URL it has never seen. Naming each file by its final bytes
 * gives that once to every poisoned browser, and makes the promise honest from then on: different
 * bytes are, by construction, a different URL.
 *
 * HOW. The names form a graph — the boot loader `dotnet.<fp>.js` names every other file, and
 * `index.html` names the loader and three modules. Renaming a leaf changes the text of whoever names
 * it, which changes THAT file's hash. So files are renamed leaves-first, each one's references
 * rewritten before its own hash is taken, and index.html last with its integrity pins recomputed.
 * A cycle is refused rather than guessed at.
 *
 * Idempotent: a bundle whose names already hash their bytes produces an empty plan.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/** `stem.<10 chars>.ext` — the shape the SDK uses, kept so every pattern that matches it still does. */
export const FP_NAME = /^(.+)\.([a-z0-9]{10})(\.[a-z0-9]+)$/;
const TEXT_EXT = /\.(m?js|json)$/;

/** 10 lowercase base-36 characters of the sha-256 of the bytes. */
export function contentFingerprint(buf) {
  const hex = crypto.createHash('sha256').update(buf).digest('hex');
  return BigInt('0x' + hex.slice(0, 16)).toString(36).padStart(13, '0').slice(-10);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name as a whole token: not glued to more name characters on either side. */
const token = (name) => new RegExp(`(?<![A-Za-z0-9_.-])${esc(name)}(?![A-Za-z0-9_-])`, 'g');

/** Replace every whole-token occurrence of each old name. Bytes outside the names are untouched. */
function substitute(buf, rename) {
  let text = buf.toString('latin1');           // names are ASCII, so latin1 round-trips every byte
  let hits = 0;
  for (const [from, to] of rename) {
    if (from === to || !text.includes(from)) continue;
    text = text.replace(token(from), () => { hits++; return to; });
  }
  return { buf: hits ? Buffer.from(text, 'latin1') : buf, hits };
}

/**
 * Pure: given the framework's files as { name -> bytes }, decide the new names.
 *
 * Returns { rename: Map<old,new>, contents: Map<newName, bytes>, rewritten: Set<newName> } where
 * `rewritten` are files whose bytes changed because a name inside them did.
 */
export function planContentNames(files) {
  const fp = [...files.keys()].filter((n) => FP_NAME.test(n));
  const fpSet = new Set(fp);
  // Who names whom. Only text files can name anything.
  const refs = new Map();
  for (const n of fp) {
    if (!TEXT_EXT.test(n)) { refs.set(n, []); continue; }
    const text = files.get(n).toString('latin1');
    refs.set(n, fp.filter((m) => m !== n && text.includes(m) && token(m).test(text)));
  }
  const rename = new Map(), contents = new Map(), rewritten = new Set();
  const done = new Set();
  let pending = fp.slice();
  while (pending.length) {
    const ready = pending.filter((n) => refs.get(n).every((m) => done.has(m)));
    if (!ready.length) {
      throw new Error('framework-names: the name graph has a cycle among ' + pending.slice(0, 5).join(', '));
    }
    for (const n of ready) {
      const { buf, hits } = substitute(files.get(n), rename);
      const [, stem, , ext] = FP_NAME.exec(n);
      const next = `${stem}.${contentFingerprint(buf)}${ext}`;
      // A file already sitting at the new name with THESE bytes is the leftover of an interrupted run
      // (new files are written before old ones are removed), not a collision: both names plan to the same
      // file and the old one is removed below. Throwing here made every re-run after an interruption fail
      // whenever the old name happened to be read first - so, almost always (audit 2026-09-15).
      if (next !== n && fpSet.has(next) && !rename.has(next) && !files.get(next).equals(buf)) {
        throw new Error(`framework-names: ${n} would become ${next}, which is already a different file`);
      }
      rename.set(n, next);
      contents.set(next, buf);
      if (hits) rewritten.add(next);
      done.add(n);
    }
    pending = pending.filter((n) => !done.has(n));
  }
  return { rename, contents, rewritten };
}

const sri = (buf) => 'sha256-' + crypto.createHash('sha256').update(buf).digest('base64');
const brotli = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

/**
 * Pure: rewrite a page that names framework files. Names first, then every integrity pin that points
 * into `_framework` is recomputed from the bytes it names — the fingerprinted key by its own name, the
 * bare importmap key through the importmap's own mapping.
 */
export function rewritePage(html, rename, contents) {
  const { buf } = substitute(Buffer.from(html, 'latin1'), rename);
  let out = buf.toString('latin1');
  let imports = {};
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(out);
  if (m) { try { imports = JSON.parse(m[1]).imports || {}; } catch { imports = {}; } }
  const bytesOf = (name) => {
    if (contents.has(name)) return contents.get(name);
    const mapped = imports['./_framework/' + name];
    const target = mapped && mapped.replace(/^\.\/_framework\//, '');
    return target && contents.has(target) ? contents.get(target) : null;
  };
  let pins = 0;
  out = out.replace(/"\.\/_framework\/([^"]+)":(\s*)"sha256-[A-Za-z0-9+/=]+"/g, (all, name, gap) => {
    const b = bytesOf(name); if (!b) return all;
    pins++; return `"./_framework/${name}":${gap}"${sri(b)}"`;
  });
  out = out.replace(/(href="_framework\/([^"]+)"[^>]*?integrity=")sha256-[A-Za-z0-9+/=]+(")/g, (all, head, name, tail) => {
    const b = bytesOf(name); if (!b) return all;
    pins++; return head + sri(b) + tail;
  });
  return { html: out, pins };
}

/** Apply to a bundle on disk. Returns { renamed, rewritten, pages, pins }. */
export function applyContentNames(bundleDir, { check = false, log = () => {} } = {}) {
  const fw = path.join(bundleDir, '_framework');
  if (!fs.existsSync(fw)) return { renamed: 0, rewritten: 0, pages: 0, pins: 0 };
  const files = new Map();
  for (const n of fs.readdirSync(fw)) {
    if (n.endsWith('.br') || !fs.statSync(path.join(fw, n)).isFile()) continue;
    files.set(n, fs.readFileSync(path.join(fw, n)));
  }
  const { rename, contents, rewritten } = planContentNames(files);
  const moves = [...rename].filter(([a, b]) => a !== b);
  if (check || !moves.length) return { renamed: moves.length, rewritten: rewritten.size, pages: 0, pins: 0 };

  // New files first, old ones removed only after every page naming them has been rewritten — an
  // interrupted run then leaves extra files, never a page pointing at a file that is gone.
  for (const [from, to] of moves) {
    const bytes = contents.get(to);
    const raw = path.join(fw, to);
    fs.writeFileSync(raw, bytes);
    const twin = path.join(fw, from + '.br');
    const newTwin = path.join(fw, to + '.br');
    let hasTwin = false;
    if (rewritten.has(to)) {
      fs.writeFileSync(newTwin, brotli(bytes)); hasTwin = true;
    } else if (fs.existsSync(twin)) {
      // Same bytes, so the same compressed twin - IF the twin really is of these bytes. A raw file changed
      // without its twin being regenerated would otherwise carry a stale twin under the new name, stamped
      // fresh below, past every timestamp gate (release-minimal never decompresses). Checked by content.
      let fresh = false;
      try { fresh = zlib.brotliDecompressSync(fs.readFileSync(twin)).equals(bytes); } catch { fresh = false; }
      if (fresh) fs.copyFileSync(twin, newTwin); else fs.writeFileSync(newTwin, brotli(bytes));
      hasTwin = true;
    }
    // 🚨 THE TWIN MUST NOT LOOK OLDER THAN THE FILE IT COMPRESSES. On Windows copyFile keeps the
    // source's timestamp, so every carried twin came out older than the raw file just written — and
    // two tools read that as stale: release-minimal REFUSES the release, and brotli-framework
    // recompresses it at a different quality, which is different bytes under the same `.br` URL: the
    // exact broken promise this file exists to end, one extension over. Stamp the twin with the raw
    // file's own time so "twin >= source" holds and nothing rewrites it.
    if (hasTwin) {
      // ⚠️ NOT `statSync(raw).mtime`: a Date carries whole milliseconds and the raw file's time has a
      // fraction, so the "same" time wrote the twin a few microseconds OLDER — the gate caught this
      // first version failing exactly the comparison it was written for. One millisecond past the
      // raw file, in seconds, is unambiguous.
      const t = (Math.ceil(fs.statSync(raw).mtimeMs) + 1) / 1000;
      fs.utimesSync(newTwin, t, t);
    }
  }
  let pages = 0, pins = 0;
  for (const n of fs.readdirSync(bundleDir)) {
    if (!/\.html$/.test(n)) continue;
    const p = path.join(bundleDir, n);
    const before = fs.readFileSync(p, 'latin1');
    const { html, pins: k } = rewritePage(before, rename, contents);
    if (html === before) continue;
    fs.writeFileSync(p, Buffer.from(html, 'latin1'));
    if (fs.existsSync(p + '.br')) fs.writeFileSync(p + '.br', brotli(Buffer.from(html, 'latin1')));
    pages++; pins += k;
  }
  const targets = new Set(moves.map(([, to]) => to));
  // 🚨 THE OLD LOADER IS REMOVED FIRST (audit 2026-09-15). It is the only file that names the others, and
  // removal used to run in plan order - assemblies before it - so a removal interrupted part-way (an
  // antivirus lock, a Ctrl-C) left the old loader pointing at deleted files. The next run took it for a
  // live file and renamed it again, and nothing ever removed that orphan; it was zipped and ledgered.
  const isLoader = (n) => /^dotnet\.[a-z0-9]+\.js$/.test(n);
  const removal = [...moves].sort((a, b) => Number(isLoader(b[0])) - Number(isLoader(a[0])));
  for (const [from, to] of removal) {
    if (from === to || targets.has(from)) continue;   // never remove a name some move just wrote
    for (const f of [from, from + '.br']) {
      const p = path.join(fw, f);
      if (fs.existsSync(p)) fs.rmSync(p);
    }
  }
  log(`  ${path.basename(bundleDir)}: ${moves.length} framework file(s) renamed to their content hash`
    + ` (${rewritten.size} rewritten), ${pages} page(s), ${pins} pin(s) refreshed`);
  return { renamed: moves.length, rewritten: rewritten.size, pages, pins };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes('--check');
  const targets = argv.filter((a) => !a.startsWith('--'));
  if (!targets.length) {
    console.error('usage: framework-names.mjs [--check] <bundle dir> [...]');
    process.exit(2);
  }
  let pending = 0;
  for (const t of targets) {
    const r = applyContentNames(path.resolve(t), { check: CHECK, log: console.log });
    if (CHECK && r.renamed) {
      pending += r.renamed;
      console.log(`  ${t}: ${r.renamed} framework name(s) do not hash their bytes`);
    }
  }
  if (CHECK && pending) {
    console.error(`framework-names: ${pending} name(s) would let an immutable URL change its bytes — run without --check`);
    process.exit(1);
  }
  if (CHECK) console.log('framework-names: every framework name hashes its bytes');
}
