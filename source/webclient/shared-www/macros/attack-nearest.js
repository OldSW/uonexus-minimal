// attack-nearest.js — find and attack the closest monster, no hex ids needed.
// scan() returns nearby entities with their serials straight from the world,
// so you never look up a graphic. Requires the shard admin to enable scanWorld
// (+ target/useItem). Stop the script to end the loop.

const RANGE = 12;          // how far to look (tiles)
const RETARGET_MS = 1500;  // how often to re-pick the nearest foe

while (true) {
  const near = await scan(RANGE, 1);                 // 1 = mobiles only
  // Skip the dead, corpses, and humans (other players). Tweak to taste:
  // notoriety 3 = grey, 4 = criminal, 5 = enemy, 6 = murderer.
  const foes = near.filter(m => !m.dead && !m.isHuman);
  foes.sort((a, b) => a.dist - b.dist);              // nearest first

  if (foes.length) {
    const t = foes[0];
    msg('⚔ ' + (t.name || 'creature') + '  ' + t.dist + ' tiles  ' + t.hp + '% hp');
    await target.entity(t.serial);                   // sets your attack target
    // To double-click (e.g. to mount/loot) instead: await player.use(t.serial);
  } else {
    print('Nothing to fight within ' + RANGE + ' tiles.');
  }
  await sleep(RETARGET_MS);
}
