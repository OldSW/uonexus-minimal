// restock-reagents.js — top your backpack up to KEEP of each reagent from a
// picked stash container. /macros.html
// ⚠ This moves items into your pack — only run scripts you trust.

const REGS = [0x0F7A, 0x0F7B, 0x0F84, 0x0F85, 0x0F86, 0x0F88, 0x0F8C, 0x0F8D]; // classic reagents
const KEEP = 50;

const bp = await backpack();
print('Pick your reagent stash container…');
const stash = await pick();

if (stash) {
  const have = {};
  for (const it of await items(bp)) {
    if (REGS.includes(it.graphic)) have[it.graphic] = (have[it.graphic] || 0) + (it.amount || 1);
  }
  for (const it of await items(stash.serial)) {
    if (!REGS.includes(it.graphic)) continue;
    const need = KEEP - (have[it.graphic] || 0);
    if (need > 0) {
      await moveItem(it.serial, bp, Math.min(need, it.amount || 1));
      have[it.graphic] = (have[it.graphic] || 0) + Math.min(need, it.amount || 1);
      await sleep(700);
    }
  }
  msg('Reagents restocked toward ' + KEEP + ' each.');
} else {
  print('cancelled');
}
