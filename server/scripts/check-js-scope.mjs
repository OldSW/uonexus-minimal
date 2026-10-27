// Catch identifiers that are REFERENCED but not declared in scope.
//
// Why this exists: `node --check` validates SYNTAX, not scope, and that gap has now bitten
// three times in one session. Deleting a block of dead handlers from mini-runtime.js left 13
// names referenced with nothing declaring them -- and node --check reported the file as
// perfectly fine. The same shape appears in Python (`py_compile` happily accepted a dispatch
// table pointing at deleted functions). A checker that cannot see the failure is not a check.
//
// This runs tsc in --checkJs mode purely to harvest "Cannot find name", which is exactly that
// class of error, and fails when a name appears that is not in the known list below. Everything
// else tsc complains about in loosely-typed browser JS (TS2339 property access on inferred types,
// etc.) is noise here and is ignored on purpose.
//
// 🚨 IT IS TWO ERROR CODES, NOT ONE, AND MATCHING ONLY TS2304 LET A REAL BUG THROUGH (2026-08-28).
// tsc downgrades TS2304 to TS2552 "Cannot find name 'x'. Did you mean 'y'?" whenever it can suggest
// a similar identifier. So an undefined name that HAPPENS TO RESEMBLE another name in the same file
// was reported under a code this gate ignored, and the build printed "OK - all known" over it. The
// Agents port shipped calling checkB() and rangeB(), neither defined here; the Loot tab rendered
// "ReferenceError: checkB is not defined" in production and nothing upstream said a word. The
// resemblance that triggers the downgrade is arbitrary, so this gate was passing or failing on a
// coin flip - which is worse than not having it.
//
// 🚨 The known list is NOT an approval list. Every entry is a SUSPECTED LATENT BUG that was
// already shipped, recorded so the gate can fail on anything NEW. See the note on
// _marchResume: it is declared inside one IIFE and cleared from a different one, so that
// path throws ReferenceError the moment it runs. It survives only because the code that
// reaches it belongs to the retired minigame and no longer receives its journal messages.
// Fix them and shrink this list; do not grow it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TSC = path.join(REPO, 'server', 'node_modules', 'typescript', 'bin', 'tsc');

// file (basename) -> names known to be unresolved today.
const KNOWN = {
  // Emscripten / JS-shell globals probed with `typeof` inside the dotnet loader's
  // environment detection. They are absent in a browser BY DESIGN -- the code tests for
  // them precisely to find out which host it is running in -- so they are not defects.
  'main.js': ['importScripts', 'aaa', 'read', 'readbuffer', 'scriptArgs', 'quit', 'printErr'],
  // Worker globals: importScripts is the Web Worker API, loadPyodide is defined by the
  // pyodide.js this worker importScripts() at runtime.
  'legion-worker.js': ['importScripts', 'loadPyodide'],
  // window.CardUI is set as a side effect by cards-ui.js, which every page carrying this
  // inline block loads as its own <script> beforehand.
  'inline-cards.html.js': ['CardUI'],
  'inline-profile.html.js': ['CardUI'],
  'mini-runtime.js': [
    '_marchResume',      // declared in the walk IIFE, cleared from the camp IIFE -> throws if reached
    '_marchHoldUntil',   // same pair
    'walking', 'start',  // walk-module locals reached from a sibling scope
    'canvas',
  ],
};

const TARGETS = process.argv.slice(2);
if (!TARGETS.length) {
  console.error('[check-js-scope] usage: check-js-scope.mjs <file.js> [more.js ...]');
  process.exit(1);
}
if (!fs.existsSync(TSC)) {
  // Best-effort: a checkout without server/node_modules should not block a build.
  console.log('[check-js-scope] typescript not installed under server/ — skipped');
  process.exit(0);
}

// 🚨 A FILE THAT DOES NOT PARSE MUST NOT GET A GREEN LINE. This gate harvests "Cannot find name", and a
// SYNTAX error produces different codes entirely - so when a stray backtick closed the CSS template literal in
// mini-runtime.js the checker read nothing, found no unresolved names, and printed "OK - 0 unresolved name(s),
// all known" over a file the browser cannot even load. The broken bundle reached dev and the HUD was simply
// dead; a probe reported it as "the run never started" and the cause was hunted on the shard (2026-09-20).
// esbuild parses both modules and classic scripts, and it is already installed for the proxy's build.
const require_ = createRequire(import.meta.url);
let esbuild = null;
try { esbuild = require_(path.join(REPO, 'server', 'node_modules', 'esbuild')); } catch { esbuild = null; }
if (!esbuild) console.log('[check-js-scope] esbuild not installed under server/ — parse check skipped');

function parses(file) {
  if (!esbuild) return true;
  try {
    esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'js', format: undefined });
    return true;
  } catch (e) {
    console.error(`[check-js-scope] ${path.basename(file)}: DOES NOT PARSE — the scope check cannot say`);
    console.error('  anything about a file the browser cannot load either:');
    for (const err of (e.errors || []).slice(0, 5)) {
      const loc = err.location ? `line ${err.location.line}: ` : '';
      console.error(`    ${loc}${err.text}`);
    }
    if (!(e.errors || []).length) console.error(`    ${e.message}`);
    return false;
  }
}

let failed = false;
for (const target of TARGETS) {
  if (!fs.existsSync(target)) { console.log(`[check-js-scope] ${target}: not found — skipped`); continue; }
  if (!parses(target)) { failed = true; continue; }
  let out = '';
  try {
    out = execFileSync(process.execPath,
      [TSC, '--allowJs', '--checkJs', '--noEmit', '--target', 'es2022',
       '--lib', 'es2022,dom', '--skipLibCheck', target],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // tsc exits non-zero whenever it reports anything; the diagnostics are what we want.
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const base = path.basename(target);
  const known = new Set(KNOWN[base] || []);
  const found = new Map();   // name -> first line reported
  for (const line of out.split(/\r?\n/)) {
    const m = /\((\d+),\d+\): error TS(?:2304|2552): Cannot find name '([^']+)'/.exec(line);
    if (m) if (!found.has(m[2])) found.set(m[2], m[1]);
  }
  const fresh = [...found].filter(([n]) => !known.has(n));
  if (!fresh.length) {
    console.log(`[check-js-scope] ${base}: OK — ${found.size} unresolved name(s), all known`);
    continue;
  }
  failed = true;
  console.error(`[check-js-scope] ${base}: ${fresh.length} name(s) referenced with nothing declaring them:`);
  for (const [n, ln] of fresh) console.error(`    line ${ln}: ${n}`);
  console.error('  These throw ReferenceError when the path runs. node --check cannot see them.');
  console.error('  If a name is genuinely provided by another script at runtime, add it to KNOWN');
  console.error('  in server/scripts/check-js-scope.mjs — with a comment saying who provides it.');
}
process.exit(failed ? 1 : 0);
