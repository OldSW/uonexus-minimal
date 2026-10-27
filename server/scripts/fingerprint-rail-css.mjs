// Fingerprint client/<bundle>/rail.css -> rail.<hash>.css (+ .br twin) and
// rewrite the stylesheet <link> in index.html.
//
// Why this exists: the .NET WebAssembly SDK fingerprints *.js (main.<hash>.js,
// rail.<hash>.js) but its HTML placeholder rewriter does NOT fingerprint a .css
// <link> — it leaves rail.css plain-named. A plain-named, MUTABLE stylesheet is
// a cache hazard: a CDN edge can pin an `immutable` copy (Cloudflare's default
// before our nginx no-store override) for up to a year, and our purge token is
// scoped to a DIFFERENT Cloudflare zone (example.com) than the app domain
// (uonexus.com) — so we cannot purge it by URL at all. Fingerprinting sidesteps
// the whole problem: every rail.css change yields a fresh URL the CDN has never
// seen, served origin-fresh immediately, and cacheable `immutable` correctly.
// No purge, no token, ever.
//
// Runs after the brotli step, before verify-sri (rail.css is not in the SRI
// integrity manifest, so rewriting its link is invisible to verify-sri).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
let dir = null;
for (let i = 0; i < argv.length; i++) if (argv[i] === "--in") dir = argv[i + 1];
if (!dir) { console.error("[fingerprint-css] --in <clientDir> required"); process.exit(1); }

const cssPath = path.join(dir, "rail.css");
const htmlPath = path.join(dir, "index.html");
if (!fs.existsSync(cssPath)) { console.log(`[fingerprint-css] no rail.css in ${dir} — skipping`); process.exit(0); }
if (!fs.existsSync(htmlPath)) { console.log(`[fingerprint-css] no index.html in ${dir} — skipping`); process.exit(0); }

const buf = fs.readFileSync(cssPath);
const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);
const newName = `rail.${hash}.css`;

// Rename rail.css -> rail.<hash>.css and (re)build its brotli twin.
fs.renameSync(cssPath, path.join(dir, newName));
fs.writeFileSync(path.join(dir, newName + ".br"),
  zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
const staleBr = path.join(dir, "rail.css.br");
if (fs.existsSync(staleBr)) fs.unlinkSync(staleBr);

// Prune stale fingerprinted rail.<oldhash>.css(.br) from previous builds — the
// SDK doesn't clean the output dir, so old hashes accumulate every time rail.css
// changes. Only the current hash is referenced by index.html; the rest are dead
// weight (and pile up on the NAS via the deploy mirror).
const keep = new Set([newName, newName + ".br"]);
let pruned = 0;
for (const f of fs.readdirSync(dir)) {
  if (/^rail\.[0-9a-f]{10}\.css(\.br)?$/.test(f) && !keep.has(f)) {
    try { fs.unlinkSync(path.join(dir, f)); pruned++; } catch { /* ignore */ }
  }
}
if (pruned) console.log(`[fingerprint-css] pruned ${pruned} stale rail.<hash>.css(.br) file(s)`);

// Rewrite ONLY the stylesheet href (not comment prose mentioning rail.css).
let html = fs.readFileSync(htmlPath, "utf8");
const rewritten = html.replace(/href="rail\.css"/g, `href="${newName}"`);
if (rewritten === html) {
  console.error('[fingerprint-css] FATAL: no <link href="rail.css"> found in index.html — link would 404');
  process.exit(1);
}
fs.writeFileSync(htmlPath, rewritten);

console.log(`[fingerprint-css] rail.css -> ${newName} (+.br); index.html <link> rewritten`);
