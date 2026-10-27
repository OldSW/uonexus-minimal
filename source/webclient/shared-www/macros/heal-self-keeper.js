// heal-self-keeper.js — cast Greater Heal + target self when HP drops.
// Open in the rail Scripting panel, press Run, stop with the Stop button.
// Uses only the UO Nexus rail JS API (see /macros.html).

const HEAL_BELOW = 0.80;   // heal when HP is under 80%
const CAST_MS    = 900;    // wait for the cast's target cursor
const RECOVER_MS = 3500;   // cast + recovery before checking again

while (true) {
  const p = await player.refresh();
  if (!p.ingame) { print('Not in-world — stopping.'); break; }
  const pct = p.hitsmax ? (p.hits / p.hitsmax) : 1;
  if (pct < HEAL_BELOW) {
    msg('Healing — HP ' + p.hits + '/' + p.hitsmax);
    p.castSpell(Spells.GreaterHeal);
    await sleep(CAST_MS);
    await target.self();
    await sleep(RECOVER_MS);
  } else {
    await sleep(1000);
  }
}
