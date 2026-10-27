// player-dashboard.js — print a live HP/mana/position readout each second.
// A read-only example: no game actions, just player.refresh(). /macros.html

while (true) {
  const p = await player.refresh();
  if (!p.ingame) { print('Not in-world — stopping.'); break; }
  const hp = p.hitsmax ? Math.round(100 * p.hits / p.hitsmax) : 0;
  const mp = p.manamax ? Math.round(100 * p.mana / p.manamax) : 0;
  print(p.name + '  HP ' + p.hits + '/' + p.hitsmax + ' (' + hp + '%)'
        + '  Mana ' + p.mana + '/' + p.manamax + ' (' + mp + '%)'
        + '  @ ' + p.x + ',' + p.y + ',' + p.z);
  await sleep(1000);
}
