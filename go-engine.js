// Silnik zasad gry Go: bicie, zakaz samobójstwa, ko (proste), pasy,
// liczenie punktów metodą obszarową (kamienie + terytorium) z komi.
// Działa w przeglądarce (window.GoEngine), w Web Workerze i w Node.js.
(function (root) {
  'use strict';
  const LETTERS = 'abcdefghijklmnopqrs';
  const KOMI = 7.5;
  const SIZES = [9, 13, 19];
  const nbrCache = {};

  function neighbors(n) {
    if (nbrCache[n]) return nbrCache[n];
    const a = [];
    for (let i = 0; i < n * n; i++) {
      const x = i % n, y = (i / n) | 0, l = [];
      if (x > 0) l.push(i - 1);
      if (x < n - 1) l.push(i + 1);
      if (y > 0) l.push(i - n);
      if (y < n - 1) l.push(i + n);
      a.push(l);
    }
    return (nbrCache[n] = a);
  }

  // Kodowanie ruchu: 'ab' = kolumna a, wiersz b; pas = '--'.
  const encode = (p, n) => (p < 0 ? '--' : LETTERS[p % n] + LETTERS[(p / n) | 0]);
  function decode(s, n) {
    if (s === '--') return -1;
    const x = LETTERS.indexOf(s[0]), y = LETTERS.indexOf(s[1]);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;
    return y * n + x;
  }

  class Go {
    constructor(n) {
      this.n = n;
      this.b = new Int8Array(n * n); // 0 puste, 1 czarne, 2 białe
      this.turn = 1;                 // zaczynają czarne
      this.ko = -1;
      this.caps = [0, 0, 0];         // jeńcy zdobyci przez czarne [1] i białe [2]
      this.passes = 0;
      this.last = -1;
      this.nb = neighbors(n);
      this.mark = new Int32Array(n * n);
      this.stamp = 0;
    }
    clone() {
      const g = new Go(this.n);
      g.b.set(this.b); g.turn = this.turn; g.ko = this.ko; g.caps = this.caps.slice();
      g.passes = this.passes; g.last = this.last;
      return g;
    }
    // Zwraca grupę zawierającą p i liczbę jej oddechów (do limitu `upTo`).
    group(p, upTo) {
      const b = this.b, nb = this.nb, color = b[p];
      const st = ++this.stamp, mark = this.mark;
      const stones = [p], libsSeen = [];
      mark[p] = st;
      let libs = 0;
      for (let k = 0; k < stones.length; k++) {
        const ns = nb[stones[k]];
        for (let j = 0; j < ns.length; j++) {
          const q = ns[j];
          if (mark[q] === st) continue;
          const c = b[q];
          if (c === color) { mark[q] = st; stones.push(q); }
          else if (c === 0) { mark[q] = st; libs++; libsSeen.push(q); if (upTo && libs >= upTo) return { stones, libs, libsAt: libsSeen }; }
        }
      }
      return { stones, libs, libsAt: libsSeen };
    }
    // Wykonuje ruch (p = -1 to pas). Zwraca false, jeśli ruch jest niedozwolony.
    play(p) {
      if (p === -1) {
        this.passes++; this.turn = 3 - this.turn; this.ko = -1; this.last = -1;
        return true;
      }
      const b = this.b;
      if (p < 0 || p >= b.length || b[p] !== 0 || p === this.ko) return false;
      const color = this.turn, opp = 3 - color;
      b[p] = color;
      let captured = 0, capPoint = -1;
      const ns = this.nb[p];
      for (let j = 0; j < ns.length; j++) {
        const q = ns[j];
        if (b[q] !== opp) continue;
        const g = this.group(q, 1);
        if (g.libs === 0) {
          for (const s of g.stones) b[s] = 0;
          captured += g.stones.length;
          capPoint = g.stones[0];
        }
      }
      const own = this.group(p, 2);
      if (own.libs === 0) { b[p] = 0; return false; } // samobójstwo
      this.ko = captured === 1 && own.stones.length === 1 && own.libs === 1 ? capPoint : -1;
      this.caps[color] += captured;
      this.passes = 0;
      this.turn = opp;
      this.last = p;
      return true;
    }
    isLegal(p) {
      if (p === -1) return true;
      if (this.b[p] !== 0 || p === this.ko) return false;
      return this.clone().play(p);
    }
    // Liczenie obszarowe. dead: zbiór punktów z martwymi kamieniami.
    // Zwraca { b, w, owner } – owner[i]: 1/2 właściciel punktu, 0 neutralny.
    score(dead, komi) {
      const n = this.n, b = Int8Array.from(this.b), nb = this.nb;
      if (dead) for (const p of dead) b[p] = 0;
      const owner = new Int8Array(n * n), seen = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) {
        if (b[i]) { owner[i] = b[i]; continue; }
        if (seen[i]) continue;
        const region = [i]; seen[i] = 1;
        let touch = 0;
        for (let k = 0; k < region.length; k++) {
          for (const q of nb[region[k]]) {
            if (b[q]) touch |= b[q];
            else if (!seen[q]) { seen[q] = 1; region.push(q); }
          }
        }
        const o = touch === 1 ? 1 : touch === 2 ? 2 : 0;
        for (const r of region) owner[r] = o;
      }
      let sb = 0, sw = 0;
      for (let i = 0; i < n * n; i++) { if (owner[i] === 1) sb++; else if (owner[i] === 2) sw++; }
      return { b: sb, w: sw + (komi == null ? KOMI : komi), owner };
    }
  }

  // Odtwarza partię z zapisu ruchów; rzuca wyjątek przy nielegalnym ruchu.
  function replay(size, moves) {
    const g = new Go(size);
    for (const m of moves.split(' ')) {
      if (!m) continue;
      const p = decode(m, size);
      if (p === null || !g.play(p)) throw new Error('Nielegalny ruch: ' + m);
    }
    return g;
  }

  const api = { Go, LETTERS, KOMI, SIZES, encode, decode, replay, neighbors };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoEngine = api;
})(typeof self !== 'undefined' ? self : this);
