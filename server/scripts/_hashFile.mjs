// _hashFile.mjs — SHA-256 of a file in fixed-size chunks, synchronously.
//
// 🚨 NEVER readFileSync A GAMEFILE TO HASH IT (audit 2026-10-29, M15). The asset worker hashed every
// source with fs.readFileSync, i.e. the WHOLE file in memory, inside a container capped at 1 GiB.
// A shard owner's large upload (a multi-GiB .uop is legal under the quota) OOM-killed the worker,
// which restarted and hashed the same file again: a crash loop that stopped compression for every
// shard. Files over 2 GiB could not be read at all (ERR_FS_FILE_TOO_LARGE), so they were skipped
// for ever. Memory here is one chunk, whatever the file size.
//
// Synchronous on purpose: the worker's scan is synchronous and memoised by mtime+size, so this is a
// drop-in replacement rather than a reason to restructure the scan.
import fs from 'node:fs';
import crypto from 'node:crypto';

const CHUNK = 4 * 1024 * 1024;

export function sha256FileSync(absPath) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(CHUNK);
  const fd = fs.openSync(absPath, 'r');
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      hash.update(n === CHUNK ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
