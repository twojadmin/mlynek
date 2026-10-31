// Przeciwnik komputerowy w Go i podpowiedź martwych kamieni przy liczeniu.
// Metoda Monte Carlo (MCTS/UCT): z bieżącej pozycji rozgrywa wiele losowych
// partii i wybiera ruch, który najczęściej prowadził do wygranej.
// Działa jako Web Worker (go.html); w Node.js można go załadować przez require().
(function () {
  'use strict';
  const isWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (isWorker) importScripts('go-engine.js');
  const E = isWorker ? self.GoEngine
    : (typeof module !== 'undefined' && module.exports ? require('./go-engine.js') : window.GoEngine);

  // Proste oko: wszyscy sąsiedzi w kolorze c i co najwyżej jeden zły róg (na brzegu żaden).
  function isEye(g, p, c) {
    const b = g.b, n = g.n;
    for (const q of g.nb[p]) if (b[q] !== c) return false;
    const x = p % n, y = (p / n) | 0;
    const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
    let bad = 0;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      if (b[yy * n + xx] === 3 - c) bad++;
    }
    return edge ? bad === 0 : bad < 2;
  }

  function candidates(g) {
    const out = [], b = g.b;
    for (let i = 0; i < b.length; i++) if (b[i] === 0 && i !== g.ko && !isEye(g, i, g.turn)) out.push(i);
    return out;
  }

  // Losowa partia do końca (dwa pasy). Modyfikuje g.
  function playout(g) {
    const limit = g.n * g.n * 3;
    for (let k = 0; k < limit && g.passes < 2; k++) {
      const c = candidates(g);
      let played = false;
      while (c.length) {
        const i = (Math.random() * c.length) | 0;
        if (g.play(c[i])) { played = true; break; }
        c[i] = c[c.length - 1]; c.pop();
      }
      if (!played) g.play(-1);
    }
    const s = g.score(null);
    return { winner: s.b > s.w ? 1 : 2, owner: s.owner };
  }

  // Szacuje martwe kamienie: grupy, których punkty w losowych partiach
  // przeważnie należą do przeciwnika.
  function estimateDead(g, playouts) {
    const n2 = g.n * g.n, own = new Float32Array(n2);
    for (let k = 0; k < playouts; k++) {
      const r = playout(g.clone());
      for (let i = 0; i < n2; i++) if (r.owner[i] === g.b[i] && g.b[i]) own[i]++;
    }
    const dead = [], seen = new Uint8Array(n2);
    for (let i = 0; i < n2; i++) {
      if (!g.b[i] || seen[i]) continue;
      const grp = g.group(i).stones;
      let sum = 0;
      for (const s of grp) { seen[s] = 1; sum += own[s]; }
      if (sum / grp.length / playouts < 0.4) dead.push(...grp);
    }
    return dead;
  }

  const LEVELS = {
    easy: { playouts: 250, time: 1e9, c: 1.4 },
    medium: { playouts: 1e9, time: 1200, c: 1.1 },
    hard: { playouts: 1e9, time: 3000, c: 0.9 },
  };

  function bestMove(size, moves, level) {
    const L = LEVELS[level] || LEVELS.medium;
    const g = E.replay(size, moves);
    const me = g.turn;
    const n2 = size * size;
    const played = moves.split(' ').filter(Boolean).length;

    // Przeciwnik spasował: jeśli liczenie (z martwymi kamieniami) daje nam wygraną – też pasujemy.
    if (played > 0 && g.last === -1 && g.passes === 1) {
      const s = g.score(estimateDead(g, size === 9 ? 200 : 80));
      if ((me === 1 && s.b > s.w) || (me === 2 && s.w > s.b)) return '--';
    }

    const cands = candidates(g).filter(p => g.isLegal(p));
    if (!cands.length) return '--';
    // Pas jako opcja tylko pod koniec gry albo gdy przeciwnik spasował.
    const allowPass = cands.length <= size || (played > 0 && g.last === -1);
    const root = { visits: 0, kids: cands.map(p => ({ p, w: 0, v: 0, kids: null })) };
    if (allowPass) root.kids.push({ p: -1, w: 0, v: 0, kids: null });

    const deadline = Date.now() + L.time;
    for (let it = 0; it < L.playouts; it++) {
      if ((it & 15) === 0 && Date.now() > deadline) break;
      // Selekcja na jednym poziomie (UCT), dalej losowa partia.
      let best = null, bv = -Infinity;
      const lnN = Math.log(root.visits + 1);
      for (const k of root.kids) {
        const v = k.v === 0 ? 1e9 + Math.random() : k.w / k.v + L.c * Math.sqrt(lnN / k.v);
        if (v > bv) { bv = v; best = k; }
      }
      const sim = g.clone();
      sim.play(best.p);
      const r = playout(sim);
      best.v++; root.visits++;
      if (r.winner === me) best.w++;
    }
    let pick = root.kids[0];
    for (const k of root.kids) if (k.v > pick.v) pick = k;
    // Beznadziejna pozycja pod koniec gry – pasuj zamiast grać bez sensu.
    if (pick.p !== -1 && pick.v > 20 && pick.w / pick.v < 0.03 && played > n2 / 2) return '--';
    return E.encode(pick.p, size);
  }

  function deadStones(size, moves) {
    const g = E.replay(size, moves);
    return estimateDead(g, size === 9 ? 300 : size === 13 ? 150 : 70).map(p => E.encode(p, size));
  }

  if (isWorker) {
    self.onmessage = e => {
      const d = e.data;
      try {
        if (d.type === 'dead') self.postMessage({ id: d.id, dead: deadStones(d.size, d.moves) });
        else self.postMessage({ id: d.id, move: bestMove(d.size, d.moves, d.level) });
      } catch (err) {
        self.postMessage({ id: d.id, move: null, dead: [] });
      }
    };
  }
  const api = { bestMove, deadStones, isEye };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (!isWorker && typeof window !== 'undefined') window.GoAI = api;
})();
