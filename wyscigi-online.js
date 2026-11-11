'use strict';
// Wyścigi klocków – gra online przez Firebase Realtime Database (do 6 graczy).
//
// Pokój to races/<kod> w bazie:
//   cfg:  { d: JSON ustawień gospodarza, g: numer wyścigu, go: czas startu (zegar serwera, ms) }
//   p:    { <miejsce 0–5>: { id, c: postać, v: pojazd } }   – miejsca przydziela gospodarz (0 = gospodarz)
//   q:    { <id gościa>: { c, v, f? } }                     – prośby o miejsce (f: pokój pełny)
//   pres: { <miejsce>: true }                                 – kto jest online (onDisconnect usuwa)
//   s:    { <miejsce>|b: { d: stan pojazdu(ów), e: ostatnie zdarzenia } } – w czasie wyścigu ~10×/s
//   t:    czas ostatniego zapisu (do sprzątania starych pokojów)
// Gospodarz liczy też komputerowych przeciwników i wysyła ich stan w s/b.
(function () {
  const FB_URL = 'vendor/firebase-db.min.js';
  const CFG = window.MLYNEK_FIREBASE || {};
  const ROOM_RE = /^[a-z0-9]{6,12}$/;
  const MAX = 6;
  let fbLib = null, fbDb = null;

  const configured = () => !!(CFG.databaseURL && /^https?:\/\//.test(CFG.databaseURL));
  function load() {
    if (window.MlynekFirebase) return Promise.resolve();
    if (fbLib) return fbLib;
    fbLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = FB_URL; s.onload = res;
      s.onerror = () => { fbLib = null; rej(new Error('Nie udało się wczytać biblioteki Firebase')); };
      document.head.appendChild(s);
    });
    return fbLib;
  }
  function db() {
    if (fbDb) return fbDb;
    const F = window.MlynekFirebase;
    const app = F.initializeApp({ databaseURL: CFG.databaseURL }, 'wyscigi');
    fbDb = F.getDatabase(app);
    if (CFG.emulator) F.connectDatabaseEmulator(fbDb, CFG.emulator.host, CFG.emulator.port);
    return fbDb;
  }
  function randomCode(len) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let r = '';
    for (const x of crypto.getRandomValues(new Uint8Array(len || 6))) r += a[x % a.length];
    return r;
  }
  const cleanCode = s => (s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const link = room => location.origin + location.pathname + '?wyscig=' + room;

  // opts: room, host, me: {c, v}, onChange(net), onStart(cfg), onStates(val)
  function create(opts) {
    const host = !!opts.host, room = opts.room;
    const net = {
      room, host, myId: randomCode(10), slot: host ? 0 : -1, me: { c: opts.me.c, v: opts.me.v },
      players: {}, pres: {}, cfg: null, settings: null, offset: 0,
      up: false, everUp: false, err: null, full: false, closed: false, left: false
    };
    const unsub = [];
    const offSince = {};             // gospodarz: od kiedy gość jest offline (zwalnianie miejsc)
    let F = null, ref = null, presRef = null, lastGen = -1, setTimer = 0, pendingSettings = null;

    const changed = () => { if (!net.left && opts.onChange) opts.onChange(net); };
    function fbErr(e) {
      const code = (e && (e.code || e.message)) || '';
      net.err = /permission/i.test(code) ? 'Serwer odrzucił połączenie (sprawdź reguły bazy Firebase).' : 'Błąd serwera: ' + code;
      changed();
    }
    net.serverNow = () => Date.now() + net.offset;

    function claimPresence() {
      if (net.slot < 0 || !net.up) return;
      presRef = ref('pres/' + net.slot);
      F.onDisconnect(presRef).remove().catch(() => {});
      F.set(presRef, true).catch(fbErr);
    }

    net.start = async function () {
      changed();
      if (!configured()) { net.err = 'Gra online nie jest jeszcze skonfigurowana na tej stronie.'; return changed(); }
      if (!ROOM_RE.test(room)) { net.err = 'Nieprawidłowy kod pokoju.'; return changed(); }
      try { await load(); } catch (e) { net.err = e.message; return changed(); }
      if (net.left) return;
      F = window.MlynekFirebase;
      const d = db();
      ref = p => F.ref(d, 'races/' + room + (p ? '/' + p : ''));

      unsub.push(F.onValue(F.ref(d, '.info/serverTimeOffset'), s => { net.offset = s.val() || 0; }));
      unsub.push(F.onValue(F.ref(d, '.info/connected'), s => {
        net.up = s.val() === true;
        if (net.up) {
          net.everUp = true; claimPresence();
          if (host && F) F.update(ref('p/0'), { id: net.myId, c: net.me.c, v: net.me.v }).catch(() => {});
        }
        changed();
      }));

      if (host) {
        F.update(ref(''), { 'p/0': { id: net.myId, c: net.me.c, v: net.me.v }, t: F.serverTimestamp() }).catch(fbErr);
        if (pendingSettings) net.publishSettings(pendingSettings);
      } else {
        F.set(ref('q/' + net.myId), { c: net.me.c, v: net.me.v }).catch(fbErr);
        F.onDisconnect(ref('q/' + net.myId)).remove().catch(() => {});
      }

      let firstP = true;
      unsub.push(F.onValue(ref('p'), s => {
        const v = s.val() || {};
        net.players = {};
        for (const k of Object.keys(v)) if (/^[0-5]$/.test(k) && v[k]) net.players[k] = v[k];
        if (!host) {
          const mine = Object.keys(net.players).find(k => net.players[k].id === net.myId);
          const had = net.slot;
          net.slot = mine === undefined ? -1 : +mine;
          if (net.slot >= 0 && had !== net.slot) claimPresence();
          if (had >= 0 && net.slot < 0) {
            // gospodarz jest, ale zwolnił nasze miejsce (długi brak zasięgu) – poproś o nie ponownie
            if (net.players[0]) F.set(ref('q/' + net.myId), { c: net.me.c, v: net.me.v }).catch(fbErr);
            else net.closed = true;
          }
          if (!firstP && !net.players[0] && net.slot >= 0) net.closed = true;
        }
        firstP = false;
        changed();
      }, fbErr));

      unsub.push(F.onValue(ref('pres'), s => {
        net.pres = s.val() || {};
        if (host) {
          // gość offline dłużej niż 2 min – zwolnij jego miejsce
          const now = Date.now();
          for (const k of Object.keys(net.players)) {
            if (k === '0') continue;
            if (net.pres[k]) delete offSince[k]; else if (!offSince[k]) offSince[k] = now;
          }
        }
        changed();
      }, fbErr));

      if (host) {
        unsub.push(F.onValue(ref('q'), s => {
          const q = s.val() || {};
          const patch = {};
          for (const id of Object.keys(q)) {
            const req = q[id];
            if (!req || req.f) continue;
            const taken = new Set(Object.keys(net.players).map(Number));
            Object.keys(patch).forEach(k => { const m = /^p\/(\d)$/.exec(k); if (m) taken.add(+m[1]); });
            let free = -1;
            for (let i = 1; i < MAX; i++) if (!taken.has(i)) { free = i; break; }
            if (free < 0) patch['q/' + id + '/f'] = true;
            else { patch['p/' + free] = { id, c: req.c | 0, v: req.v | 0 }; patch['q/' + id] = null; }
          }
          if (Object.keys(patch).length) F.update(ref(''), patch).catch(fbErr);
        }, fbErr));
        setTimer = setInterval(() => {
          if (net.left || net.racing) return;
          const now = Date.now(), patch = {};
          for (const k of Object.keys(offSince)) if (now - offSince[k] > 120000 && net.players[k]) { patch['p/' + k] = null; patch['s/' + k] = null; delete offSince[k]; }
          patch.t = F.serverTimestamp();
          F.update(ref(''), patch).catch(() => {});
        }, 5000);
      } else {
        unsub.push(F.onValue(ref('q/' + net.myId + '/f'), s => { if (s.val() === true) { net.full = true; changed(); } }));
      }

      unsub.push(F.onValue(ref('cfg'), s => {
        const c = s.val();
        if (!c) { if (!host && net.cfg) { net.closed = true; changed(); } return; }
        let st = null;
        try { st = JSON.parse(c.d); } catch (e) { /* zły format */ }
        net.cfg = c; net.settings = st;
        changed();
        if (typeof c.go === 'number' && c.g !== lastGen && st && st.roster) {
          lastGen = c.g;
          if (opts.onStart) opts.onStart(c, st);
        }
      }, fbErr));

      unsub.push(F.onValue(ref('s'), s => { if (opts.onStates) opts.onStates(s.val() || {}); }));
    };

    // gospodarz: ustawienia widoczne dla gości w poczekalni
    net.publishSettings = function (st) {
      if (!host) return;
      if (!F) { pendingSettings = st; return; }
      F.update(ref('cfg'), { d: JSON.stringify(st), g: net.cfg ? net.cfg.g || 0 : 0 }).catch(fbErr);
    };
    // gospodarz: start wyścigu za ~4,5 s (wspólny zegar serwera)
    net.startRace = function (st) {
      if (!host || !F) return;
      const g = ((net.cfg && net.cfg.g) || 0) + 1;
      F.update(ref(''), { cfg: { d: JSON.stringify(st), g, go: Math.round(net.serverNow() + 4500) }, s: null, t: F.serverTimestamp() }).catch(fbErr);
    };
    net.setMe = function (c, v) {
      net.me = { c, v };
      if (!F) return;
      if (net.slot >= 0) F.update(ref('p/' + net.slot), { c, v }).catch(fbErr);
      else if (!host && !net.full) F.update(ref('q/' + net.myId), { c, v }).catch(() => {});
    };
    // stan pojazdu (key: miejsce albo 'b' dla komputerowych przeciwników)
    net.send = function (key, d, e) {
      if (!F || net.left || (key !== 'b' && key < 0)) return;
      const v = { d };
      if (e) v.e = e;
      F.set(ref('s/' + key), v).catch(() => {});
    };
    net.clear = function (key) {
      if (!F || net.left || (key !== 'b' && key < 0)) return;
      F.remove(ref('s/' + key)).catch(() => {});
    };
    net.online = slot => !!net.pres[slot];
    net.count = () => Object.keys(net.players).length;

    net.leave = function () {
      if (net.left) return;
      net.left = true;
      clearInterval(setTimer);
      for (const u of unsub) { try { u(); } catch (e) { /* już odpięty */ } }
      if (F && ref) {
        if (presRef) { F.onDisconnect(presRef).cancel().catch(() => {}); }
        if (host) F.remove(ref('')).catch(() => {});
        else {
          const patch = { ['q/' + net.myId]: null };
          if (net.slot >= 0) { patch['p/' + net.slot] = null; patch['pres/' + net.slot] = null; patch['s/' + net.slot] = null; }
          F.update(ref(''), patch).catch(() => {});
        }
      }
    };

    net.status = function () {
      if (net.err) return { kind: 'err', text: net.err };
      if (net.closed) return { kind: 'err', text: 'Gospodarz zamknął pokój.' };
      if (net.full) return { kind: 'err', text: 'Pokój jest pełny (6 graczy).' };
      if (!net.up) return net.everUp ? { kind: 'err', text: 'Brak połączenia z internetem – ponawiam…' } : { kind: 'wait', text: 'Łączenie z serwerem…' };
      if (!host && net.slot < 0) return { kind: 'wait', text: 'Czekam na miejsce w pokoju… (gospodarz musi mieć otwartą grę)' };
      const n = net.count();
      if (host) return n > 1 ? { kind: 'ok', text: 'W pokoju: ' + n + ' graczy. Możesz zaczynać!' } : { kind: 'wait', text: 'Czekam na graczy – wyślij im link.' };
      return { kind: 'ok', text: 'Jesteś w pokoju jako gracz ' + (net.slot + 1) + '. Czekaj, aż gospodarz rozpocznie wyścig.' };
    };
    return net;
  }

  window.RaceNet = { configured, create, randomCode, cleanCode, link, ROOM_RE, MAX };
})();
