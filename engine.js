// Silnik gry Młynek (Nine Men's Morris) + AI (negamax z alfa-beta).
// Gracze: 1 = białe, 2 = czarne. Pola 0..23.
(function (root) {
  'use strict';

  // Współrzędne pól na siatce 7x7
  const POS = [
    [0, 0], [3, 0], [6, 0],
    [1, 1], [3, 1], [5, 1],
    [2, 2], [3, 2], [4, 2],
    [0, 3], [1, 3], [2, 3], [4, 3], [5, 3], [6, 3],
    [2, 4], [3, 4], [4, 4],
    [1, 5], [3, 5], [5, 5],
    [0, 6], [3, 6], [6, 6],
  ];

  const ADJ = [
    [1, 9], [0, 2, 4], [1, 14],
    [4, 10], [1, 3, 5, 7], [4, 13],
    [7, 11], [4, 6, 8], [7, 12],
    [0, 10, 21], [3, 9, 11, 18], [6, 10, 15], [8, 13, 17], [5, 12, 14, 20], [2, 13, 23],
    [11, 16], [15, 17, 19], [12, 16],
    [10, 19], [16, 18, 20, 22], [13, 19],
    [9, 22], [19, 21, 23], [14, 22],
  ];

  const MILLS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [9, 10, 11], [12, 13, 14], [15, 16, 17], [18, 19, 20], [21, 22, 23],
    [0, 9, 21], [3, 10, 18], [6, 11, 15], [1, 4, 7], [16, 19, 22], [8, 12, 17], [5, 13, 20], [2, 14, 23],
  ];

  const MILLS_OF = Array.from({ length: 24 }, () => []);
  MILLS.forEach(m => m.forEach(i => MILLS_OF[i].push(m)));

  const PIECES = 9;
  const DRAW_PLIES = 100; // tyle ruchów bez zbicia (w fazie przesuwania) = remis

  const opp = p => 3 - p;

  function newState() {
    return {
      b: Array(24).fill(0),
      turn: 1,
      hand: [0, PIECES, PIECES],
      on: [0, 0, 0],
      remove: false,
      winner: 0,
      draw: false,
      quiet: 0,
      ply: 0,
      last: null,        // {from, to} ostatniego ruchu
      lastRemoved: -1,
    };
  }

  function clone(s) {
    return {
      b: s.b.slice(), turn: s.turn, hand: s.hand.slice(), on: s.on.slice(),
      remove: s.remove, winner: s.winner, draw: s.draw, quiet: s.quiet, ply: s.ply,
      last: s.last ? { from: s.last.from, to: s.last.to } : null,
      lastRemoved: s.lastRemoved,
    };
  }

  function inMill(b, i, p) {
    const ms = MILLS_OF[i];
    for (let k = 0; k < ms.length; k++) {
      const m = ms[k];
      if (b[m[0]] === p && b[m[1]] === p && b[m[2]] === p) return true;
    }
    return false;
  }

  function canFly(s, p) { return s.hand[p] === 0 && s.on[p] === 3; }

  // Czy pionek na polu i może zostać zbity przez gracza s.turn
  function removable(s, i) {
    const p = opp(s.turn);
    if (s.b[i] !== p) return false;
    if (!inMill(s.b, i, p)) return true;
    for (let j = 0; j < 24; j++) if (s.b[j] === p && !inMill(s.b, j, p)) return false;
    return true; // wszystkie w młynkach – można zbić dowolny
  }

  function targetsFrom(s, i) {
    const p = s.b[i];
    const res = [];
    if (canFly(s, p)) {
      for (let j = 0; j < 24; j++) if (s.b[j] === 0) res.push(j);
    } else {
      for (const j of ADJ[i]) if (s.b[j] === 0) res.push(j);
    }
    return res;
  }

  function hasMoves(s, p) {
    if (s.hand[p] > 0 || canFly(s, p)) return true;
    for (let i = 0; i < 24; i++) {
      if (s.b[i] !== p) continue;
      for (const j of ADJ[i]) if (s.b[j] === 0) return true;
    }
    return false;
  }

  function baseActions(s) {
    const p = s.turn, res = [];
    if (s.hand[p] > 0) {
      for (let i = 0; i < 24; i++) if (s.b[i] === 0) res.push({ type: 'place', to: i });
    } else {
      for (let i = 0; i < 24; i++) {
        if (s.b[i] !== p) continue;
        for (const j of targetsFrom(s, i)) res.push({ type: 'move', from: i, to: j });
      }
    }
    return res;
  }

  function endTurn(n, captured) {
    n.turn = opp(n.turn);
    n.ply++;
    const movement = n.hand[1] === 0 && n.hand[2] === 0;
    n.quiet = captured || !movement ? 0 : n.quiet + 1;
    const q = n.turn;
    if (n.on[q] + n.hand[q] < 3) n.winner = opp(q);
    else if (!hasMoves(n, q)) n.winner = opp(q);
    else if (n.quiet >= DRAW_PLIES) n.draw = true;
    return n;
  }

  // Zwraca nowy stan albo null, gdy akcja jest niedozwolona
  function apply(s, a) {
    if (s.winner || s.draw || !a) return null;
    const p = s.turn;
    if (a.type === 'remove') {
      if (!s.remove || !removable(s, a.at)) return null;
      const n = clone(s);
      n.b[a.at] = 0;
      n.on[opp(p)]--;
      n.remove = false;
      n.lastRemoved = a.at;
      return endTurn(n, true);
    }
    if (s.remove) return null;
    let n;
    if (a.type === 'place') {
      if (s.hand[p] <= 0 || s.b[a.to] !== 0) return null;
      n = clone(s);
      n.b[a.to] = p; n.hand[p]--; n.on[p]++;
      n.last = { from: -1, to: a.to };
    } else if (a.type === 'move') {
      if (s.hand[p] > 0 || s.b[a.from] !== p || s.b[a.to] !== 0) return null;
      if (!canFly(s, p) && !ADJ[a.from].includes(a.to)) return null;
      n = clone(s);
      n.b[a.from] = 0; n.b[a.to] = p;
      n.last = { from: a.from, to: a.to };
    } else return null;
    n.lastRemoved = -1;
    if (inMill(n.b, a.to, p) && n.on[opp(p)] > 0) {
      n.remove = true;
      return n;
    }
    return endTurn(n, false);
  }

  // ---------- AI ----------

  // Pełne tury (ruch + ewentualne zbicie)
  function turns(s) {
    const res = [];
    for (const a of baseActions(s)) {
      const n = apply(s, a);
      if (!n) continue;
      if (n.remove) {
        for (let i = 0; i < 24; i++) {
          if (removable(n, i)) {
            const r = { type: 'remove', at: i };
            res.push({ a, r, s: apply(n, r) });
          }
        }
      } else res.push({ a, r: null, s: n });
    }
    return res;
  }

  function mobility(s, p) {
    let m = 0, blocked = 0;
    for (let i = 0; i < 24; i++) {
      if (s.b[i] !== p) continue;
      let k = 0;
      for (const j of ADJ[i]) if (s.b[j] === 0) k++;
      m += k;
      if (k === 0) blocked++;
    }
    return { m, blocked };
  }

  function evaluate(s, p) {
    const o = opp(p);
    let score = 120 * ((s.on[p] + s.hand[p]) - (s.on[o] + s.hand[o]));
    let open = 0, mills = 0;
    for (const m of MILLS) {
      let cp = 0, co = 0, ce = 0;
      for (const i of m) { if (s.b[i] === p) cp++; else if (s.b[i] === o) co++; else ce++; }
      if (cp === 3) mills++; else if (co === 3) mills--;
      if (cp === 2 && ce === 1) open++; else if (co === 2 && ce === 1) open--;
    }
    score += 12 * open + 8 * mills;
    const placing = s.hand[1] > 0 || s.hand[2] > 0;
    const mp = mobility(s, p), mo = mobility(s, o);
    if (!canFly(s, p) && !canFly(s, o)) {
      score += (placing ? 1 : 4) * (mp.m - mo.m);
      score += (placing ? 2 : 8) * (mo.blocked - mp.blocked);
    }
    // ruch strony do ruchu daje lekką przewagę
    return score;
  }

  const WIN = 100000;
  class Timeout extends Error {}

  function negamax(s, depth, alpha, beta, dist, ctx) {
    if (s.winner) return s.winner === s.turn ? WIN - dist : -(WIN - dist);
    if (s.draw) return 0;
    if (depth === 0) return evaluate(s, s.turn);
    if ((++ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw new Timeout();
    const ts = turns(s);
    if (ts.length === 0) return -(WIN - dist);
    // zbicia najpierw
    ts.sort((x, y) => (y.r ? 1 : 0) - (x.r ? 1 : 0));
    let best = -Infinity;
    for (const t of ts) {
      const v = -negamax(t.s, depth - 1, -beta, -alpha, dist + 1, ctx);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // level: 'easy' | 'medium' | 'hard'
  function bestTurn(s, level) {
    const ts = shuffle(turns(s));
    if (ts.length === 0) return null;
    if (level === 'easy') {
      if (Math.random() < 0.35) return ts[0];
      let best = ts[0], bv = -Infinity;
      for (const t of ts) {
        const v = -negamax(t.s, 1, -Infinity, Infinity, 1, { nodes: 0, deadline: Infinity }) + Math.random() * 60;
        if (v > bv) { bv = v; best = t; }
      }
      return best;
    }
    const maxDepth = level === 'hard' ? 10 : 3;
    const ctx = { nodes: 0, deadline: Date.now() + (level === 'hard' ? 1800 : 700) };
    let best = ts[0];
    let order = ts;
    for (let d = 1; d <= maxDepth; d++) {
      let alpha = -Infinity, bestHere = null;
      const scored = [];
      try {
        for (const t of order) {
          const v = -negamax(t.s, d - 1, -Infinity, -alpha, 1, ctx);
          scored.push([v, t]);
          if (v > alpha) { alpha = v; bestHere = t; }
        }
      } catch (e) {
        if (e instanceof Timeout) break;
        throw e;
      }
      best = bestHere || best;
      if (alpha >= WIN - 50) break; // znaleziona wygrana
      // najlepsze ruchy na początek w kolejnej iteracji
      scored.sort((x, y) => y[0] - x[0]);
      order = scored.map(x => x[1]);
    }
    return best;
  }

  const api = { POS, ADJ, MILLS, PIECES, opp, newState, clone, apply, removable, targetsFrom, canFly, inMill, bestTurn, turns, evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mlynek = api;
})(this);
