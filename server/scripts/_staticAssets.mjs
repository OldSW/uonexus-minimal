// The game-host assets every client bundle carries: the game fonts and background, LegionScript
// (legion-*.js), the MIDI synth and its SoundFont plus two small workers (lib/), the macros the rail
// imports (macros/) and Python (pyodide/).
//
// ONE list, imported by both consumers:
//   - build-web.mjs copies exactly these from shared-www into each bundle;
//   - publish-minimal.mjs ships exactly these out of shared-www, so a published tree can build the
//     bundle its own compose file serves.
//
// 🚨 A SECOND COPY OF THIS LIST IS HOW THE PUBLISHED TREE LOST THEM. The publisher excludes
// shared-www wholesale -- correctly, it is the full product's web layer -- and nothing told it that
// the build it ships reads eight things from in there. A from-source build of the minimal therefore
// came out without its font, its background, Legion or Python, and build-web skipped each missing
// file in silence and reported success. Reported on rootmancer/uonexus-minimal (issue #2) as "my
// output differed from the release in size and runtime files" -- these are the difference.
export const STATIC_FILES = ['uo-background.jpg', 'uofont.ttf', 'Fondamento-Regular.ttf',
  'legion-engine.js', 'legion-worker.js'];
export const STATIC_DIRS = ['lib', 'macros', 'pyodide'];
