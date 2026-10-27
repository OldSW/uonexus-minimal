/* LegionScript engine — main-thread host (TUO only).
 *
 * Lazy-loaded the first time the user clicks Run on an LS (LegionScript) script.
 * Spawns legion-worker.js (Pyodide/CPython), owns the SharedArrayBuffer channels,
 * exposes window.UORailLegion = { run, stop, isReady }, and services the worker's
 * synchronous API calls by dispatching them to the SAME camelCase game bridge the
 * JS macro sandbox uses (window.UORailBridge) — so JS and LS reach identical
 * capabilities. Each dispatched action is gated by the SAME per-shard script
 * policy as JS (getEffectiveVerbs → /api/script-policy/<slug>); a blocked verb
 * prints "disabled by this shard's script policy", exactly like JS.
 *
 * window.UORailBridge methods are ASYNC (Mercury MT round-trip), so the worker
 * stays parked on Atomics.wait until the bridge promise resolves and we writeResult.
 */
(function () {
  'use strict';
  if (window.UORailLegion) return;

  // Self-locating: derive the client base ('/cuo/', '/tuo/', '/mini/', …) from
  // THIS script's own URL so each client is fully independent — legion-worker.js
  // and pyodide/ load from the SAME bundle that loaded us, zero cross-client
  // coupling (if TUO is ever dropped, CUO keeps working standalone).
  // Capture our own URL once → derive the client base AND the ?v= cache-buster
  // (passed by rail.js). The buster is forwarded to legion-worker.js so an engine
  // update is never served stale; pyodide/ stays unversioned (immutable content).
  var SELF = (function () {
    var u = '';
    try {
      u = (document.currentScript && document.currentScript.src) || '';
      if (!u) {
        var ss = document.getElementsByTagName('script');
        for (var i = ss.length - 1; i >= 0; i--) {
          if (ss[i].src && /legion-engine\.js(\?|$)/.test(ss[i].src)) { u = ss[i].src; break; }
        }
      }
    } catch (e) {}
    var qi = u.indexOf('?');
    // Fallback base when the script tag can't be located: derive it from THIS
    // bundle, not a hardcoded '/tuo/' (that fetched the worker/pyodide from the
    // wrong root on cuo '/' and mini '/mini/'). Bundle name first, pathname next.
    var b = (typeof window !== 'undefined' && window.__bundle) || '';
    var fb = (b === 'cuo') ? '/' : (b === 'mini') ? '/mini/' : (b === 'tuo') ? '/tuo/'
           : (location.pathname.indexOf('/tuo') === 0) ? '/tuo/'
           : (location.pathname.indexOf('/mini') === 0) ? '/mini/' : '/';
    return { base: (u.replace(/legion-engine\.js.*$/, '') || fb), q: qi >= 0 ? u.slice(qi) : '' };
  })();
  var BASE = SELF.base;
  var QV = SELF.q;
  var enc = new TextEncoder();
  var worker = null, ctrl = null, dataView = null, stopView = null;
  var ready = false, booting = false, bootCbs = [];
  var onOut = function () {};
  var allowed = null;                       // Set of allowed verb keys (per-shard policy)

  function emit(text, cls) { try { onOut(text, cls || 'out'); } catch (e) {} }

  function writeResult(value) {
    var json = (value === undefined || value === null) ? '' : JSON.stringify(value);
    var bytes = enc.encode(json), len = bytes.length;
    dataView[0] = len & 255; dataView[1] = (len >> 8) & 255;
    dataView[2] = (len >> 16) & 255; dataView[3] = (len >> 24) & 255;
    if (len) dataView.set(bytes, 4);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
  }

  // ── name → index maps (Legion uses names; the bridge takes indices) ──────────
  var SPELLS = {}; (function () {
    // Magery circles 1-8 (index 1..64), the order CUO/TUO uses.
    var s = ['Clumsy','Create Food','Feeblemind','Heal','Magic Arrow','Night Sight','Reactive Armor','Weaken',
      'Agility','Cunning','Cure','Harm','Magic Trap','Magic Untrap','Protection','Strength',
      'Bless','Fireball','Magic Lock','Poison','Telekinesis','Teleport','Unlock','Wall of Stone',
      'Arch Cure','Arch Protection','Curse','Fire Field','Greater Heal','Lightning','Mana Drain','Recall',
      'Blade Spirits','Dispel Field','Incognito','Magic Reflection','Mind Blast','Paralyze','Poison Field','Summon Creature',
      'Dispel','Energy Bolt','Explosion','Invisibility','Mark','Mass Curse','Paralyze Field','Reveal',
      'Chain Lightning','Energy Field','Flamestrike','Gate Travel','Mana Vampire','Mass Dispel','Meteor Swarm','Polymorph',
      'Earthquake','Energy Vortex','Resurrection','Air Elemental','Summon Daemon','Earth Elemental','Fire Elemental','Water Elemental'];
    s.forEach(function (n, i) { SPELLS[n.toLowerCase()] = i + 1; });
  })();
  var SKILLS = {}; (function () {
    var s = ['Alchemy','Anatomy','Animal Lore','Item ID','Arms Lore','Parry','Begging','Blacksmithy','Bowcraft','Peacemaking',
      'Camping','Carpentry','Cartography','Cooking','Detect Hidden','Discordance','Eval Int','Healing','Fishing','Forensic Eval',
      'Herding','Hiding','Provocation','Inscription','Lockpicking','Magery','Resist Spells','Tactics','Snooping','Musicianship',
      'Poisoning','Archery','Spirit Speak','Stealing','Tailoring','Animal Taming','Taste ID','Tinkering','Tracking','Veterinary',
      'Swords','Macing','Fencing','Wrestling','Lumberjacking','Mining','Meditation','Stealth','Remove Trap','Necromancy',
      'Focus','Chivalry','Bushido','Ninjitsu','Spellweaving','Mysticism','Imbuing','Throwing'];
    s.forEach(function (n, i) { SKILLS[n.toLowerCase()] = i; });
  })();
  function toSpellIndex(v) { if (typeof v === 'number') return v | 0; var k = SPELLS[String(v).toLowerCase()]; return k != null ? k : 0; }
  function toSkillIndex(v) { if (typeof v === 'number') return v | 0; var k = SKILLS[String(v).toLowerCase()]; return k != null ? k : -1; }

  // ── LS method → { verb (policy key, null = ungated), call(br,args)→value|Promise, blocked } ──
  // Bridge methods are the camelCase ones on window.UORailBridge (same as JS).
  var OFFLINE_PLAYER = { Name: '(offline)', Hits: 0, HitsMax: 0, Mana: 0, ManaMax: 0, Stam: 0, StamMax: 0, Serial: 0, X: 0, Y: 0, Z: 0 };
  // Shared vars live on the MAIN thread (the engine boots ONCE per page), so they persist
  // across script runs within a session — the SharedVar semantics LegionScript expects.
  // ONE script at a time. Two 'run' messages to the same worker would interleave two
  // Python programs over the SAME game bridge (double-acting verbs), and the second
  // run would also clear the stop flag of the first — so a spammed Run button could
  // resurrect a script the player just stopped. Operator 2026-07-26.
  var running = false;
  var _sharedVars = {};
  var D = {
    // ── messaging (SysMsg/HeadMsg = client-only, ungated; Msg = speak in-world) ──
    SysMessage: { call: function (br, a) { if (br && br.sysmsg) return br.sysmsg(String(a[0]), a[1] | 0); emit('» ' + a[0], 'out'); } },
    SysMsg:     { call: function (br, a) { if (br && br.sysmsg) return br.sysmsg(String(a[0]), a[1] | 0); emit('» ' + a[0], 'out'); } },
    HeadMsg:    { call: function (br, a) { if (br && br.sysmsg) return br.sysmsg(String(a[0]), 946); emit('» ' + a[0], 'out'); } },
    Msg:        { verb: 'say', call: function (br, a) { if (br && br.say) return br.say(String(a[0])); emit('say» ' + a[0], 'out'); } },
    EmoteMsg:   { verb: 'say', call: function (br, a) { if (br && br.say) return br.say(String(a[0])); emit('say» ' + a[0], 'out'); } },
    WhisperMsg: { verb: 'say', call: function (br, a) { if (br && br.say) return br.say(String(a[0])); emit('say» ' + a[0], 'out'); } },
    YellMsg:    { verb: 'say', call: function (br, a) { if (br && br.say) return br.say(String(a[0])); emit('say» ' + a[0], 'out'); } },
    PartyMsg:   { verb: 'chatSend', call: function (br, a) { return br && br.chatSend ? br.chatSend(String(a[0])) : false; }, blocked: false },
    GuildMsg:   { verb: 'chatSend', call: function (br, a) { return br && br.chatSend ? br.chatSend(String(a[0])) : false; }, blocked: false },
    AllyMsg:    { verb: 'chatSend', call: function (br, a) { return br && br.chatSend ? br.chatSend(String(a[0])) : false; }, blocked: false },
    GlobalMsg:  { verb: 'chatSend', call: function (br, a) { return br && br.chatSend ? br.chatSend(String(a[0])) : false; }, blocked: false },
    // ── player / reads (ungated) ──
    GetPlayer:  { call: function (br, a) { return br && br.player ? br.player() : OFFLINE_PLAYER; }, blocked: OFFLINE_PLAYER },
    // ── actions ──
    UseObject:  { verb: 'useItem', call: function (br, a) { if (br && br.useItem) return br.useItem(Number(a[0])); } },
    UseType:    { verb: 'useItem', call: function (br, a) { if (br && br.useItem) return br.useItem(Number(a[0])); } },
    ClickObject:{ verb: 'useItem', call: function (br, a) { if (br && br.useItem) return br.useItem(Number(a[0])); } },
    CastSpell:  { verb: 'castSpell', call: function (br, a) { var i = toSpellIndex(a[0]); if (i < 1) { emit('[ls] unknown spell: ' + a[0], 'muted'); return; } if (br && br.castSpell) return br.castSpell(i); } },
    UseSkill:   { verb: 'useSkill', call: function (br, a) { var i = toSkillIndex(a[0]); if (i >= 0 && br && br.useSkill) return br.useSkill(i); } },
    EquipItem:  { verb: 'equipItem', call: function (br, a) { return br && br.equipItem ? br.equipItem(Number(a[0])) : false; }, blocked: false },
    MoveItem:   { verb: 'moveItem', call: function (br, a) { return br && br.moveItem ? br.moveItem(Number(a[0]), Number(a[1]), a[2] | 0) : false; }, blocked: false },
    QueueMoveItem: { verb: 'moveItem', call: function (br, a) { return br && br.moveItem ? br.moveItem(Number(a[0]), Number(a[1]), a[2] | 0) : false; }, blocked: false },
    GrabItem:   { verb: 'grabItem', call: function (br, a) { return br && br.grabItem ? br.grabItem(Number(a[0]), a[1] | 0, a[2] || 0) : false; }, blocked: false },
    // ── targeting ──
    Target:        { verb: 'target', call: function (br, a) { return br && br.target ? br.target(Number(a[0])) : false; }, blocked: false },
    TargetSelf:    { verb: 'targetSelf', call: function (br, a) { return br && br.targetSelf ? br.targetSelf() : false; }, blocked: false },
    TargetLast:    { verb: 'targetLast', call: function (br, a) { return br && br.targetLast ? br.targetLast() : false; }, blocked: false },
    CancelTarget:  { verb: 'cancelTarget', call: function (br, a) { return br && br.cancelTarget ? br.cancelTarget() : false; }, blocked: false },
    RequestTarget: { verb: 'requestTarget', call: function (br, a) { return br && br.requestTarget ? br.requestTarget() : false; }, blocked: false },
    RequestAnyTarget: { verb: 'requestTarget', call: function (br, a) { return br && br.requestTarget ? br.requestTarget() : false; }, blocked: false },
    HasTarget:     { call: function (br, a) { return br && br.isTargeting ? br.isTargeting() : false; }, blocked: false },
    WaitForTarget: { call: function (br, a) { return br && br.isTargeting ? br.isTargeting() : true; }, blocked: true },
    // ── navigation ──
    Walk:    { verb: 'walkTo', call: function (br, a) { return br && br.walkTo ? br.walkTo(a[0] | 0, a[1] | 0, a[2] | 0) : false; }, blocked: false },
    Run:     { verb: 'walkTo', call: function (br, a) { return br && br.walkTo ? br.walkTo(a[0] | 0, a[1] | 0, a[2] | 0) : false; }, blocked: false },
    StopWalk:{ call: function (br, a) { return br && br.stopWalk ? br.stopWalk() : false; }, blocked: false },
    // ── perception (reads) ──
    Contents:         { verb: 'getContainerItems', call: function (br, a) { return br && br.getContainerItems ? br.getContainerItems(Number(a[0])) : []; }, blocked: [] },
    ItemsInContainer: { verb: 'getContainerItems', call: function (br, a) { return br && br.getContainerItems ? br.getContainerItems(Number(a[0])) : []; }, blocked: [] },
    GetGumpContents:  { verb: 'getContainerItems', call: function (br, a) { return br && br.getContainerItems ? br.getContainerItems(Number(a[0])) : []; }, blocked: [] },
    GetEquipped:      { verb: 'getEquippedItems', call: function (br, a) { return br && br.getEquippedItems ? br.getEquippedItems() : []; }, blocked: [] },
    Durability:       { verb: 'getEquipmentDurability', call: function (br, a) { return br && br.getEquipmentDurability ? br.getEquipmentDurability() : []; }, blocked: [] },
    GetAllFriends:    { verb: 'getFriends', call: function (br, a) { return br && br.getFriends ? br.getFriends() : []; }, blocked: [] },
    GetJournal:       { verb: 'getJournal', call: function (br, a) { return br && br.getJournal ? br.getJournal(a[0] | 0) : []; }, blocked: [] },
    ScanWorld:        { verb: 'scanWorld', call: function (br, a) { return br && br.scanWorld ? br.scanWorld(a[0] | 0, a[1] | 0) : []; }, blocked: [] },
    GetItemArt:       { verb: 'getItemArt', call: function (br, a) { return br && br.getItemArt ? br.getItemArt(a[0] | 0) : null; }, blocked: null },
    ObjectAtCursor:   { verb: 'objectAtCursor', call: function (br, a) { return br && br.objectAtCursor ? br.objectAtCursor() : { kind: 'none' }; }, blocked: { kind: 'none' } },
    GetBackpack:      { verb: 'getBackpackSerial', call: function (br, a) { return br && br.getBackpackSerial ? br.getBackpackSerial() : 0; }, blocked: 0 },
    // ── gumps ──
    GetGumps:  { verb: 'getGumps', call: function (br, a) { return br && br.getGumps ? br.getGumps() : []; }, blocked: [] },
    ReplyGump: { verb: 'gumpReply', call: function (br, a) { return br && br.gumpReply ? br.gumpReply(Number(a[0]), a[1] | 0) : false; }, blocked: false },
    // ── combat / skills (bridge growth 2026-07-23) ──
    // Attack + GetSkill were in the LegionScript API surface (_KNOWN in
    // legion-worker.js) but not dispatched here: Attack fell through to a stale
    // worker shim that aliased it to UseObject (double-click, wrong), and GetSkill
    // hit the "bridge growth pending" path. Now wired to real bridge verbs.
    // (FindType/Pathfind already work via their own worker shims over ScanWorld/Walk.)
    // Attack a mobile by serial. Gated verb 'attack' (SCRIPT_VERBS); the [JSExport]
    // is TUO-only today, so on cuo the missing export makes the bridge no-op.
    Attack:      { verb: 'attack', call: function (br, a) { return br && br.attack ? br.attack(Number(a[0])) : false; }, blocked: false },
    // GetSkill(name|index) — pure client-side read (no packet), UNGATED like GetPlayer.
    // Returns the skill record {index,name,value,base,cap,lock} (null if unknown).
    GetSkill:    { call: function (br, a) { return skillEntry(br, a[0]); }, blocked: null },
    // Turn(direction) — face a direction without moving. Accepts a name ("North"…) or a
    // 0-7 number. Gated verb 'turn' (it emits a turn request). TUO-only export today.
    Turn:        { verb: 'turn', call: function (br, a) { return br && br.turn ? br.turn(dirToNum(a[0])) : false; }, blocked: false },
    // ── script state: persistent (per-browser, localStorage) + shared (per-session) vars ──
    GetPersistentVar:    { call: function (br, a) { return br && br.getPersistentVar ? br.getPersistentVar(String(a[0]), a[1]) : (a[1] !== undefined ? a[1] : null); }, blocked: null },
    SavePersistentVar:   { call: function (br, a) { return br && br.savePersistentVar ? br.savePersistentVar(String(a[0]), a[1]) : false; }, blocked: false },
    RemovePersistentVar: { call: function (br, a) { return br && br.removePersistentVar ? br.removePersistentVar(String(a[0])) : false; }, blocked: false },
    GetSharedVar:    { call: function (br, a) { var k = String(a[0]); return (k in _sharedVars) ? _sharedVars[k] : (a[1] !== undefined ? a[1] : null); }, blocked: null },
    SetSharedVar:    { call: function (br, a) { _sharedVars[String(a[0])] = (a[1] !== undefined ? a[1] : null); return true; }, blocked: false },
    RemoveSharedVar: { call: function (br, a) { delete _sharedVars[String(a[0])]; return true; }, blocked: false },
    ClearSharedVars: { call: function (br, a) { for (var _k in _sharedVars) { delete _sharedVars[_k]; } return true; }, blocked: false },
    // ── mouse ──
    MouseMove:        { verb: 'mouseMove', call: function (br, a) { if (br && br.mouseMove) return br.mouseMove(a[0] | 0, a[1] | 0); } },
    MouseClick:       { verb: 'mouseClick', call: function (br, a) { if (br && br.mouseClick) return br.mouseClick(!!a[0]); } },
    MouseDoubleClick: { verb: 'mouseDoubleClick', call: function (br, a) { if (br && br.mouseDoubleClick) return br.mouseDoubleClick(!!a[0]); } },
    // ── LegionScript API completion (2026-07-24) ──
    AddFriend:    { verb: 'manageFriends', call: function (br, a) { return br && br.addFriend ? br.addFriend(a[0]) : false; }, blocked: false },
    RemoveFriend: { verb: 'manageFriends', call: function (br, a) { return br && br.removeFriend ? br.removeFriend(a[0]) : false; }, blocked: false },
    SetWarMode: { verb: 'setWarMode', call: function (br, a) { return br && br.setWarMode ? br.setWarMode(a[0]) : false; }, blocked: false },
    BandageSelf: { verb: 'bandageSelf', call: function (br, a) { return br && br.bandageSelf ? br.bandageSelf() : false; }, blocked: false },
    ToggleAbility: { verb: 'toggleAbility', call: function (br, a) { return br && br.toggleAbility ? br.toggleAbility(a[0]) : false; }, blocked: false },
    Virtue: { verb: 'virtue', call: function (br, a) { return br && br.virtue ? br.virtue(a[0]) : false; }, blocked: false },
    SetSkillLock: { verb: 'setSkillLock', call: function (br, a) { return br && br.setSkillLock ? br.setSkillLock(a[0], a[1]) : false; }, blocked: false },
    SetStatLock: { verb: 'setStatLock', call: function (br, a) { return br && br.setStatLock ? br.setStatLock(a[0], a[1]) : false; }, blocked: false },
    DisplayRange: { verb: 'displayRange', call: function (br, a) { return br && br.displayRange ? br.displayRange(a[0], a[1]) : false; }, blocked: false },
    TrackingArrow: { verb: 'trackingArrow', call: function (br, a) { return br && br.trackingArrow ? br.trackingArrow(a[0], a[1], a[2]) : false; }, blocked: false },
    PrimaryAbilityActive: { call: function (br, a) { return br && br.primaryAbilityActive ? br.primaryAbilityActive() : false; }, blocked: false },
    SecondaryAbilityActive: { call: function (br, a) { return br && br.secondaryAbilityActive ? br.secondaryAbilityActive() : false; }, blocked: false },
    CurrentAbilityNames: { call: function (br, a) { return br && br.currentAbilityNames ? br.currentAbilityNames() : []; }, blocked: [] },
    KnownAbilityNames: { call: function (br, a) { return br && br.knownAbilityNames ? br.knownAbilityNames() : []; }, blocked: [] },
    IsGlobalCooldownActive: { call: function (br, a) { return br && br.isGlobalCooldownActive ? br.isGlobalCooldownActive() : false; }, blocked: false },
    ActiveBuffs: { call: function (br, a) { return br && br.activeBuffs ? br.activeBuffs() : []; }, blocked: [] },
    BuffExists: { call: function (br, a) { return br && br.buffExists ? br.buffExists(a[0]) : false; }, blocked: false },
    Mount: { verb: 'mount', call: function (br, a) { return br && br.mount ? br.mount(a[0]) : false; }, blocked: false },
    Dismount: { verb: 'mount', call: function (br, a) { return br && br.dismount ? br.dismount() : false; }, blocked: false },
    SetMount: { verb: 'mount', call: function (br, a) { return br && br.setMount ? br.setMount(a[0]) : false; }, blocked: false },
    ToggleFly: { verb: 'fly', call: function (br, a) { return br && br.toggleFly ? br.toggleFly() : false; }, blocked: false },
    Logout: { verb: 'logout', call: function (br, a) { return br && br.logout ? br.logout() : false; }, blocked: false },
    Rename: { verb: 'rename', call: function (br, a) { return br && br.rename ? br.rename(a[0], a[1]) : false; }, blocked: false },
    ClearLeftHand: { verb: 'moveItem', call: function (br, a) { return br && br.clearLeftHand ? br.clearLeftHand() : null; }, blocked: null },
    ClearRightHand: { verb: 'moveItem', call: function (br, a) { return br && br.clearRightHand ? br.clearRightHand() : null; }, blocked: null },
    PickUpToCursor: { verb: 'moveItem', call: function (br, a) { return br && br.pickUpToCursor ? br.pickUpToCursor(a[0], a[1]) : false; }, blocked: false },
    DropFromCursor: { verb: 'moveItem', call: function (br, a) { return br && br.dropFromCursor ? br.dropFromCursor(a[0], a[1], a[2], a[3], a[4]) : false; }, blocked: false },
    MoveItemOffset: { verb: 'moveItem', call: function (br, a) { return br && br.moveItemOffset ? br.moveItemOffset(a[0], a[1], a[2], a[3], a[4], a[5]) : false; }, blocked: false },
    ClearMoveQueue: { verb: 'moveItem', call: function (br, a) { return br && br.clearMoveQueue ? br.clearMoveQueue() : false; }, blocked: false },
    IsProcessingMoveQueue: { call: function (br, a) { return br && br.isProcessingMoveQueue ? br.isProcessingMoveQueue() : false; }, blocked: false },
    IsProcessingUseItemQueue: { call: function (br, a) { return br && br.isProcessingUseItemQueue ? br.isProcessingUseItemQueue() : false; }, blocked: false },
    GetHeldItem: { call: function (br, a) { return br && br.getHeldItem ? br.getHeldItem() : -1; }, blocked: -1 },
    RequestOPLData: { call: function (br, a) { return br && br.requestOPLData ? br.requestOPLData(a[0]) : false; }, blocked: false },
    ItemNameAndProps: { call: function (br, a) { return br && br.itemNameAndProps ? br.itemNameAndProps(a[0]) : ''; }, blocked: '' },
    CloseGump: { verb: 'closeGump', call: function (br, a) { return br && br.closeGump ? br.closeGump(a[0]) : false; }, blocked: false },
    GumpContains: { call: function (br, a) { return br && br.gumpContains ? br.gumpContains(a[0], a[1]) : false; }, blocked: false },
    ContextMenu: { verb: 'contextMenu', call: function (br, a) { return br && br.contextMenu ? br.contextMenu(a[0], a[1]) : false; }, blocked: false },
    CloseContextMenus: { verb: 'contextMenu', call: function (br, a) { return br && br.closeContextMenus ? br.closeContextMenus() : false; }, blocked: false },
    GetMap: { call: function (br, a) { return br && br.getMap ? br.getMap() : -1; }, blocked: -1 },
    GetTile: { call: function (br, a) { return br && br.getTile ? br.getTile(a[0], a[1]) : null; }, blocked: null },
    GetStaticsAt: { call: function (br, a) { return br && br.getStaticsAt ? br.getStaticsAt(a[0], a[1]) : []; }, blocked: [] },
    GetStaticsInArea: { call: function (br, a) { return br && br.getStaticsInArea ? br.getStaticsInArea(a[0], a[1], a[2], a[3]) : []; }, blocked: [] },
    GetPartyLeader: { call: function (br, a) { return br && br.getPartyLeader ? br.getPartyLeader() : -1; }, blocked: -1 },
    GetPartyMemberSerials: { call: function (br, a) { return br && br.getPartyMemberSerials ? br.getPartyMemberSerials() : []; }, blocked: [] },
    GetPath: { call: function (br, a) { return br && br.getPath ? br.getPath(a[0], a[1], a[2], a[3]) : []; }, blocked: [] },
    Pathfinding: { call: function (br, a) { return br && br.pathfinding ? br.pathfinding() : false; }, blocked: false },
    CancelPathfinding: { verb: 'pathfind', call: function (br, a) { return br && br.cancelPathfinding ? br.cancelPathfinding() : false; }, blocked: false },
    MarkTile: { verb: 'markTile', call: function (br, a) { return br && br.markTile ? br.markTile(a[0], a[1], a[2], a[3]) : false; }, blocked: false },
    RemoveMarkedTile: { verb: 'markTile', call: function (br, a) { return br && br.removeMarkedTile ? br.removeMarkedTile(a[0], a[1], a[2]) : false; }, blocked: false },
    Dress: { verb: 'dress', call: function (br, a) { return br && br.dress ? br.dress(a[0]) : false; }, blocked: false },
    Undress: { verb: 'dress', call: function (br, a) { return br && br.undress ? br.undress(a[0]) : false; }, blocked: false },
    UndressAll: { verb: 'dress', call: function (br, a) { return br && br.undressAll ? br.undressAll(a[0]) : false; }, blocked: false },
    GetAvailableDressOutfits: { call: function (br, a) { return br && br.getAvailableDressOutfits ? br.getAvailableDressOutfits() : []; }, blocked: [] },
    ToggleAutoLoot: { verb: 'autoLoot', call: function (br, a) { return br && br.toggleAutoLoot ? br.toggleAutoLoot() : false; }, blocked: false },
    AutoLootContainer: { verb: 'autoLoot', call: function (br, a) { return br && br.autoLootContainer ? br.autoLootContainer(a[0]) : false; }, blocked: false },
    AutoFollow: { verb: 'autoFollow', call: function (br, a) { return br && br.autoFollow ? br.autoFollow(a[0]) : false; }, blocked: false },
    CancelAutoFollow: { verb: 'autoFollow', call: function (br, a) { return br && br.cancelAutoFollow ? br.cancelAutoFollow() : false; }, blocked: false },
    TargetLandRel: { verb: 'target', call: function (br, a) { return br && br.targetLandRel ? br.targetLandRel(a[0], a[1]) : false; }, blocked: false },
    TargetTileRel: { verb: 'target', call: function (br, a) { return br && br.targetTileRel ? br.targetTileRel(a[0], a[1], a[2]) : false; }, blocked: false },
    TargetResource: { verb: 'target', call: function (br, a) { return br && br.targetResource ? br.targetResource(a[0], a[1]) : false; }, blocked: false },
    FindLayer: { call: function (br, a) { return br && br.findLayer ? br.findLayer(a[0], a[1]) : null; }, blocked: null },
  };

  // Resolve a skill record by NAME (case-insensitive) or numeric index from the
  // bridge's getSkills() array [{index,name,value,base,cap,lock}]. Returns a Promise
  // of the record (null if unknown) so API.GetSkill('Magery').value works in scripts.
  function skillEntry(br, key) {
    if (!br || !br.getSkills) { return null; }
    return Promise.resolve(br.getSkills()).then(function (skills) {
      if (!Array.isArray(skills)) { return null; }
      var k = String(key == null ? '' : key).toLowerCase().trim();
      var s = skills.filter(function (x) {
        return String(x.name || '').toLowerCase() === k || String(x.index) === k;
      })[0];
      return s || null;
    });
  }

  // Map a LegionScript direction (name or number) to the UO Direction byte 0-7:
  // 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW. Accepts the enum member names TazUO
  // uses (North/Right/East/Down/South/Left/West/Up) plus the common compass aliases.
  function dirToNum(d) {
    if (typeof d === 'number') { return d & 7; }
    var names = {
      north: 0, up: 7, northeast: 1, ne: 1, right: 1, east: 2,
      southeast: 3, se: 3, down: 3, south: 4, southwest: 5, sw: 5, left: 5,
      west: 6, northwest: 7, nw: 7
    };
    var k = String(d == null ? '' : d).toLowerCase().trim();
    if (k in names) { return names[k]; }
    var n = parseInt(d, 10);
    return isNaN(n) ? 0 : (n & 7);
  }

  function handleCall(method, argsJson) {
    var args = []; try { args = JSON.parse(argsJson || '[]'); } catch (e) { args = []; }
    if (method === 'Pause') { var ms = Math.max(0, (Number(args[0]) || 0) * 1000); setTimeout(function () { writeResult(null); }, ms); return; }
    if (method === 'Stop') { return writeResult(null); }
    var d = D[method];
    if (!d) { emit('[ls] API.' + method + '() is not available yet (bridge growth pending)', 'muted'); return writeResult(null); }
    if (d.verb && !(allowed && allowed.has(d.verb))) {
      emit('API.' + method + "() — disabled by this shard's script policy (an admin can enable it)", 'muted');
      return writeResult(d.blocked !== undefined ? d.blocked : null);
    }
    var br = window.UORailBridge || null;
    try {
      Promise.resolve(d.call(br, args)).then(function (val) { writeResult(val === undefined ? null : val); })
        .catch(function (e) { emit('[ls] ' + method + ' error: ' + e, 'err'); writeResult(d.blocked !== undefined ? d.blocked : null); });
    } catch (e) { emit('[ls] ' + method + ' error: ' + e, 'err'); writeResult(d.blocked !== undefined ? d.blocked : null); }
  }

  // Fetch this shard's allowed verbs (same endpoint + semantics as the JS sandbox).
  function fetchPolicy() {
    var slug = (window.__chosenServerSlug || '').toString();
    return fetch('/api/script-policy/' + encodeURIComponent(slug), { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      .then(function (j) { allowed = new Set((j && Array.isArray(j.verbs)) ? j.verbs : []); });
  }

  function boot(cb) {
    if (ready) { cb && cb(true); return; }
    bootCbs.push(cb);
    if (booting) return;
    booting = true;
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') {
      emit('LegionScript needs SharedArrayBuffer (cross-origin isolation) — unavailable here.', 'err');
      flushBoot(false); return;
    }
    var ctrlSab = new SharedArrayBuffer(4), dataSab = new SharedArrayBuffer(256 * 1024), stopSab = new SharedArrayBuffer(4);
    ctrl = new Int32Array(ctrlSab); dataView = new Uint8Array(dataSab); stopView = new Int32Array(stopSab);
    try { worker = new Worker(BASE + 'legion-worker.js' + QV); }
    catch (e) { emit('Could not start the LegionScript worker: ' + e, 'err'); flushBoot(false); return; }
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'ready') { ready = true; flushBoot(true); }
      else if (m.type === 'call') { handleCall(m.method, m.args); }
      else if (m.type === 'print') { emit(String(m.text).replace(/\n$/, ''), m.err ? 'err' : 'out'); }
      else if (m.type === 'error') { emit('✖ ' + m.text, 'err'); running = false; }
      else if (m.type === 'done') { emit(m.stopped ? '■ stopped' : '■ finished', 'muted'); running = false; }
    };
    worker.onerror = function (e) { emit('LegionScript worker error: ' + (e.message || e.filename || e), 'err'); running = false; };
    emit('Booting CPython (Pyodide)… first run downloads ~13 MB.', 'muted');
    worker.postMessage({ type: 'init', ctrl: ctrlSab, data: dataSab, stop: stopSab, pyodideUrl: BASE + 'pyodide/' });
  }

  function flushBoot(ok) { var cbs = bootCbs; bootCbs = []; booting = false; cbs.forEach(function (c) { try { c && c(ok); } catch (e) {} }); }

  window.UORailLegion = {
    isReady: function () { return ready; },
    run: function (code, outFn) {
      if (typeof outFn === 'function') onOut = outFn;
      if (running) { emit('Already running — press Stop first.', 'muted'); return; }
      running = true;
      fetchPolicy().then(function () {
        boot(function (ok) {
          if (!ok) { running = false; return; }
          Atomics.store(stopView, 0, 0);
          worker.postMessage({ type: 'run', code: String(code || '') });
        });
      });
    },
    isRunning: function () { return running; },
    stop: function () {
      if (!worker) return;
      Atomics.store(stopView, 0, 1);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
    },
  };
})();
