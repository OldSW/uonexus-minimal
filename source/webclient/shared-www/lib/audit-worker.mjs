// Cache-integrity audit worker (v0.9.631).
//
// Reads the cached gamefiles out of OPFS and SHA-256s them HERE, so the 1.4 GB never
// touch the page's main thread. Measured on a 2017 i5-7300U in power-saving mode over
// the real 239-file / 1747 MiB cache: doing this on main stalls the main thread 933 ms
// with 15 stalls over 300 ms; here it is 30 ms with none. Under Mercury MT the game loop
// lives on the deputy worker and every proxied-to-main call stalls behind those blocks,
// which is why it surfaced as `upd` spikes of up to 2.6 s while running through Britain.
//
// 🚨 THIS IS A FILE, NOT A BLOB, AND THAT IS THE WHOLE POINT.
// v0.9.630 shipped the same worker built from `URL.createObjectURL(new Blob([...]))` and
// it was DEAD ON ARRIVAL in production: index.html carries a meta CSP whose
// `default-src 'self'` (there is no worker-src, and no child-src to fall back to) does
// not allow blob:, so the worker was blocked before running a line. The failure is
// silent-by-design — `worker.onerror` fires with message/filename/lineno all null, which
// reads like a mystery rather than a policy decision, and the audit just fell back to the
// main thread. The CSP is not the thing to change: `new URL('./lib/...', import.meta.url)`
// is same-origin and satisfies `'self'`, and main.js already used exactly that for
// js-poll-worker.mjs, with a comment naming "a CSP block" as one of the failed attempts.
//
// The cost of the digest itself is NOT why this exists: crypto.subtle.digest is async and
// blocks the main thread 0 ms. The cost is the accumulated READ — one file is 21 ms, but
// twelve in a row reach 2226 ms of GC pressure from 100-185 MiB buffers allocated and
// dropped in sequence. Moving only the hash was tried, measured and reverted.
//
// Protocol: postMessage({ dirName, keys }) -> { done: [[key, hexOrNull, byteLength], ...] }
// A file that cannot be read yields null rather than aborting the pass, so one missing
// entry costs its own result and not the whole audit. Fatal errors report { fatal }.

self.onmessage = async (e) => {
  const { dirName, keys } = e.data || {};
  const out = [];
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    for (const k of keys) {
      try {
        const fh = await dir.getFileHandle(k);
        const raw = new Uint8Array(await (await fh.getFile()).arrayBuffer());
        // Same framing as opfsDecode() in main.js: 4-byte LE etag length, etag, payload.
        // Hashing the raw file instead would produce a hash that never matches the
        // shard's reference and would mark every healthy file as corrupt.
        let bytes = raw;
        if (raw.length >= 4) {
          const n = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, true);
          if (raw.length >= 4 + n) bytes = raw.subarray(4 + n);
        }
        const d = await crypto.subtle.digest('SHA-256', bytes);
        const v = new Uint8Array(d);
        let h = '';
        for (let i = 0; i < v.length; i++) h += v[i].toString(16).padStart(2, '0');
        out.push([k, h, bytes.length]);
      } catch {
        out.push([k, null, 0]);          // not cached / unreadable — the caller counts it
      }
    }
    self.postMessage({ done: out });
  } catch (err) {
    self.postMessage({ fatal: String((err && err.message) || err) });
  }
};
