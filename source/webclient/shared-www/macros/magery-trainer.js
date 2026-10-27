// magery-trainer.js — train Magery with mana management.
// Casts a cheap spell when mana allows; meditates to regen otherwise.
// Adjust MIN_MANA and timings to your shard. /macros.html

const MIN_MANA = 10;

while (true) {
  const p = await player.refresh();
  if (!p.ingame) { print('Not in-world — stopping.'); break; }
  if (p.mana >= MIN_MANA) {
    p.castSpell(Spells.MagicArrow);
    await sleep(1200);
    await target.self();        // harmless self-cast for skill gain on many shards
    await sleep(1500);
  } else {
    print('Low mana (' + p.mana + ') — meditating…');
    p.useSkill(Skills.Meditation);
    await sleep(8000);
  }
}
