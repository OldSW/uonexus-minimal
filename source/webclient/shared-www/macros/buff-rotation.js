// buff-rotation.js — keep self-buffs (Bless + Protection) refreshed on a timer.
// Tune REAPPLY_MS and the sleeps to your shard's cast speed. /macros.html

const REAPPLY_MS = 60_000;   // refresh each buff about once a minute

async function selfCast(spell) {
  player.castSpell(spell);
  await sleep(900);          // let the target cursor appear
  await target.self();
  await sleep(2500);         // cast + recovery
}

while (true) {
  if (!(await player.refresh()).ingame) { print('Not in-world — stopping.'); break; }
  await selfCast(Spells.Bless);
  await selfCast(Spells.Protection);
  print('buffs refreshed @ ' + new Date().toLocaleTimeString());
  await sleep(REAPPLY_MS);
}
