// skill-on-target.js — pick a training target once, then use a skill on it
// on a loop. Swap Skills.Anatomy for the skill you're raising. /macros.html

print('Pick your training target…');
const dummy = await pick();
if (!dummy) { print('cancelled'); }
else {
  msg('Training on ' + (dummy.name || 'target') + ' …');
  for (let i = 0; i < 200; i++) {
    if (!(await player.refresh()).ingame) break;
    player.useSkill(Skills.Anatomy);
    await target.entity(dummy.serial);   // aim the skill at the picked target
    await sleep(4000);                   // tune to your shard's skill timer
  }
  msg('Training session done.');
}
