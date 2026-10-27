// move-ingredients.js — move N of one ingredient (matched by graphic) from a
// picked SOURCE container to a picked DESTINATION. /macros.html
// ⚠ This moves your items — only run scripts you trust.

const N = 50;   // how many to move in total

print('Pick the SOURCE container…');
const src = await pick();
print('Pick the DESTINATION…');
const dest = await pick();
print('Pick a SAMPLE of the ingredient to move…');
const sample = await pick();

if (src && dest && sample) {
  const list = await items(src.serial);
  let moved = 0;
  for (const it of list) {
    if (moved >= N) break;
    if (it.graphic !== sample.graphic) continue;
    const take = Math.min(it.amount || 1, N - moved);
    await moveItem(it.serial, dest.serial, take);
    moved += take;
    await sleep(700);   // shards rate-limit item moves
  }
  msg('Moved ' + moved + ' / ' + N + ' ingredients.');
} else {
  print('cancelled');
}
