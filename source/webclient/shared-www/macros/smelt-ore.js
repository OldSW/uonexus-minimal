// smelt-ore.js — pick a forge and an ore pile once, then double-click the ore
// and target the forge on a loop. Stop with the Stop button. /macros.html

print('Pick the FORGE…');
const forge = await pick();
print('Pick the ORE…');
const ore = await pick();

if (forge && ore) {
  msg('Smelting ' + (ore.name || 'ore') + ' at the forge…');
  while (true) {
    if (!(await player.refresh()).ingame) break;
    player.use(ore.serial);              // double-click ore -> "target a forge"
    await sleep(700);
    await target.entity(forge.serial);   // target the forge
    await sleep(1500);
  }
} else {
  print('cancelled');
}
