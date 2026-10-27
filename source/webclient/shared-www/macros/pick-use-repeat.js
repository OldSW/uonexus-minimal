// pick-use-repeat.js — pick two objects, then repeat a routine 100 times:
//   say a word -> double-click A -> double-click B -> use a skill -> wait 5s
// …then do something different. Stop early with the Stop button. /macros.html

print('Pick the FIRST object to double-click…');
const a = await pick();
if (!a) { print('cancelled'); }
else {
  print('Pick the SECOND object…');
  const b = await pick();
  if (!b) { print('cancelled'); }
  else {
    for (let i = 1; i <= 100; i++) {
      player.say('Working… ' + i + '/100');
      player.use(a.serial);            // double-click object A
      await sleep(600);
      player.use(b.serial);            // double-click object B
      await sleep(600);
      player.useSkill(Skills.Anatomy); // change to your skill
      await sleep(5000);               // wait 5 seconds
    }
    msg('All 100 reps complete!');
    player.say('Finished — taking a break.');
    player.castSpell(Spells.NightSight);
    await sleep(900);
    await target.self();
  }
}
