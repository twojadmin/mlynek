// Wspólna obsługa gry online przez Firebase Realtime Database – używana przez
// młynka (index.html) i szachy (szachy.html).
//
// Każdy pokój to rooms/<kod> w bazie:
//   state: { d: JSON stanu gry, seq: numer wersji, hc: kolor gospodarza (1|2) }
//   pres:  { h: gospodarz online, g: gość online }   (onDisconnect usuwa wpis)
//   msg:   { t, id, from }                            (prośby: nowa gra, remis)
//   t:     czas ostatniego zapisu (do sprzątania starych pokojów)
// Baza pamięta stan, więc po odświeżeniu strony gra wraca. Konfiguracja bazy
// jest w firebase-config.js, reguły w database.rules.json.
(function () {
  'use strict';

  const FB_URL = 'vendor/firebase-db.min.js';
  const CFG = window.MLYNEK_FIREBASE || {};
  const ROOM_RE = /^[a-z0-9]{6,12}$/;
  let fbLib = null, fbDb = null;
  const $ = id => document.getElementById(id);

  function configured() { return !!(CFG.databaseURL && /^https?:\/\//.test(CFG.databaseURL)); }

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
    const app = F.initializeApp({ databaseURL: CFG.databaseURL });
    fbDb = F.getDatabase(app);
    if (CFG.emulator) F.connectDatabaseEmulator(fbDb, CFG.emulator.host, CFG.emulator.port);
    return fbDb;
  }

  function randomCode(len) {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    let r = '';
    const v = crypto.getRandomValues(new Uint8Array(len || 6));
    for (const x of v) r += a[x % a.length];
    return r;
  }
  const cleanCode = s => (s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const guestLink = room => location.origin + location.pathname + '?pokoj=' + room;

  // opts:
  //   game        prefiks klucza w localStorage, np. 'mlynek' albo 'szachy'
  //   room, host  kod pokoju i czy jesteśmy gospodarzem
  //   resume      gospodarz: spróbuj odtworzyć stan z localStorage
  //   newState()  stan początkowy gry
  //   validState(s)  czy stan z bazy jest poprawny dla tej gry
  //   onState(s)  przyszedł nowy stan (od przeciwnika lub nowa gra)
  //   onUpdate(r) zmienił się status połączenia
  //   onMsg(t)    wiadomość od przeciwnika inna niż prośba o nową grę
  //   onNotice(text)  krótki komunikat dla gracza
  function createRoom(opts) {
    const room = opts.room, host = !!opts.host;
    const storeKey = opts.game + '-host-' + room;
    const r = {
      room, host, my: 1, seq: 0, state: null,
      up: false, everUp: false, opp: false, closed: false, err: null,
      haveColor: host, connected: false, left: false,
    };
    const unsub = [], msgIds = new Set();
    let ref = null, presRef = null;
    const role = host ? 'h' : 'g', other = host ? 'g' : 'h';

    function save() {
      if (!host) return;
      try { localStorage.setItem(storeKey, JSON.stringify({ state: r.state, seq: r.seq, my: r.my, t: Date.now() })); } catch (e) {}
    }
    function forget() { try { localStorage.removeItem(storeKey); } catch (e) {} }

    if (host) {
      let saved = null;
      if (opts.resume) { try { saved = JSON.parse(localStorage.getItem(storeKey)); } catch (e) {} }
      if (saved && opts.validState(saved.state)) { r.state = saved.state; r.seq = saved.seq; r.my = saved.my; }
      else { r.state = opts.newState(); r.seq = 1; } // nowy pokój – stan początkowy
    } else {
      r.state = opts.newState();
    }

    function notify() {
      r.connected = r.up && r.haveColor && !r.closed && !r.err;
      if (opts.onUpdate) opts.onUpdate(r);
    }
    function fbErr(e) {
      const code = (e && (e.code || e.message)) || '';
      r.err = /permission/i.test(code)
        ? 'Serwer odrzucił połączenie (sprawdź reguły bazy Firebase).'
        : 'Błąd serwera: ' + code;
      notify();
    }

    function write() {
      if (!ref || r.left) return;
      const F = window.MlynekFirebase;
      F.update(ref(''), {
        state: { d: JSON.stringify(r.state), seq: r.seq, hc: host ? r.my : 3 - r.my },
        t: F.serverTimestamp(),
      }).catch(fbErr);
    }

    function accept(m) {
      if (!m || typeof m.seq !== 'number' || !opts.validState(m.s)) return;
      if (m.seq <= r.seq && r.haveColor) return;
      r.seq = m.seq;
      if (m.hc === 1 || m.hc === 2) r.my = host ? m.hc : 3 - m.hc;
      r.haveColor = true; r.closed = false;
      r.state = m.s;
      save();
      opts.onState(r.state);
      notify();
    }

    function onMsg(m) {
      if (!m || !m.id || msgIds.has(m.id)) return;
      msgIds.add(m.id);
      if (m.from === role) return; // własna wiadomość
      if (m.t === 'newreq' && host) {
        if (confirm('Przeciwnik proponuje nową grę. Zgadzasz się?')) r.newGame();
        else r.sendMsg('newno');
      } else if (m.t === 'newno') {
        if (opts.onNotice) opts.onNotice('Przeciwnik odrzucił nową grę.');
      } else if (opts.onMsg) {
        opts.onMsg(m.t);
      }
    }

    r.start = async function () {
      notify();
      if (!configured()) { r.err = 'Gra online nie jest jeszcze skonfigurowana na tej stronie.'; return notify(); }
      if (!ROOM_RE.test(room)) { r.err = 'Nieprawidłowy kod pokoju.'; return notify(); }
      try { await load(); } catch (e) { r.err = e.message; return notify(); }
      if (r.left) return;
      const F = window.MlynekFirebase, d = db();
      ref = p => F.ref(d, 'rooms/' + room + (p ? '/' + p : ''));
      presRef = ref('pres/' + role);

      unsub.push(F.onValue(F.ref(d, '.info/connected'), snap => {
        if (r.left) return;
        r.up = snap.val() === true;
        if (r.up) {
          r.everUp = true;
          // gdy zamkniemy kartę lub stracimy zasięg, serwer sam usunie status "online"
          F.onDisconnect(presRef).remove().catch(() => {});
          F.set(presRef, true).catch(fbErr);
        }
        notify();
      }));

      let firstState = true;
      unsub.push(F.onValue(ref('state'), snap => {
        if (r.left) return;
        const v = snap.val();
        let m = null;
        if (v && typeof v.d === 'string') { try { m = { s: JSON.parse(v.d), seq: v.seq, hc: v.hc }; } catch (e) {} }
        if (firstState) {
          firstState = false;
          // gospodarz: zapisz swój stan, jeśli baza ma starszy (lub pusty)
          if (host && (!m || m.seq < r.seq)) { write(); return; }
        }
        if (!m) {
          if (!host && r.haveColor) { r.closed = true; notify(); }
          return;
        }
        accept(m);
      }, fbErr));

      unsub.push(F.onValue(ref('pres/' + other), snap => {
        if (r.left) return;
        r.opp = snap.val() === true;
        notify();
      }, fbErr));

      let firstMsg = true;
      unsub.push(F.onValue(ref('msg'), snap => {
        if (r.left) return;
        const v = snap.val();
        if (firstMsg) { firstMsg = false; if (v && v.id) msgIds.add(v.id); return; } // stara wiadomość
        if (v) onMsg(v);
      }, fbErr));
    };

    // Zapisz nowy stan gry (po własnym ruchu).
    r.publish = function (state) {
      r.state = state;
      r.seq++;
      save();
      write();
    };

    // Gospodarz: nowa partia, kolory się zamieniają.
    r.newGame = function () {
      if (!host) return;
      r.my = 3 - r.my;
      r.publish(opts.newState());
      opts.onState(r.state);
      notify();
    };

    r.sendMsg = function (t) {
      if (!ref || r.left) return;
      window.MlynekFirebase.set(ref('msg'), { t, id: randomCode(8), from: role }).catch(fbErr);
    };

    // Wyjście z pokoju. Gospodarz usuwa cały pokój z bazy.
    r.leave = function () {
      if (r.left) return;
      r.left = true;
      for (const u of unsub) { try { u(); } catch (e) {} }
      if (ref && window.MlynekFirebase) {
        const F = window.MlynekFirebase;
        F.onDisconnect(presRef).cancel().catch(() => {});
        if (host) { F.remove(ref('')).catch(() => {}); forget(); }
        else F.remove(presRef).catch(() => {});
      }
      r.connected = false;
    };

    r.status = function () {
      const color = r.my === 1 ? 'Grasz białymi.' : 'Grasz czarnymi.';
      if (r.err) return { kind: 'err', text: r.err };
      if (r.closed) return { kind: 'err', text: 'Gospodarz zamknął pokój. Wróć do menu, aby zagrać ponownie.' };
      if (!r.up) return r.everUp
        ? { kind: 'err', text: 'Brak połączenia z internetem – ponawiam…' }
        : { kind: 'wait', text: 'Łączenie z serwerem…' };
      if (!r.haveColor) return { kind: 'wait', text: 'Czekam na gospodarza pokoju… Jeśli to trwa długo, sprawdź, czy link jest poprawny.' };
      if (r.opp) return { kind: 'ok', text: 'Przeciwnik połączony. ' + color };
      return { kind: 'wait', text: (host ? 'Czekam na przeciwnika – wyślij mu link. ' : 'Przeciwnik jest offline. ') + color };
    };

    return r;
  }

  // ---------- wspólne elementy interfejsu (ramka z linkiem i statusem) ----------
  // Oczekiwane id: netBox, led, netText, shareBox, shareLink, roomCode, btnCopy, btnShare.

  function showNetBox(r) {
    $('netBox').classList.remove('hidden');
    $('shareBox').classList.toggle('hidden', !r.host);
    $('roomCode').textContent = r.room;
    $('shareLink').textContent = guestLink(r.room);
    $('btnShare').classList.toggle('hidden', !navigator.share);
  }
  function hideNetBox() { $('netBox').classList.add('hidden'); }

  function renderNet(r) {
    const st = r.status();
    $('led').className = 'led ' + st.kind;
    $('netText').textContent = st.text;
    $('shareBox').classList.toggle('hidden', !r.host || r.opp || !!r.err);
  }

  function setupShare(getRoom, shareText) {
    $('btnCopy').onclick = async () => {
      const link = guestLink(getRoom());
      try { await navigator.clipboard.writeText(link); $('btnCopy').textContent = 'Skopiowano ✓'; }
      catch (e) { prompt('Skopiuj link:', link); }
      setTimeout(() => { $('btnCopy').textContent = 'Kopiuj link'; }, 2000);
    };
    $('btnShare').onclick = () => {
      navigator.share({ title: document.title, text: shareText, url: guestLink(getRoom()) }).catch(() => {});
    };
  }

  function setUrl(url) { try { window.history.replaceState(null, '', url); } catch (e) {} }

  window.GameOnline = {
    ROOM_RE, configured, randomCode, cleanCode, guestLink, createRoom,
    showNetBox, hideNetBox, renderNet, setupShare, setUrl,
  };
})();
