/* LegionScript engine — Pyodide worker (TUO only).
 *
 * Runs CPython (Pyodide) OFF the main thread so blocking Legion scripts never
 * freeze the UI. Each `API.*` call is a SYNCHRONOUS RPC to the main thread over a
 * SharedArrayBuffer (Atomics.wait): the worker posts the call then parks until
 * main writes the result back and notifies. This is what lets Legion's synchronous
 * syntax work in the browser (the webclient is already cross-origin-isolated for
 * the .NET MT runtime, so SAB + Atomics are available).
 *
 * Protocol (SABs created by legion-engine.js, handed over in `init`):
 *   ctrl  Int32Array[1]  — signal; worker stores 0 + waits, main stores 1 + notifies
 *   data  Uint8Array[N]  — result channel: [0..3]=uint32 LE length, [4..]=JSON bytes
 *   stop  Int32Array[1]  — stop[0]===1 => abort the running script
 */
'use strict';

var ctrl = null, data = null, stop = null;
var dec = new TextDecoder();
var pyReady = false;

function post(type, extra) { var m = { type: type }; if (extra) for (var k in extra) m[k] = extra[k]; self.postMessage(m); }

function lscall(method, argsJson) {
  if (stop && Atomics.load(stop, 0) === 1) throw new Error('__LS_STOP__');
  Atomics.store(ctrl, 0, 0);
  post('call', { method: method, args: argsJson });
  Atomics.wait(ctrl, 0, 0);
  if (stop && Atomics.load(stop, 0) === 1) throw new Error('__LS_STOP__');
  var len = (data[0]) | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  if (len <= 0) return '';
  // TextDecoder refuses a SharedArrayBuffer view — copy out before decoding.
  return dec.decode(new Uint8Array(data.subarray(4, 4 + len)));
}

