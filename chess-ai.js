// Przeciwnik komputerowy w szachach. Działa jako Web Worker (szachy.html),
// a w Node.js można go załadować przez require() do testów.
//
// Przeszukiwanie: negamax z cięciami alfa-beta, iteracyjne pogłębianie z limitem
// czasu i wyszukiwanie spokojne (bicia), ocena: materiał + tablice pozycyjne
// (tzw. „simplified evaluation function” Tomasza Michniewskiego).
// Dla szybkości używa wewnętrznych metod chess.js 1.4.0 (_moves, _makeMove,
// _undoMove, _board, _turn, _isKingAttacked, _halfMoves) – wersja biblioteki
// jest zamrożona w vendor/chess.min.js.
(function () {
  'use strict';
  const isWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (isWorker) { self.window = self; importScripts('vendor/chess.min.js'); }
  const Chess = (typeof window !== 'undefined' ? window : globalThis).Chess;

  const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  // Tablice z perspektywy białych, indeks 0 = a8 … 63 = h1.
  const PST = {
    p: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5,
      0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    n: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    b: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    r: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    k: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30,
      -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
    ke: [-50, -40, -30, -20, -20, -30, -40, -50, -30, -20, -10, 0, 0, -10, -20, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -10, 30, 40, 40, 30, -10, -30,
      -30, -10, 30, 40, 40, 30, -10, -30, -30, -10, 20, 30, 30, 20, -10, -30, -30, -30, 0, 0, 0, 0, -30, -30, -50, -30, -30, -30, -30, -30, -30, -50],
  };
  const MATE = 100000;
  const TIMEOUT = {};

  // Ocena z perspektywy strony, która ma ruch.
  function evaluate(c) {
    const B = c._board;
    let heavy = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = B[sq];
      if (p && p.type !== 'p' && p.type !== 'k') heavy += VAL[p.type];
    }
    const endgame = heavy <= 1400;
    let s = 0;
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = B[sq];
      if (!p) continue;
      const row = sq >> 4, col = sq & 7;
      const i = p.color === 'w' ? row * 8 + col : (7 - row) * 8 + col;
      const t = p.type === 'k' && endgame ? 'ke' : p.type;
      const v = VAL[p.type] + PST[t][i];
      s += p.color === 'w' ? v : -v;
    }
    return c._turn === 'w' ? s : -s;
  }

  function orderScore(m) {
    let s = 0;
    if (m.captured) s += 10 * VAL[m.captured] - VAL[m.piece] + 10000;
    if (m.promotion) s += VAL[m.promotion] + 9000;
    return s;
  }

  let nodes = 0, deadline = Infinity;

  function quiesce(c, alpha, beta, qd) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;
    const stand = evaluate(c);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (qd <= 0) return alpha;
    const ms = c._moves().filter(m => m.captured || m.promotion);
    ms.sort((a, b) => orderScore(b) - orderScore(a));
    for (const m of ms) {
      c._makeMove(m);
      const v = -quiesce(c, -beta, -alpha, qd - 1);
      c._undoMove();
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function search(c, depth, alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;
    if (depth <= 0) return quiesce(c, alpha, beta, 6);
    const ms = c._moves();
    if (!ms.length) return c._isKingAttacked(c._turn) ? -MATE + ply : 0;
    if (c._halfMoves >= 100) return 0;
    ms.sort((a, b) => orderScore(b) - orderScore(a));
    let best = -Infinity;
    for (const m of ms) {
      c._makeMove(m);
      const v = -search(c, depth - 1, -beta, -alpha, ply + 1);
      c._undoMove();
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return best;
  }

  const SQ = s => 'abcdefgh'[s & 15] + (8 - (s >> 4));
  const uci = m => SQ(m.from) + SQ(m.to) + (m.promotion || '');

  const LEVELS = {
    easy: { maxDepth: 1, time: 400, noise: 140, random: 0.2 },
    medium: { maxDepth: 3, time: 1200, noise: 25, random: 0 },
    hard: { maxDepth: 8, time: 2500, noise: 6, random: 0 },
  };

  // moves: ruchy partii w formacie UCI oddzielone spacją. Zwraca ruch UCI albo null.
  function bestMove(moves, level) {
    const L = LEVELS[level] || LEVELS.medium;
    const c = new Chess();
    for (const u of moves.split(' ')) if (u) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    const root = c._moves();
    if (!root.length) return null;
    if (root.length === 1) return uci(root[0]);
    if (Math.random() < L.random) return uci(root[Math.floor(Math.random() * root.length)]);

    nodes = 0;
    deadline = Date.now() + L.time;
    // losowy szum przy ruchach z korzenia – urozmaica partie i osłabia łatwiejsze poziomy
    const noise = new Map(root.map(m => [m, (Math.random() * 2 - 1) * L.noise]));
    let order = root.slice().sort((a, b) => orderScore(b) - orderScore(a));
    let best = order[0];
    for (let d = 1; d <= L.maxDepth; d++) {
      const scored = [];
      let alpha = -Infinity, bestHere = null;
      try {
        for (const m of order) {
          c._makeMove(m);
          let v;
          // okno poszerzone o szum, żeby ruch z korzystnym szumem nie został odcięty
          try { v = -search(c, d - 1, -Infinity, -(alpha - 2 * L.noise), 1); } finally { c._undoMove(); }
          v += noise.get(m);
          scored.push([v, m]);
          if (v > alpha) { alpha = v; bestHere = m; }
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        // przerwana iteracja: pierwszy był najlepszy ruch z poprzedniej, więc wynik
        // częściowy jest wiarygodny – jeśli inny ruch go pobił, bierzemy go
        if (bestHere && d > 1) best = bestHere;
        break;
      }
      best = bestHere || best;
      if (alpha > MATE - 100) break; // znaleziony mat
      scored.sort((x, y) => y[0] - x[0]);
      order = scored.map(x => x[1]);
      if (Date.now() > deadline) break;
    }
    return uci(best);
  }

  if (isWorker) {
    self.onmessage = e => {
      const { id, moves, level } = e.data;
      let move = null;
      try { move = bestMove(moves, level); } catch (err) { move = null; }
      self.postMessage({ id, move });
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { bestMove, evaluate };
  else if (!isWorker && typeof window !== 'undefined') window.ChessAI = { bestMove };
})();
