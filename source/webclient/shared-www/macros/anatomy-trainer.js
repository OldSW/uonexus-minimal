// anatomy-trainer.js — the classic skill-bark + use-skill + target-self loop.
// The official ClassicUO Web example. Stop with the Stop button. /macros.html

while (true) {
  player.say('I love Anatomy!');
  player.useSkill(Skills.Anatomy);
  await target.waitTargetEntity(player);
  await sleep(5000);
}