// Python-side Legion API. Mirrors TazUO's API.* surface; methods funnel through
// _api_call → the JS _lscall RPC. The engine maps each to the camelCase bridge the
// JS macros use (so JS+LS reach identical capabilities) and gates them with the
// same per-shard policy. Bridge JSON uses lowercase keys; __getattr__ accepts
// Pascal/lower so Legion's `entity.Serial` / `API.Player.Hits` work either way.
var API_SHIM = `
import json as _json

def _api_call(method, *args):
    raw = _lscall(method, _json.dumps(list(args)))
    return _json.loads(raw) if raw else None

def _pick(d, k):
    for key in (k, k.lower(), (k[0].lower() + k[1:]) if k else k):
        if key in d:
            return d[key]
    return None

class _Stop(BaseException):
    # BaseException (not Exception) so a script's 'except Exception' can't swallow
    # API.Stop(). The worker recognises '__LS_STOP__' in the message and reports
    # the run as stopped.
    pass

class _Entity(object):
    def __init__(self, d): object.__setattr__(self, '_d', d or {})
    def __getattr__(self, k): return _pick(object.__getattribute__(self, '_d'), k)
    def __getitem__(self, k): return object.__getattribute__(self, '_d').get(k)
    def __bool__(self): return bool(object.__getattribute__(self, '_d'))
    def __repr__(self): return 'Entity(%r)' % (object.__getattribute__(self, '_d'),)

class _Player(object):
    def __getattr__(self, k):
        v = _pick(_api_call('GetPlayer') or {}, k)
        if v is None:
            raise AttributeError(k)
        return v

class ScanType(object):
    Any = 0
    Mobiles = 1
    Items = 2
    Hostile = 1

class _API(object):
    Player = _Player()
    ScanType = ScanType
    _ignore = set()   # LS ignore list (excluded from _scan / finders) — worker-local, mirrors LegionAPI._ignoreList

    @property
    def Backpack(self): return _api_call('GetBackpack') or 0

    # Full Legion surface (173 verbs). Methods defined explicitly below are wired to
    # the bridge; the rest are reachable here too (so any Legion script CALLS without
    # AttributeError) and pass through to the engine, which runs them where a bridge
    # method exists and otherwise reports "pending bridge growth". Unknown names
    # (typos) still raise AttributeError. Admin can gate any of them.
    _KNOWN = set((
        "ActiveBuffs AddControlOnClick AddControlOnDisposed AddFriend AddGump AddMapMarker AllyMsg Attack "
        "AutoFollow AutoLootContainer BandageSelf BuffExists CancelAutoFollow CancelPathfinding CancelPreTarget "
        "CancelTarget CastSpell CheckSoundLog ClearIgnoreList ClearJournal ClearLeftHand ClearMoveQueue "
        "ClearRightHand ClearSharedVars ClearSoundLog ClickObject ClientCommand CloseContextMenus CloseGump "
        "CloseGumps ConfigNextGump Contents ContextMenu CreateCooldownBar CreateDropDown CreateGump "
        "CreateGumpButton CreateGumpCheckbox CreateGumpColorBox CreateGumpItemPic CreateGumpLabel CreateGumpPic "
        "CreateGumpRadioButton CreateGumpScrollArea CreateGumpSimpleProgressBar CreateGumpTTFLabel "
        "CreateGumpTextBox CreateModernGump CreateSimpleButton CurrentAbilityNames Dismount DisplayRange Dress "
        "DressItems DropFromCursor EmoteMsg EquipItem FindItem FindLayer FindMobile FindType FindTypeAll "
        "GetAllFriends GetAllGumps GetAllMobiles GetAvailableDressOutfits GetGump GetGumpContents GetHeldItem "
        "GetItemsOnGround GetJournalEntries GetMap GetMultisAt GetMultisInArea GetPartyLeader "
        "GetPartyMemberSerials GetPath GetPersistentVar GetSharedVar GetSkill GetSoundLog GetStaticsAt "
        "GetStaticsInArea GetTile GlobalMsg GrayMenuResponseCurrent GuildMsg GumpContains HasGump HasTarget "
        "HeadMsg IgnoreObject InJournal InJournalAny IsFriend IsGlobalCooldownActive IsProcessingMoveQueue "
        "IsProcessingUseItemQueue ItemNameAndProps ItemsInContainer KnownAbilityNames Logout MarkTile "
        "MenuItemsCurrent MenuResponseCurrent Mount MoveItem MoveItemOffset Msg NearestCorpse NearestEntity "
        "NearestMobile NearestMobiles OnHotKey OnIgnoreList Organizer PartyMsg Pathfind PathfindEntity "
        "Pathfinding Pause PickUpToCursor PlayScript PreTarget PrimaryAbilityActive PromptResponse QueueMoveItem "
        "QueueMoveItemOffset RemoveFriend RemoveMapMarker RemoveMarkedTile RemovePersistentVar RemoveSharedVar "
        "Rename ReplyGump RequestAnyTarget RequestOPLData RequestTarget Run SavePersistentVar "
        "SecondaryAbilityActive SetMount SetSharedVar SetSkillLock SetStatLock SetWarMode Stop StopScript SysMsg "
        "Target TargetLandRel TargetResource TargetSelf TargetTileRel ToggleAbility ToggleAutoLoot ToggleFly "
        "ToggleScript TrackingArrow Turn UnIgnoreObject Undress UndressAll UseObject UseSkill UseType Virtue "
        "WaitForGump WaitForTarget Walk WhisperMsg YellMsg SysMessage GetBackpack ScanWorld"
    ).split())

    def __getattr__(self, k):
        if k in _API._KNOWN:
            def _stub(*args):
                return _api_call(k, *[(a if isinstance(a, (int, float, str, bool)) or a is None else str(a)) for a in args])
            return _stub
        raise AttributeError(k)

    # ── messaging ──
    def SysMessage(self, text, hue=946): _api_call('SysMessage', str(text), int(hue))
    def SysMsg(self, text, hue=946): _api_call('SysMsg', str(text), int(hue))
    def HeadMsg(self, text, serial=0): _api_call('HeadMsg', str(text), int(serial))
    def Msg(self, text): _api_call('Msg', str(text))
    def EmoteMsg(self, text): _api_call('EmoteMsg', str(text))
    def WhisperMsg(self, text): _api_call('WhisperMsg', str(text))
    def YellMsg(self, text): _api_call('YellMsg', str(text))
    def PartyMsg(self, text): return _api_call('PartyMsg', str(text))
    def GuildMsg(self, text): return _api_call('GuildMsg', str(text))
    def AllyMsg(self, text): return _api_call('AllyMsg', str(text))
    def GlobalMsg(self, text): return _api_call('GlobalMsg', str(text))

    # ── control ──
    def Pause(self, seconds): _api_call('Pause', float(seconds))
    def Stop(self): raise _Stop('__LS_STOP__')

    # ── actions ──
    def UseObject(self, serial): _api_call('UseObject', int(serial))
    def ClickObject(self, serial): _api_call('ClickObject', int(serial))
    def UseType(self, graphic, container=0):
        e = self.FindType(graphic, container)
        if e: _api_call('UseObject', int(e.Serial or 0))
        return e
    def CastSpell(self, name): _api_call('CastSpell', name)
    def UseSkill(self, name): _api_call('UseSkill', name)
    def EquipItem(self, serial): return _api_call('EquipItem', int(serial))
    def MoveItem(self, serial, destination=0, amount=0): return _api_call('MoveItem', int(serial), int(destination), int(amount))
    def QueueMoveItem(self, serial, destination=0, amount=0): return _api_call('QueueMoveItem', int(serial), int(destination), int(amount))
    def GrabItem(self, serial, amount=0, container=0): return _api_call('GrabItem', int(serial), int(amount), int(container))

    # ── targeting ──
    def Target(self, serial): return _api_call('Target', int(serial))
    def TargetSelf(self): return _api_call('TargetSelf')
    def TargetLast(self): return _api_call('TargetLast')
    def CancelTarget(self): return _api_call('CancelTarget')
    def RequestTarget(self, timeout=10):
        r = _api_call('RequestTarget')
        return _Entity(r) if isinstance(r, dict) else r
    def RequestAnyTarget(self, timeout=10): return self.RequestTarget(timeout)
    def HasTarget(self): return bool(_api_call('HasTarget'))
    def WaitForTarget(self, timeout=10): return bool(_api_call('WaitForTarget', float(timeout)))

    # ── navigation ──
    def Walk(self, x, y, z=0): return _api_call('Walk', int(x), int(y), int(z))
    def Run(self, x, y, z=0): return _api_call('Run', int(x), int(y), int(z))
    def Pathfind(self, x, y, z=0): return _api_call('Walk', int(x), int(y), int(z))
    def StopWalk(self): return _api_call('StopWalk')

    # ── perception / reads ──
    def GetBackpack(self): return _api_call('GetBackpack')
    def Contents(self, serial): return [_Entity(x) for x in (_api_call('Contents', int(serial)) or [])]
    def ItemsInContainer(self, serial): return self.Contents(serial)
    def GetGumpContents(self, serial): return self.Contents(serial)
    def GetEquippedItems(self): return [_Entity(x) for x in (_api_call('GetEquipped') or [])]
    def Durability(self): return _api_call('Durability') or []
    def GetAllFriends(self): return _api_call('GetAllFriends') or []
    def IsFriend(self, serial):
        s = int(serial)
        return any(int(_pick(f, 'Serial') or -1) == s for f in self.GetAllFriends())

    # ── journal ──
    def GetJournalEntries(self, count=50): return _api_call('GetJournal', int(count)) or []
    def InJournal(self, text):
        t = str(text).lower()
        return any(t in str(_pick(e, 'Text') or '').lower() for e in self.GetJournalEntries())
    def InJournalAny(self, texts):
        return any(self.InJournal(x) for x in texts)

    # ── LS ignore list (worker-local; excluded from _scan / finders) ──
    def IgnoreObject(self, serial): _API._ignore.add(int(serial))
    def UnIgnoreObject(self, serial): _API._ignore.discard(int(serial))
    def OnIgnoreList(self, serial): return int(serial) in _API._ignore
    def ClearIgnoreList(self): _API._ignore.clear()

    # ── world scan + finders (over ScanWorld) ──
    def _scan(self, kind=0, rng=18):
        return [_Entity(x) for x in (_api_call('ScanWorld', int(rng), int(kind)) or [])
                if int(_pick(x, 'Serial') or 0) not in _API._ignore]
    def NearestMobiles(self, rng=18):
        return sorted(self._scan(ScanType.Mobiles, rng),
                      key=lambda e: (e.Distance if e.Distance is not None else 9999))
    def GetAllMobiles(self, rng=18): return self._scan(ScanType.Mobiles, rng)
    def GetItemsOnGround(self, rng=18): return self._scan(ScanType.Items, rng)
    def FindType(self, graphic, container=0, rng=18):
        g = int(graphic)
        for e in self._scan(0, rng):
            if int(e.Graphic or 0) == g: return e
        return None
    def FindTypeAll(self, graphic, container=0, rng=18):
        g = int(graphic)
        return [e for e in self._scan(0, rng) if int(e.Graphic or 0) == g]
    def FindItem(self, serial):
        s = int(serial)
        for e in self._scan(0, 18):
            if int(e.Serial or 0) == s: return e
        return None
    def FindMobile(self, serial): return self.FindItem(serial)
    def NearestEntity(self, kind=0, rng=18):
        items = self._scan(kind, rng)
        if not items: return None
        return min(items, key=lambda e: (e.Distance if e.Distance is not None else (e['dist'] if e['dist'] is not None else 9999)))
    def NearestMobile(self, rng=18): return self.NearestEntity(ScanType.Mobiles, rng)
    def NearestCorpse(self, rng=18):
        best = None
        for e in self._scan(0, rng):
            if int(e.Graphic or 0) == 0x2006:
                if best is None or (e.Distance or 9999) < (best.Distance or 9999): best = e
        return best
    def Attack(self, serial): _api_call('Attack', int(serial))
    def GetSkill(self, name):
        r = _api_call('GetSkill', name)
        return _Entity(r) if isinstance(r, dict) else r

    # ── gumps ──
    def GetAllGumps(self): return _api_call('GetGumps') or []
    def HasGump(self, gid=0):
        gs = self.GetAllGumps()
        if not gid: return len(gs) > 0
        return any(int(_pick(g, 'Id') or _pick(g, 'Serial') or 0) == int(gid) for g in gs)
    def ReplyGump(self, gid, button): return _api_call('ReplyGump', int(gid), int(button))
    def WaitForGump(self, gid=0, timeout=10): return self.HasGump(gid)

    # ── mouse ──
    def MouseMove(self, x, y): _api_call('MouseMove', int(x), int(y))
    def MouseClick(self, right=False): _api_call('MouseClick', bool(right))
    def MouseDoubleClick(self, right=False): _api_call('MouseDoubleClick', bool(right))
    def ObjectAtCursor(self):
        r = _api_call('ObjectAtCursor')
        return _Entity(r) if isinstance(r, dict) else r

    # ── LegionScript API completion (2026-07-24) ──
    def SetWarMode(self, enabled=True): _api_call('SetWarMode', bool(enabled))
    def BandageSelf(self): return bool(_api_call('BandageSelf'))
    def ToggleAbility(self, ability): _api_call('ToggleAbility', str(ability))
    def Virtue(self, virtue): _api_call('Virtue', str(virtue))
    def SetSkillLock(self, skill, up_down_locked): _api_call('SetSkillLock', str(skill), str(up_down_locked))
    def SetStatLock(self, stat, up_down_locked): _api_call('SetStatLock', str(stat), str(up_down_locked))
    def DisplayRange(self, distance, hue=22): _api_call('DisplayRange', int(distance), int(hue))
    def TrackingArrow(self, x, y, identifier=-1): _api_call('TrackingArrow', int(x), int(y), float(identifier))
    def PrimaryAbilityActive(self): return bool(_api_call('PrimaryAbilityActive'))
    def SecondaryAbilityActive(self): return bool(_api_call('SecondaryAbilityActive'))
    def CurrentAbilityNames(self): return _api_call('CurrentAbilityNames') or []
    def KnownAbilityNames(self): return _api_call('KnownAbilityNames') or []
    def IsGlobalCooldownActive(self): return bool(_api_call('IsGlobalCooldownActive'))
    def ActiveBuffs(self): return [_Entity(b) for b in (_api_call('ActiveBuffs') or [])]
    def BuffExists(self, buffName): return bool(_api_call('BuffExists', str(buffName)))
    def Mount(self, serial=0): _api_call('Mount', float(serial))
    def Dismount(self, skipQueue=True): _api_call('Dismount')
    def SetMount(self, serial): _api_call('SetMount', float(serial))
    def ToggleFly(self): _api_call('ToggleFly')
    def Logout(self): _api_call('Logout')
    def Rename(self, serial, name): _api_call('Rename', float(serial), str(name))
    def ClearLeftHand(self):
        r = _api_call('ClearLeftHand')
        return _Entity(r) if isinstance(r, dict) else None
    def ClearRightHand(self):
        r = _api_call('ClearRightHand')
        return _Entity(r) if isinstance(r, dict) else None
    def PickUpToCursor(self, serial=0, amt=0): _api_call('PickUpToCursor', float(serial), int(amt))
    def DropFromCursor(self, serial=0, x=65535, y=65535, z=127, container=-1): _api_call('DropFromCursor', float(serial), int(x), int(y), int(z), float(container))
    def MoveItemOffset(self, serial, amt=0, x=0, y=0, z=0, OSI=False): _api_call('MoveItemOffset', float(serial), int(amt), int(x), int(y), int(z), bool(OSI))
    def ClearMoveQueue(self): _api_call('ClearMoveQueue')
    def IsProcessingMoveQueue(self): return bool(_api_call('IsProcessingMoveQueue'))
    def IsProcessingUseItemQueue(self): return bool(_api_call('IsProcessingUseItemQueue'))
    def GetHeldItem(self): return _api_call('GetHeldItem') or 0
    def RequestOPLData(self, serials):
        try: items = list(serials)
        except TypeError: items = [serials]
        _api_call('RequestOPLData', ','.join(str(int(s)) for s in items))
    def ItemNameAndProps(self, serial, wait=False, timeout=10): return _api_call('ItemNameAndProps', float(serial)) or ''
    def CloseGump(self, ID=-1): return bool(_api_call('CloseGump', float(ID)))
    def GumpContains(self, text, ID=-1): return bool(_api_call('GumpContains', str(text), float(ID)))
    def ContextMenu(self, serial, entry): _api_call('ContextMenu', float(serial), int(entry))
    def CloseContextMenus(self): _api_call('CloseContextMenus')
    def GetMap(self): return _api_call('GetMap')
    def GetTile(self, x, y):
        r = _api_call('GetTile', int(x), int(y))
        return _Entity(r) if isinstance(r, dict) else None
    def GetStaticsAt(self, x, y): return [_Entity(s) for s in (_api_call('GetStaticsAt', int(x), int(y)) or [])]
    def GetStaticsInArea(self, x1, y1, x2, y2): return [_Entity(s) for s in (_api_call('GetStaticsInArea', int(x1), int(y1), int(x2), int(y2)) or [])]
    def GetPartyLeader(self): return _api_call('GetPartyLeader') or 0
    def GetPartyMemberSerials(self): return _api_call('GetPartyMemberSerials') or []
    def GetPath(self, x, y, z=None, distance=1): return _api_call('GetPath', int(x), int(y), (int(z) if z is not None else -2147483648), int(distance)) or []
    def Pathfinding(self): return bool(_api_call('Pathfinding'))
    def CancelPathfinding(self): _api_call('CancelPathfinding')
    def MarkTile(self, x, y, hue, map=-1): _api_call('MarkTile', int(x), int(y), int(hue), int(map))
    def RemoveMarkedTile(self, x, y, map=-1): _api_call('RemoveMarkedTile', int(x), int(y), int(map))
    def Dress(self, name): _api_call('Dress', str(name))
    def Undress(self, name): _api_call('Undress', str(name))
    def UndressAll(self, kr=False): _api_call('UndressAll', bool(kr))
    def GetAvailableDressOutfits(self): return _api_call('GetAvailableDressOutfits') or []
    def ToggleAutoLoot(self): _api_call('ToggleAutoLoot')
    def AutoLootContainer(self, container): _api_call('AutoLootContainer', float(container))
    def AutoFollow(self, mobile): _api_call('AutoFollow', float(mobile))
    def CancelAutoFollow(self): _api_call('CancelAutoFollow')
    def TargetLandRel(self, xOffset, yOffset): _api_call('TargetLandRel', int(xOffset), int(yOffset))
    def TargetTileRel(self, xOffset, yOffset, graphic=-1): _api_call('TargetTileRel', int(xOffset), int(yOffset), int(graphic))
    def TargetResource(self, itemSerial, resource): _api_call('TargetResource', float(itemSerial), int(resource))
    def FindLayer(self, layer, serial=0):
        r = _api_call('FindLayer', str(layer), float(serial))
        return _Entity(r) if isinstance(r, dict) else None

API = _API()
`;

self.onmessage = async function (e) {
  var m = e.data;
  try {
    if (m.type === 'init') {
      ctrl = new Int32Array(m.ctrl);
      data = new Uint8Array(m.data);
      stop = new Int32Array(m.stop);
      importScripts(m.pyodideUrl + 'pyodide.js');
      // eslint-disable-next-line no-undef
      self.pyodide = await loadPyodide({
        indexURL: m.pyodideUrl,
        stdout: function (s) { post('print', { text: s }); },
        stderr: function (s) { post('print', { text: s, err: true }); },
      });
      self.pyodide.globals.set('_lscall', lscall);
      await self.pyodide.runPythonAsync(API_SHIM);
      pyReady = true;
      post('ready');
    } else if (m.type === 'run') {
      if (!pyReady) { post('error', { text: 'engine not ready' }); return; }
      try {
        await self.pyodide.runPythonAsync(m.code);
        post('done', {});
      } catch (err) {
        var msg = String(err && err.message ? err.message : err);
        if (msg.indexOf('__LS_STOP__') >= 0) post('done', { stopped: true });
        else post('error', { text: msg });
      }
    }
  } catch (outer) {
    post('error', { text: String(outer && outer.message ? outer.message : outer) });
  }
};
