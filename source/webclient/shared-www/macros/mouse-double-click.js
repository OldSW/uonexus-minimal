// mouse-double-click.js — the "natural human" way to act, with no hex serials.
// Move the cursor to a spot on the game canvas, pause so the game registers
// what's under it, confirm the hover, then double-click ("use" it). Requires the
// shard admin to enable mouseMove / mouseDoubleClick (+ objectAtCursor).
//
// Coordinates are game-canvas pixels measured from the top-left. At 100% zoom
// one canvas pixel = one screen pixel. The example below aims at the centre of a
// 1280×720 canvas — change X/Y to wherever your target sits on screen.

const X = 640;
const Y = 360;

// 1) Glide the cursor there.
await mouseMove(X, Y);

// 2) Let a few frames render so the game knows what you're hovering. THIS PAUSE
//    is what makes mouse macros reliable — without it the click lands on the old
//    spot. 120–200 ms is plenty.
await sleep(150);

// 3) Confirm before you click (optional but smart).
const o = await objectAtCursor();
if (o.kind === 'none') {
  print('Nothing under the cursor at (' + X + ',' + Y + ') — adjust X/Y.');
} else {
  print('Hovering: ' + (o.name || o.kind) + '  (serial 0x' + (o.serial >>> 0).toString(16).toUpperCase() + ')');
  // 4) Act like a person: double-click to use it (open a container, mount,
  //    use a tool). Pass true for a right-click; mouseClick() for a single click.
  await mouseDoubleClick();
  msg('Double-clicked ' + (o.name || o.kind) + '.');
}
