// loot-corpse.js — grab every item from a picked corpse (or container) into
// your backpack. /macros.html
// ⚠ This moves items into your pack — only run scripts you trust.

const bp = await backpack();
print('Pick the corpse (or container) to loot…');
const corpse = await pick();

if (corpse) {
  const loot = await items(corpse.serial);
  print('Found ' + loot.length + ' items.');
  for (const it of loot) {
    await grabItem(it.serial, it.amount || 1, bp);
    await sleep(700);
  }
  msg('Looting done — ' + loot.length + ' stacks.');
} else {
  print('cancelled');
}
