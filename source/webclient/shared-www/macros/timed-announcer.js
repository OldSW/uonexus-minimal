// timed-announcer.js — say a rotating line on an interval (e.g. vendor barks).
// Keep it within your shard's spam rules. /macros.html

const LINES = [
  'WTS full suit — pm me!',
  'WTB ingots, fair price',
  'Guild recruiting — message me'
];
const EVERY_MS = 45_000;

let i = 0;
while (true) {
  if (!(await player.refresh()).ingame) { print('Not in-world — stopping.'); break; }
  player.say(LINES[i % LINES.length]);
  i++;
  await sleep(EVERY_MS);
}
