'use strict';
// Wyścigi klocków – logika gry: tor losowy, świat z bloków, fizyka gokartów,
// przeszkody i bonusy, komputerowi kierowcy, podzielony ekran dla dwóch graczy.
(function () {
  const BG = window.BlockGL;
  const { T, B, CHARS, MeshBuilder, buildWorldChunks, M, rng, hex } = BG;

  // ---------- stałe ----------
  // K – ile bloków przypada na „metr” pojazdu: większe K = mniejsze klocki względem aut
  const K = 1.6;
  const VS = 1.15;              // skala pojazdów i postaci (mniejsza niż K – auta mniejsze względem świata)
  const SPD = K * 1.35;         // skala prędkości (szybciej – w stylu wyścigów ulicznych)
  const HW = 9.6;               // pół szerokości jezdni (w blokach)
  const WALL = HW + 6;          // odległość bandy od środka toru
  const Y0 = 4, HY = 30, CH = 16;
  const STEP = 1 / 60;
  const FINISH_WAIT = 45;       // ile sekund po pierwszym na mecie czekają pozostali gracze
  const S_ROAD = 0, S_OFF = 1, S_MUD = 2, S_OIL = 3, S_SLIME = 4, S_WATER = 5, S_ICE = 6;
  const ITEMS = {
    turbo: { icon: '⚡', name: 'Turbo' },
    tarcza: { icon: '🛡️', name: 'Tarcza' },
    tnt: { icon: '🧨', name: 'TNT' },
    skok: { icon: '🦘', name: 'Skok' }
  };
  const THEMES = {
    laka: {
      name: 'Łąka', sky: [0.56, 0.78, 0.98], top: B.grass, sub: B.dirt, road: B.asphalt, wall: B.hay, pile: B.cobble,
      slick: B.oil, slickSurf: S_OIL, lake: B.water, lakeSurf: S_WATER, lakeLevel: 0.3, tree: 'oak', treeP: 0.011,
      plants: [B.flower_r, B.flower_y, B.tallgrass, B.tallgrass, B.tallgrass], plantP: 0.12, peak: B.stone,
      sea: [0.22, 0.4, 0.82], mapBg: '#5da83a', mapRoad: '#4c4c52', dust: [0.55, 0.42, 0.28]
    },
    pustynia: {
      name: 'Pustynia', sky: [0.74, 0.84, 0.95], top: B.sand, sub: B.sand, road: B.road_desert, wall: B.sandstone, pile: B.sandstone,
      slick: B.oil, slickSurf: S_OIL, lake: B.water, lakeSurf: S_WATER, lakeLevel: 0.17, tree: 'cactus', treeP: 0.008,
      plants: [B.deadbush], plantP: 0.035, peak: B.sandstone,
      sea: [0.86, 0.8, 0.56], mapBg: '#e2d394', mapRoad: '#a8743e', dust: [0.9, 0.82, 0.58]
    },
    zima: {
      name: 'Zima', sky: [0.78, 0.85, 0.93], top: B.snow, sub: B.dirt, road: B.cobble, wall: B.snowblock, pile: B.ice,
      slick: B.ice, slickSurf: S_ICE, lake: B.ice, lakeSurf: S_ICE, lakeLevel: 0.28, tree: 'pine', treeP: 0.013,
      plants: [], plantP: 0, peak: B.snowblock,
      sea: [0.78, 0.88, 0.96], mapBg: '#eef4f8', mapRoad: '#7a7a7a', dust: [0.97, 0.98, 1]
    }
  };

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
  const col01 = h => hex(h).map(v => v / 255);

  // ---------- szum ----------
  function makeNoise(seed) {
    const hs = (x, z) => { const s = Math.sin(x * 127.1 + z * 311.7 + seed * 0.0137) * 43758.5453; return s - Math.floor(s); };
    const sm = t => t * t * (3 - 2 * t);
    function vn(x, z) {
      const ix = Math.floor(x), iz = Math.floor(z), fx = sm(x - ix), fz = sm(z - iz);
      const a = hs(ix, iz), b = hs(ix + 1, iz), c = hs(ix, iz + 1), d = hs(ix + 1, iz + 1);
      return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
    }
    return (x, z) => (vn(x, z) * 0.6 + vn(x * 2.1 + 17, z * 2.1 + 5) * 0.28 + vn(x * 4.3 + 3, z * 4.3 + 41) * 0.12);
  }

  // ---------- tor ----------
  // shape: 0 – łagodny, 1 – kręty, 2 – bardzo kręty
  const SHAPES = [
    { n: [7, 13], R: [52, 78], rad: [0.45, 1], smooth: true, warp: 0, curv: 0.5, len: [280, 800] },
    { n: [9, 15], R: [58, 86], rad: [0.32, 1], smooth: true, warp: [5, 9], curv: 0.55, len: [330, 1000] },
    { n: [11, 18], R: [66, 96], rad: [0.25, 1], smooth: false, warp: [8, 14], curv: 0.6, len: [400, 1250] }
  ];
  function resample(pts, closedStep) {
    let total = 0;
    const L = pts.length;
    const segL = pts.map((p, i) => { const q = pts[(i + 1) % L]; const l = Math.hypot(q[0] - p[0], q[1] - p[1]); total += l; return l; });
    const N = Math.max(3, Math.floor(total / closedStep));
    const step = total / N, out = [];
    let si = 0, acc = 0;
    for (let k = 0; k < N; k++) {
      const want = k * step;
      while (si < L - 1 && acc + segL[si] < want) { acc += segL[si]; si++; }
      const p = pts[si], q = pts[(si + 1) % L], f = segL[si] ? (want - acc) / segL[si] : 0;
      out.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]);
    }
    return out;
  }
  function genTrack(seed, shape) {
    shape = shape || 0;
    const S = SHAPES[shape];
    const rr = (r, a) => a[0] + r() * (a[1] - a[0]);
    for (let attempt = 0; attempt < 300; attempt++) {
      const r = rng(seed * 7919 + attempt * 104729 + 3 + shape * 7777);
      const n = Math.floor(rr(r, [S.n[0], S.n[1] + 1]));
      const R = rr(r, S.R);
      const sx = 0.75 + r() * 0.55, sz = 0.75 + r() * 0.55;
      let rad = [];
      for (let i = 0; i < n; i++) rad.push(R * rr(r, S.rad));
      if (S.smooth) rad = rad.map((v, i) => (v * 2 + rad[(i + 1) % n] + rad[(i + n - 1) % n]) / 4);
      const rot = r() * Math.PI * 2;
      const cp = [];
      for (let i = 0; i < n; i++) {
        const a = rot + (i + (r() - 0.5) * 0.55) / n * Math.PI * 2;
        cp.push([Math.cos(a) * rad[i] * sx, Math.sin(a) * rad[i] * sz]);
      }
      // Catmull-Rom (centrypetalny) – gładka zamknięta pętla
      let dense = [];
      for (let i = 0; i < n; i++) {
        const p0 = cp[(i + n - 1) % n], p1 = cp[i], p2 = cp[(i + 1) % n], p3 = cp[(i + 2) % n];
        const t01 = Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0.5) || 1e-3;
        const t12 = Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 0.5) || 1e-3;
        const t23 = Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 0.5) || 1e-3;
        for (let s = 0; s < 24; s++) {
          const t = s / 24;
          const pt = [];
          for (let k = 0; k < 2; k++) {
            const m1 = (p2[k] - p1[k] + t12 * ((p1[k] - p0[k]) / t01 - (p2[k] - p0[k]) / (t01 + t12)));
            const m2 = (p2[k] - p1[k] + t12 * ((p3[k] - p2[k]) / t23 - (p3[k] - p1[k]) / (t12 + t23)));
            const a = 2 * p1[k] - 2 * p2[k] + m1 + m2, b = -3 * p1[k] + 3 * p2[k] - 2 * m1 - m2;
            pt.push(a * t * t * t + b * t * t + m1 * t + p1[k]);
          }
          dense.push(pt);
        }
      }
      dense = resample(dense, 1);
      // fale w poprzek toru – esy-floresy i szykany
      if (S.warp) {
        const A = rr(r, S.warp), f1 = 3 + Math.floor(r() * 6), f2 = 7 + Math.floor(r() * 8);
        const p1 = r() * 6.28, p2 = r() * 6.28, mix = 0.35 + r() * 0.3;
        const D = dense.length;
        dense = dense.map((p, i) => {
          const a = dense[(i + D - 2) % D], b = dense[(i + 2) % D];
          let tx = b[0] - a[0], tz = b[1] - a[1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
          const s = i / D * Math.PI * 2;
          const o = A * ((1 - mix) * Math.sin(s * f1 + p1) + mix * Math.sin(s * f2 + p2));
          return [p[0] + tz * o, p[1] - tx * o];
        });
      }
      // wygładzanie
      for (let pass = 0; pass < 4; pass++) {
        const D = dense.length;
        dense = dense.map((p, i) => {
          let x = 0, z = 0;
          for (let k = -3; k <= 3; k++) { const q = dense[(i + k + D) % D]; x += q[0]; z += q[1]; }
          return [x / 7, z / 7];
        });
      }
      const pts = resample(dense, 1);
      const N = pts.length;
      if (N < S.len[0] || N > S.len[1]) continue;
      if (!validTrack(pts, S.curv)) continue;
      const t = finishTrack(resample(pts.map(p => [p[0] * K, p[1] * K]), 1), seed);
      t.shape = shape;
      return t;
    }
    if (shape > 0) return genTrack(seed, shape - 1);
    // awaryjnie: elipsa
    const pts = [];
    for (let k = 0; k < 640; k++) { const a = k / 640 * Math.PI * 2; pts.push([Math.cos(a) * 80 * K, Math.sin(a) * 45 * K]); }
    const t = finishTrack(pts, seed);
    t.shape = 0;
    return t;
  }
  function validTrack(p, maxCurv) {
    const N = p.length;
    for (let i = 0; i < N; i++) {
      const a = p[(i + N - 4) % N], b = p[i], c = p[(i + 4) % N];
      const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
      if (Math.abs(angDiff(h2, h1)) > maxCurv) return false; // za ciasny zakręt
    }
    const minD = (2 * WALL / K + 4) ** 2; // tor generowany w „metrach”, potem skalowany o K
    for (let i = 0; i < N; i += 2) for (let j = i + 2; j < N; j += 2) {
      const di = Math.min(j - i, N - (j - i));
      if (di < 36) continue;
      const dx = p[i][0] - p[j][0], dz = p[i][1] - p[j][1];
      if (dx * dx + dz * dz < minD) return false;
    }
    return true;
  }
  function finishTrack(pts, seed) {
    let N = pts.length;
    // kierunek i krzywizna
    const heading = i => { const a = pts[(i + N - 1) % N], b = pts[(i + 1) % N]; return Math.atan2(b[0] - a[0], b[1] - a[1]); };
    const curvAt = i => Math.abs(angDiff(heading((i + 13) % N), heading((i + N - 13) % N)));
    // start w środku najdłuższej prostej
    let best = 0, bestV = Infinity;
    for (let i = 0; i < N; i += 2) {
      let s = 0;
      for (let k = -48; k <= 20; k += 4) s += curvAt((i + k + N) % N);
      if (s < bestV) { bestV = s; best = i; }
    }
    pts = pts.slice(best).concat(pts.slice(0, best));
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const margin = 54;
    const W = Math.ceil(maxX - minX + 2 * margin), D = Math.ceil(maxZ - minZ + 2 * margin);
    const X = new Float32Array(N), Z = new Float32Array(N), TX = new Float32Array(N), TZ = new Float32Array(N);
    const NX = new Float32Array(N), NZ = new Float32Array(N), HD = new Float32Array(N), CURV = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = pts[i][0] - minX + margin; Z[i] = pts[i][1] - minZ + margin; }
    for (let i = 0; i < N; i++) {
      const a = (i + N - 1) % N, b = (i + 1) % N;
      let tx = X[b] - X[a], tz = Z[b] - Z[a]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      TX[i] = tx; TZ[i] = tz; NX[i] = tz; NZ[i] = -tx; HD[i] = Math.atan2(tx, tz);
    }
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = 6; k <= 42; k += 6) m = Math.max(m, Math.abs(angDiff(HD[(i + k) % N], HD[i])));
      CURV[i] = m;
    }
    return { seed, N, X, Z, TX, TZ, NX, NZ, HD, CURV, W, D };
  }

  // ---------- trasy otwarte: z punktu A do B i bez końca ----------
  // Trasa ciągnie się w jednym głównym kierunku; zakręty to płynne zmiany odchylenia (do ~75°),
  // więc droga nigdy nie zawraca. Każdy nowy odcinek jest sprawdzany, czy nie zbliża się do wcześniejszych.
  const START_K = 70;           // linia startu (wcześniejsze punkty: miejsce na ustawienie aut)
  const RUNOFF = 70;            // droga za metą (A→B)
  const OPEN_SHAPE = [
    { amp: 0.7, hold: [60, 200], trans: [50, 110] },
    { amp: 1.05, hold: [30, 140], trans: [35, 90] },
    { amp: 1.3, hold: [12, 80], trans: [24, 60] }
  ];
  function makeOpenTrack(seed, shape, mode, len) {
    const cap = mode === 'ab' ? START_K + len + RUNOFF + 600 : 300000;
    const r = rng(seed * 4099 + shape * 31 + (mode === 'ab' ? 7 : 13));
    const base = r() * Math.PI * 2;
    const t = {
      loop: false, mode, seed, shape, N: 0, cap,
      X: new Float32Array(cap), Z: new Float32Array(cap), TX: new Float32Array(cap), TZ: new Float32Array(cap),
      NX: new Float32Array(cap), NZ: new Float32Array(cap), HD: new Float32Array(cap), CURV: new Float32Array(cap),
      gen: { r, base, x: 0, z: 0, off: 0, curvDone: 0 }, hash: new Map()
    };
    if (mode === 'ab') {
      extendTrack(t, START_K + len + RUNOFF);
      t.finishK = t.N - RUNOFF;
    } else extendTrack(t, 2200);
    t.startK = START_K;
    return t;
  }
  function trackPush(t, x, z, h) {
    const k = t.N++;
    t.X[k] = x; t.Z[k] = z; t.HD[k] = h;
    const tx = Math.sin(h), tz = Math.cos(h);
    t.TX[k] = tx; t.TZ[k] = tz; t.NX[k] = tz; t.NZ[k] = -tx;
    const key = Math.floor(x / 32) + ',' + Math.floor(z / 32);
    let b = t.hash.get(key); if (!b) t.hash.set(key, b = []);
    b.push(k);
  }
  function trackClear(t, n) {
    for (let k = t.N - 1; k >= n; k--) {
      const b = t.hash.get(Math.floor(t.X[k] / 32) + ',' + Math.floor(t.Z[k] / 32));
      if (b) b.pop();
    }
    t.N = n;
  }
  function tooClose(t, x, z, k) {
    const minD = (2 * WALL + 10) ** 2;
    const gx = Math.floor(x / 32), gz = Math.floor(z / 32);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const b = t.hash.get((gx + dx) + ',' + (gz + dz));
      if (!b) continue;
      for (const j of b) if (j < k - 140 && (t.X[j] - x) ** 2 + (t.Z[j] - z) ** 2 < minD) return true;
    }
    return false;
  }
  function extendTrack(t, upto) {
    upto = Math.min(upto, t.cap - 2);
    const g = t.gen, S = OPEN_SHAPE[t.shape || 0];
    if (t.N === 0) { trackPush(t, 0, 0, g.base); }
    while (t.N < upto) {
      // odcinek: płynne przejście do nowego odchylenia + prosta
      const n0 = t.N, x0 = g.x, z0 = g.z, off0 = g.off;
      let ok = false;
      for (let tries = 0; tries < 7 && !ok; tries++) {
        let target = tries >= 6 ? 0 : (g.r() * 2 - 1) * S.amp * Math.pow(0.6, tries);
        if (t.N < START_K + 40) target *= 0.25; // prosty start
        const dOff = target - off0;
        const T = Math.max(S.trans[0] + g.r() * (S.trans[1] - S.trans[0]), 22 * Math.abs(dOff));
        const Hh = S.hold[0] + g.r() * (S.hold[1] - S.hold[0]);
        let x = x0, z = z0;
        ok = true;
        for (let s = 1; s <= T + Hh; s++) {
          const u = Math.min(1, s / T), off = off0 + dOff * u * u * (3 - 2 * u);
          const h = g.base + off;
          x += Math.sin(h); z += Math.cos(h);
          if (tooClose(t, x, z, t.N)) { ok = false; break; }
          trackPush(t, x, z, h);
          if ((t.N >= upto && s >= T) || t.N >= t.cap - 1) break;
        }
        if (ok) { g.x = x; g.z = z; g.off = t.HD[t.N - 1] - g.base; }
        else { trackClear(t, n0); }
      }
      if (!ok) break; // nie powinno się zdarzyć – prosta zawsze ucieka od starej trasy
    }
    // krzywizna (dla komputera) tam, gdzie znamy już trasę 42 punkty dalej
    for (let k = g.curvDone; k < t.N - 43; k++) {
      let m = 0;
      for (let j = 6; j <= 42; j += 6) m = Math.max(m, Math.abs(angDiff(t.HD[k + j], t.HD[k])));
      t.CURV[k] = m;
      g.curvDone = k + 1;
    }
  }

  // ---------- świat ----------
  // Kawałek świata („strona”). Pętla = jedna strona na cały tor; trasy otwarte = strony wzdłuż drogi,
  // każda obejmuje komórki, których najbliższy punkt trasy należy do [k0, k1).
  // Generator: oddaje sterowanie co jakiś czas, żeby w trybie „bez końca” budować świat w tle.
  function* genPage(track, o) {
    const { N, X, Z, NX, NZ } = track;
    const { theme, seed, barriers, loop, k0, k1, ox, oz, W, D } = o;
    const th = THEMES[theme];
    const r = rng(seed * 31 + 7 + (o.index || 0) * 7919);
    const noise = makeNoise(seed % 10007);
    const FLAT = barriers ? WALL : HW + 20; // do tej odległości teren jest płaski
    const RMAX = FLAT + 34;                 // trasy otwarte: dalej jest już morze
    const RR = loop ? FLAT + 12 : RMAX;
    const dist = new Float32Array(W * D).fill(999), near = new Int32Array(W * D).fill(-1);
    const ka = loop ? 0 : Math.max(0, k0 - 100), kb = loop ? N : Math.min(N, k1 + 100);
    for (let k = ka; k < kb; k++) {
      const cx = X[k] - ox, cz = Z[k] - oz;
      for (let z = Math.max(0, Math.floor(cz - RR)); z <= Math.min(D - 1, Math.ceil(cz + RR)); z++)
        for (let x = Math.max(0, Math.floor(cx - RR)); x <= Math.min(W - 1, Math.ceil(cx + RR)); x++) {
          const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz), c = z * W + x;
          if (d < dist[c]) { dist[c] = d; near[c] = k; }
        }
      if (k % 12 === 0) yield;
    }
    // własność komórek (tylko trasy otwarte)
    let own = null;
    if (!loop) {
      own = new Uint8Array(W * D);
      for (let c = 0; c < W * D; c++) { if (near[c] >= k0 && near[c] < k1 && dist[c] < RMAX) own[c] = 1; if (c % 40000 === 0) yield; }
    }
    const owned = c => !own || own[c];
    const vox = new Uint8Array(W * D * HY);
    const colH = new Float32Array(W * D);
    const surf = new Uint8Array(W * D).fill(S_OFF);
    const height = new Int8Array(W * D);
    const wallMask = new Uint8Array(W * D); // komórki bandy – kolizja liczona gładko wzdłuż toru
    const set = (x, wy, z, id) => { const y = wy + Y0; if (x >= 0 && z >= 0 && x < W && z < D && y >= 0 && y < HY && owned(z * W + x)) vox[(y * D + z) * W + x] = id; };
    const get = (x, wy, z) => { const y = wy + Y0; return (x < 0 || z < 0 || x >= W || z >= D || y < 0 || y >= HY) ? 0 : vox[(y * D + z) * W + x]; };
    const column = (x, z, h, top) => {
      for (let y = -3; y < h; y++) set(x, y, z, y === h - 1 ? top : (y >= h - 3 ? th.sub : (theme === 'pustynia' ? B.sandstone : B.stone)));
    };
    const gates = o.gates || [];
    const onLine = k => loop ? (k <= 2 || k >= N - 2) : gates.some(g => Math.abs(k - g.k) <= 2 && g.kind !== 'cp');
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const c = z * W + x, d = dist[c];
        if (!owned(c)) continue;
        if (d <= HW) {
          let top = th.road;
          const k = near[c];
          if (d > HW - 1.5) top = (Math.floor(k / 5) % 2) ? B.curb_red : B.curb_white;
          if (onLine(k)) top = B.finish;
          column(x, z, 0, top);
          surf[c] = S_ROAD;
        } else if (d < (barriers ? WALL - 0.5 : FLAT)) {
          column(x, z, 0, th.top);
          if (th.plantP && r() < th.plantP * 0.3) set(x, 0, z, th.plants[Math.floor(r() * th.plants.length)]);
        } else if (barriers && d < WALL + 0.5) {
          column(x, z, 0, th.top);
          set(x, 0, z, th.wall); set(x, 1, z, th.wall);
          colH[c] = 2; wallMask[c] = 1;
        } else {
          const gx = x + ox, gz = z + oz;
          const n = noise(gx / 42, gz / 42);
          const edge = loop ? Math.min(x, z, W - 1 - x, D - 1 - z) : RMAX - d;
          const fade = clamp((d - FLAT - 2) / 11, 0, 1) * clamp(edge / 11, 0, 1);
          if (n < th.lakeLevel && d > FLAT + 4 && edge > 2) {
            column(x, z, -1, th.sub);
            set(x, -1, z, th.lake);
            surf[c] = th.lakeSurf;
            height[c] = 0;
            continue;
          }
          let h = Math.floor(Math.max(0, (n - 0.5) * 28) * fade);
          if (h > 15) h = 15;
          height[c] = h;
          colH[c] = h;
          column(x, z, h, h >= 9 ? th.peak : th.top);
        }
      }
      if (z % 6 === 0) yield;
    }
    // drzewa, kaktusy, kwiaty (tylko poza bandą)
    const trees = [];
    for (let z = 2; z < D - 2; z++) {
      for (let x = 2; x < W - 2; x++) {
        const c = z * W + x;
        if (!owned(c) || dist[c] < FLAT + 3 || surf[c] !== S_OFF || (!loop && dist[c] > RMAX - 6)) continue;
        const h = height[c];
        if (r() < th.treeP * 0.4 && h < 9 && !trees.some(t => Math.abs(t[0] - x) < 9 && Math.abs(t[1] - z) < 9)) {
          trees.push([x, z]);
          if (th.tree === 'oak') {
            const t = 6 + Math.floor(r() * 3);
            for (let y = 0; y < t; y++) set(x, h + y, z, B.log);
            for (let dy = -3; dy <= 2; dy++) for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
              const rr = dx * dx + dz * dz + (dy + 0.5) * (dy + 0.5) * 1.3;
              if (rr <= 11 && (rr < 8 || r() < 0.6) && !get(x + dx, h + t + dy, z + dz)) set(x + dx, h + t + dy, z + dz, B.leaves);
            }
            colH[c] = h + t;
          } else if (th.tree === 'pine') {
            const t = 9 + Math.floor(r() * 3);
            for (let y = 0; y < t; y++) set(x, h + y, z, B.log);
            let layer = 0;
            for (let y = t + 1; y >= 2; y--) {
              const rad = Math.min(3, Math.floor(layer / 2));
              for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
                if (Math.abs(dx) + Math.abs(dz) > rad + 1) continue;
                if (!get(x + dx, h + y, z + dz)) set(x + dx, h + y, z + dz, B.pine);
              }
              layer++;
            }
            colH[c] = h + t;
          } else {
            const t = 3 + Math.floor(r() * 3);
            for (let y = 0; y < t; y++) set(x, h + y, z, B.cactus);
            colH[c] = h + t;
          }
        } else if (th.plantP && r() < th.plantP && !get(x, h, z)) {
          set(x, h, z, th.plants[Math.floor(r() * th.plants.length)]);
        }
      }
      if (z % 10 === 0) yield;
    }

    // bramy: start / meta (szachownica) i punkty kontrolne (w trybie bez końca)
    const allGates = loop ? [{ k: 0, kind: 'start' }] : gates.filter(g => g.k >= k0 && g.k < k1);
    for (const g of allGates) {
      const posts = [];
      for (const sg of [1, -1]) {
        const gx = Math.floor(X[g.k] - ox + NX[g.k] * (HW + 2.4) * sg), gz = Math.floor(Z[g.k] - oz + NZ[g.k] * (HW + 2.4) * sg);
        posts.push([gx, gz]);
        for (let px = 0; px < 2; px++) for (let pz = 0; pz < 2; pz++) {
          for (let y = 0; y < 10; y++) set(gx + px, y, gz + pz, B.log);
          if (gx + px < W && gz + pz < D && gx + px >= 0 && gz + pz >= 0) colH[(gz + pz) * W + gx + px] = 10;
        }
      }
      const [a, b] = posts;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const banner = g.kind === 'cp' ? B.hay : B.finish;
      for (let t = 0; t <= L; t += 0.3) {
        const gx = Math.round(a[0] + (b[0] - a[0]) * t / L), gz = Math.round(a[1] + (b[1] - a[1]) * t / L);
        if (get(gx, 0, gz) === B.log) continue;
        set(gx, 8, gz, banner); set(gx, 9, gz, banner);
        set(gx, 10, gz, B.planks);
      }
    }

    // bonusy: rzędy kostek w poprzek toru
    const boxes = [];
    const rows = loop ? [0.13, 0.38, 0.63, 0.87].map(f => Math.floor(N * f))
      : [];
    if (!loop) for (let k = Math.ceil((k0 - 230) / 300) * 300 + 230; k < k1; k += 300) if (k >= k0 && k > START_K + 100 && (!track.finishK || k < track.finishK - 40)) rows.push(k);
    for (const k of rows) [-0.72, -0.36, 0, 0.36, 0.72].forEach((f, j) => boxes.push({ id: k + '_' + j, x: X[k] + NX[k] * f * HW, z: Z[k] + NZ[k] * f * HW, k, active: true, t: 0 }));

    // przeszkody
    const hazards = [];
    const tnts = [];
    const cellsAround = (px, pz, rad) => {
      const out = [];
      px -= ox; pz -= oz;
      for (let z = Math.floor(pz - rad); z <= Math.floor(pz + rad); z++) for (let x = Math.floor(px - rad); x <= Math.floor(px + rad); x++) {
        if (x < 0 || z < 0 || x >= W || z >= D || !owned(z * W + x)) continue;
        if (Math.hypot(x + 0.5 - px, z + 0.5 - pz) <= rad && dist[z * W + x] <= HW + 0.2) out.push([x, z]);
      }
      return out;
    };
    const hzFrom = loop ? 74 : Math.max(k0 + 10, START_K + 90), hzTo = loop ? N - 48 : Math.min(k1 - 10, track.finishK ? track.finishK - 50 : k1);
    let k = hzFrom;
    const types = ['pile', 'pile', 'mud', 'slick', 'slime', 'tnt', 'tnt', 'mud'];
    while (k < hzTo) {
      if (rows.some(rk => Math.abs(rk - k) < 15) || gates.some(g => Math.abs(g.k - k) < 15)) { k += 8; continue; }
      const type = types[Math.floor(r() * types.length)];
      const side = r() < 0.5 ? -1 : 1;
      if (type === 'pile') {
        const of = r() < 0.3 ? 0 : side * HW * 0.55;
        const px = X[k] + NX[k] * of, pz = Z[k] + NZ[k] * of;
        const tall = r() < 0.6;
        for (const [x, z] of cellsAround(px, pz, 2.1)) {
          const hh = tall && Math.hypot(x + ox + 0.5 - px, z + oz + 0.5 - pz) < 1.1 ? 3 : 2;
          for (let y = 0; y < hh; y++) set(x, y, z, th.pile);
          colH[z * W + x] = Math.max(colH[z * W + x], hh);
        }
        hazards.push({ k, o: of, rad: 2.5, type });
      } else if (type === 'mud' || type === 'slick') {
        const of = (r() - 0.5) * HW * 0.9;
        const rad = type === 'mud' ? 3.6 : 2.9;
        const px = X[k] + NX[k] * of, pz = Z[k] + NZ[k] * of;
        for (const [x, z] of cellsAround(px, pz, rad)) {
          const c = z * W + x;
          if (colH[c] > 0) continue;
          set(x, -1, z, type === 'mud' ? B.mud : th.slick);
          surf[c] = type === 'mud' ? S_MUD : th.slickSurf;
        }
        hazards.push({ k, o: of, rad: rad + 0.5, type });
      } else if (type === 'slime') {
        const of = (r() - 0.5) * HW;
        const px = X[k] + NX[k] * of, pz = Z[k] + NZ[k] * of;
        for (const [x, z] of cellsAround(px, pz, 2.4)) {
          const c = z * W + x;
          if (colH[c] > 0) continue;
          set(x, -1, z, B.slime); surf[c] = S_SLIME;
        }
      } else {
        const of = (r() - 0.5) * HW * 1.3;
        const tnt = { id: 'f' + k, x: X[k] + NX[k] * of, z: Z[k] + NZ[k] * of, k, o: of, active: true, t: 0, fixed: true, armT: 0, owner: null };
        tnts.push(tnt);
        hazards.push({ k, o: of, rad: 1.9, type: 'tnt', ref: tnt });
      }
      k += 27 + Math.floor(r() * 35);
    }
    return { ox, oz, W, D, H: HY, Y0, vox, colH, surf, dist, near, wallMask, own, boxes, hazards, tnts, k0, k1, index: o.index || 0 };
  }
  function runGen(gen) { let s; do s = gen.next(); while (!s.done); return s.value; }
  // granice strony trasy otwartej (w blokach świata)
  function pageBox(track, k0, k1, barriers) {
    const RMAX = (barriers ? WALL : HW + 20) + 34;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = Math.max(0, k0); k < Math.min(track.N, k1); k++) {
      minX = Math.min(minX, track.X[k]); maxX = Math.max(maxX, track.X[k]); minZ = Math.min(minZ, track.Z[k]); maxZ = Math.max(maxZ, track.Z[k]);
    }
    const ox = Math.floor(minX - RMAX - 2), oz = Math.floor(minZ - RMAX - 2);
    return { ox, oz, W: Math.ceil(maxX + RMAX + 2) - ox, D: Math.ceil(maxZ + RMAX + 2) - oz };
  }

  // ---------- modele ----------
  // Pojazdy: bryły [x0,y0,z0,x1,y1,z1,tekstura] ('P' = lakier w kolorze postaci), koła [x,z,promień,szerokość,przednie]
  const mirror = list => list.concat(list.filter(p => p[7]).map(p => [-p[3], p[1], p[2], -p[0], p[4], p[5], p[6]]));
  const VEH = [
    {
      name: 'Gokart', icon: '🏎️', desc: 'zwrotny, dobry na wszystko', speed: 21.5, accel: 16, turn: 2.45, grip: 10, off: 0.55, mud: 0.38, mass: 1, rad: 0.78, seat: [0, 0],
      parts: mirror([
        [-0.62, 0.22, -1.15, 0.62, 0.42, 1.05, 'P'], [-0.45, 0.3, 1.05, 0.45, 0.56, 1.5, 'P'],
        [0.62, 0.24, -0.55, 0.86, 0.56, 0.5, 'P', 1], [-0.4, 0.42, 0.3, 0.4, 0.64, 1.05, 'P'],
        [-0.38, 0.42, -1.02, 0.38, 1.1, -0.78, 'seat'], [0.4, 0.42, -1.22, 0.5, 1.08, -1.12, 'metal', 1],
        [-0.88, 1.08, -1.34, 0.88, 1.18, -1.02, 'P'], [-0.04, 0.6, 0.22, 0.04, 0.86, 0.42, 'metal'],
        [-0.24, 0.8, 0.2, 0.24, 1.0, 0.27, 'seat'], [-0.95, 0.15, 1.42, 0.95, 0.3, 1.62, 'P']]),
      wheels: [[-0.82, 0.86, 0.3, 0.3, 1], [0.82, 0.86, 0.3, 0.3, 1], [-0.82, -0.8, 0.3, 0.3, 0], [0.82, -0.8, 0.3, 0.3, 0]]
    },
    {
      name: 'Bolid', icon: '🏁', desc: 'najszybszy na asfalcie, słaby w terenie', speed: 24.5, accel: 14, turn: 2.2, grip: 11, off: 0.42, mud: 0.32, mass: 1, rad: 0.85, seat: [-0.04, 0],
      parts: mirror([
        [-0.42, 0.18, -1.5, 0.42, 0.46, 1.5, 'P'], [-0.26, 0.18, 1.5, 0.26, 0.38, 2.15, 'P'],
        [-1.05, 0.1, 1.95, 1.05, 0.2, 2.25, 'P'], [0.42, 0.2, -0.85, 0.8, 0.52, 0.45, 'P', 1],
        [-0.3, 0.46, -1.45, 0.3, 0.95, -0.82, 'P'], [-0.36, 0.42, -0.92, 0.36, 1.0, -0.8, 'seat'],
        [-0.06, 0.46, -1.7, 0.06, 1.05, -1.55, 'metal'], [-0.9, 1.0, -1.85, 0.9, 1.15, -1.5, 'P'],
        [0.88, 0.6, -1.85, 0.95, 1.18, -1.5, 'seat', 1], [-0.22, 0.72, 0.15, 0.22, 0.9, 0.22, 'seat'],
        [-0.04, 0.5, 0.18, 0.04, 0.75, 0.4, 'metal']]),
      wheels: [[-0.98, 1.3, 0.34, 0.36, 1], [0.98, 1.3, 0.34, 0.36, 1], [-0.98, -1.15, 0.38, 0.42, 0], [0.98, -1.15, 0.38, 0.42, 0]]
    },
    {
      name: 'Terenówka', icon: '🚙', desc: 'wielkie koła – trawa i błoto niestraszne', speed: 20, accel: 15, turn: 2.25, grip: 9, off: 0.82, mud: 0.7, mass: 1.5, rad: 0.98, seat: [0.63, 0],
      parts: mirror([
        [-0.8, 0.7, -1.35, 0.8, 1.05, 1.4, 'P'], [-0.75, 1.05, 0.55, 0.75, 1.4, 1.4, 'P'],
        [-0.9, 0.6, 1.4, 0.9, 0.85, 1.55, 'metal'], [-0.9, 0.6, -1.5, 0.9, 0.85, -1.35, 'metal'],
        [-0.8, 1.05, -1.35, 0.8, 1.35, -1.2, 'P'], [-0.38, 1.05, -0.95, 0.38, 1.75, -0.75, 'seat'],
        [0.62, 1.05, -1.0, 0.72, 2.85, -0.9, 'metal', 1], [0.62, 1.05, 0.45, 0.72, 2.85, 0.55, 'metal', 1],
        [-0.72, 2.75, -1.0, 0.72, 2.85, -0.9, 'metal'], [-0.72, 2.75, 0.45, 0.72, 2.85, 0.55, 'metal'],
        [0.62, 2.75, -1.0, 0.72, 2.85, 0.55, 'metal', 1], [0.35, 1.15, 1.4, 0.6, 1.3, 1.46, 'curb_white', 1],
        [-0.24, 1.42, 0.2, 0.24, 1.62, 0.27, 'seat'], [-0.04, 1.2, 0.22, 0.04, 1.45, 0.45, 'metal']]),
      wheels: [[-1.02, 0.95, 0.6, 0.5, 1], [1.02, 0.95, 0.6, 0.5, 1], [-1.02, -0.95, 0.6, 0.5, 0], [1.02, -0.95, 0.6, 0.5, 0]]
    },
    {
      name: 'Traktor', icon: '🚜', desc: 'powolny, ale ciężki – rozpycha innych', speed: 18.5, accel: 12.5, turn: 2.15, grip: 9.5, off: 0.95, mud: 1, mass: 2.2, rad: 0.95, seat: [0.58, 0],
      parts: mirror([
        [-0.4, 0.45, -1.0, 0.4, 0.85, 1.6, 'P'], [-0.45, 0.85, 0.2, 0.45, 1.45, 1.65, 'P'],
        [-0.4, 0.55, 1.65, 0.4, 1.4, 1.72, 'seat'], [0.25, 1.45, 1.2, 0.37, 2.25, 1.32, 'seat'],
        [0.68, 1.6, -1.45, 1.22, 1.7, 0.25, 'P', 1], [-0.4, 0.85, -1.05, 0.4, 1.0, -0.4, 'seat'],
        [-0.38, 1.0, -1.1, 0.38, 1.55, -0.9, 'seat'], [-0.04, 1.2, 0.05, 0.04, 1.5, 0.25, 'metal'],
        [-0.24, 1.45, 0.18, 0.24, 1.6, 0.25, 'seat'], [-0.15, 0.5, -1.3, 0.15, 0.7, -1.0, 'metal']]),
      wheels: [[-0.6, 1.25, 0.42, 0.28, 1], [0.6, 1.25, 0.42, 0.28, 1], [-0.95, -0.6, 0.78, 0.45, 0], [0.95, -0.6, 0.78, 0.45, 0]]
    },
    {
      name: 'Sportowe', icon: '🚗', desc: 'szybkie i stabilne auto wyścigowe', speed: 23.5, accel: 16.5, turn: 2.35, grip: 11, off: 0.5, mud: 0.35, mass: 1.2, rad: 0.95, seat: [0, 0],
      parts: mirror([
        [-0.85, 0.25, -1.7, 0.85, 0.7, 1.8, 'P'], [-0.8, 0.7, 0.5, 0.8, 0.8, 1.7, 'P'], [-0.8, 0.7, -1.7, 0.8, 0.85, -1.05, 'P'],
        [-0.75, 0.8, 0.35, 0.75, 1.15, 0.45, 'ice'], [0.45, 0.4, 1.8, 0.75, 0.55, 1.85, 'curb_white', 1],
        [0.45, 0.5, -1.75, 0.75, 0.62, -1.7, 'curb_red', 1], [-0.38, 0.42, -1.0, 0.38, 1.1, -0.8, 'seat'],
        [0.55, 0.85, -1.6, 0.62, 1.0, -1.5, 'metal', 1], [-0.85, 1.0, -1.72, 0.85, 1.08, -1.42, 'P'],
        [-0.04, 0.6, 0.22, 0.04, 0.86, 0.42, 'metal'], [-0.24, 0.8, 0.2, 0.24, 1.0, 0.27, 'seat']]),
      wheels: [[-0.85, 1.15, 0.36, 0.3, 1], [0.85, 1.15, 0.36, 0.3, 1], [-0.85, -1.15, 0.38, 0.34, 0], [0.85, -1.15, 0.38, 0.34, 0]]
    },
    {
      name: 'Motocykl', icon: '🏍️', desc: 'lekki i zrywny, ale łatwo go zepchnąć', speed: 23, accel: 18, turn: 2.6, grip: 9, off: 0.55, mud: 0.35, mass: 0.7, rad: 0.62, seat: [0.46, 0.3], lean: true,
      parts: [
        [-0.15, 0.35, -0.9, 0.15, 0.75, 0.9, 'P'], [-0.25, 0.75, 0.2, 0.25, 1.0, 0.75, 'P'],
        [-0.06, 0.3, 0.9, 0.06, 1.2, 1.05, 'metal'], [-0.5, 1.15, 0.8, 0.5, 1.25, 0.92, 'metal'],
        [-0.25, 0.75, -0.75, 0.25, 0.88, 0.2, 'seat'], [0.18, 0.35, -1.05, 0.28, 0.48, -0.2, 'metal'],
        [-0.12, 0.95, 1.05, 0.12, 1.1, 1.12, 'curb_white'], [-0.18, 0.8, -1.25, 0.18, 0.88, -0.75, 'P']],
      wheels: [[0, 1.05, 0.42, 0.22, 1], [0, -0.95, 0.42, 0.26, 0]]
    },
    {
      name: 'Radiowóz', icon: '🚓', desc: 'szybki i mocny – rozpycha innych', speed: 22.5, accel: 16, turn: 2.35, grip: 11.5, off: 0.6, mud: 0.45, mass: 1.5, rad: 0.95, seat: [0, 0],
      parts: mirror([
        [-0.86, 0.25, -1.75, 0.86, 0.55, 1.85, '#1c1c22'], [-0.86, 0.55, -1.75, 0.86, 0.75, 1.85, '#f4f4f4'],
        [0.86, 0.45, -1.2, 0.88, 0.62, 1.4, 'P', 1], [-0.82, 0.75, 0.5, 0.82, 0.85, 1.8, '#f4f4f4'],
        [-0.82, 0.75, -1.75, 0.82, 0.9, -1.05, '#f4f4f4'], [-0.78, 0.85, 0.35, 0.78, 1.25, 0.45, 'ice'],
        [0.5, 0.45, 1.85, 0.78, 0.6, 1.9, 'curb_white', 1], [0.5, 0.55, -1.8, 0.78, 0.66, -1.75, 'curb_red', 1],
        [-0.38, 0.42, -1.0, 0.38, 1.1, -0.8, 'seat'], [0.66, 0.9, -1.0, 0.74, 2.05, -0.9, 'metal', 1],
        [-0.74, 1.95, -1.05, 0.74, 2.05, -0.85, 'metal'], [-0.6, 0.45, 1.85, 0.6, 0.55, 1.95, '#1c1c22'],
        [-0.04, 0.6, 0.22, 0.04, 0.86, 0.42, 'metal'], [-0.24, 0.8, 0.2, 0.24, 1.0, 0.27, 'seat']]),
      wheels: [[-0.86, 1.2, 0.38, 0.32, 1], [0.86, 1.2, 0.38, 0.32, 1], [-0.86, -1.15, 0.38, 0.34, 0], [0.86, -1.15, 0.38, 0.34, 0]],
      // migająca belka świateł (rysowana osobno)
      lights: [[-0.7, 2.05, -1.05, -0.02, 2.25, -0.85, '#ff2a2a'], [0.02, 2.05, -1.05, 0.7, 2.25, -0.85, '#2a5aff']]
    },
    {
      name: 'Ciężarówka', icon: '🚚', desc: 'ogromna i ciężka – nikt jej nie zepchnie', speed: 19, accel: 11, turn: 2.0, grip: 9, off: 0.75, mud: 0.8, mass: 3, rad: 1.15, seat: [0.58, 0],
      parts: mirror([
        [-0.85, 0.5, -2.3, 0.85, 0.8, 2.0, 'metal'], [-0.9, 0.8, 0.6, 0.9, 1.9, 2.0, 'P'],
        [-0.85, 1.9, 0.55, 0.85, 2.4, 0.65, 'ice'], [-0.7, 0.9, 2.0, 0.7, 1.6, 2.05, 'seat'],
        [0.45, 1.65, 2.0, 0.8, 1.8, 2.06, 'curb_white', 1], [-0.95, 0.8, -2.35, 0.95, 1.0, -0.9, 'planks'],
        [0.85, 1.0, -2.35, 0.95, 1.6, -0.9, 'planks', 1], [-0.95, 1.0, -2.35, 0.95, 1.6, -2.25, 'planks'],
        [-0.6, 1.0, -2.1, 0.05, 1.55, -1.35, 'hay'], [-0.4, 0.8, -0.75, 0.4, 1.0, 0.0, 'seat'],
        [-0.4, 1.0, -0.85, 0.4, 1.7, -0.7, 'seat'], [-0.04, 1.3, 0.25, 0.04, 1.6, 0.6, 'metal'],
        [-0.26, 1.55, 0.2, 0.26, 1.75, 0.27, 'seat'], [0.9, 1.0, 0.0, 1.0, 2.6, 0.12, 'metal', 1]]),
      wheels: [[-0.95, 1.4, 0.5, 0.4, 1], [0.95, 1.4, 0.5, 0.4, 1], [-0.95, -1.0, 0.5, 0.4, 0], [0.95, -1.0, 0.5, 0.4, 0], [-0.95, -1.9, 0.5, 0.4, 0], [0.95, -1.9, 0.5, 0.4, 0]]
    },
    {
      name: 'Wóz strażacki', icon: '🚒', desc: 'wielki i ciężki, z drabiną i syreną świateł', speed: 19.5, accel: 12, turn: 2.05, grip: 9.5, off: 0.7, mud: 0.75, mass: 2.8, rad: 1.2, seat: [0.58, 0.15],
      parts: mirror([
        [-0.95, 0.5, -2.4, 0.95, 0.8, 2.3, '#2a2a2e'], [-0.95, 0.8, -2.4, 0.95, 1.75, -0.65, '#d42020'],
        [0.95, 1.05, -2.3, 0.97, 1.12, -0.75, 'metal', 1], [0.95, 1.35, -2.3, 0.97, 1.42, -0.75, 'metal', 1],
        [-0.95, 0.8, 0.7, 0.95, 1.5, 2.3, '#d42020'], [-0.9, 1.5, 0.6, 0.9, 2.0, 0.7, 'ice'],
        [-1.0, 0.5, 2.3, 1.0, 0.75, 2.45, 'metal'], [0.55, 1.0, 2.3, 0.85, 1.15, 2.33, 'curb_white', 1],
        [0.95, 0.85, 0.7, 0.97, 0.95, 2.25, 'curb_white', 1], [0.35, 1.75, -2.6, 0.45, 1.88, -0.8, 'metal', 1],
        [-0.45, 1.88, -2.5, 0.45, 1.95, -2.42, 'metal'], [-0.45, 1.88, -2.0, 0.45, 1.95, -1.92, 'metal'], [-0.45, 1.88, -1.5, 0.45, 1.95, -1.42, 'metal'], [-0.45, 1.88, -1.0, 0.45, 1.95, -0.92, 'metal'],         [-0.4, 0.8, -0.6, 0.4, 1.0, 0.25, 'seat'], [-0.4, 1.0, -0.74, 0.4, 1.6, -0.62, 'seat'],
        [-0.04, 1.25, 0.3, 0.04, 1.55, 0.6, 'metal'], [-0.26, 1.5, 0.3, 0.26, 1.7, 0.37, 'seat']]),
      wheels: [[-0.95, 1.5, 0.5, 0.4, 1], [0.95, 1.5, 0.5, 0.4, 1], [-0.95, -1.2, 0.5, 0.4, 0], [0.95, -1.2, 0.5, 0.4, 0], [-0.95, -2.0, 0.5, 0.4, 0], [0.95, -2.0, 0.5, 0.4, 0]],
      lights: [[-0.85, 1.75, -0.8, -0.5, 1.95, -0.66, '#ff2020'], [0.5, 1.75, -0.8, 0.85, 1.95, -0.66, '#ff2020']]
    },
    {
      name: 'Karetka', icon: '🚑', desc: 'szybka i zwinna, z kogutem na dachu', speed: 21.5, accel: 15.5, turn: 2.3, grip: 11, off: 0.6, mud: 0.45, mass: 1.6, rad: 1.0, seat: [0.18, 0],
      parts: mirror([
        [-0.9, 0.3, -2.0, 0.9, 0.6, 1.85, '#f4f4f4'], [-0.9, 0.6, -2.0, 0.9, 1.95, -0.9, '#f4f4f4'],
        [-0.85, 0.6, 0.4, 0.85, 1.0, 1.85, '#f4f4f4'], [-0.85, 1.0, 0.3, 0.85, 1.55, 0.38, 'ice'],
        [0.9, 0.75, -2.0, 0.92, 0.88, 1.8, '#d42020', 1], [0.9, 1.2, -1.62, 0.92, 1.68, -1.48, '#d42020', 1],
        [0.9, 1.37, -1.79, 0.92, 1.51, -1.31, '#d42020', 1], [-0.9, 1.15, -2.02, 0.9, 1.65, -2.0, '#d42020'],
        [0.5, 0.7, 1.85, 0.8, 0.85, 1.88, 'curb_white', 1], [-0.38, 0.6, -0.85, 0.38, 0.62, -0.2, 'seat'],
        [-0.38, 0.62, -0.9, 0.38, 1.25, -0.78, 'seat'], [-0.04, 0.8, 0.22, 0.04, 1.05, 0.42, 'metal'], [-0.24, 1.0, 0.2, 0.24, 1.2, 0.27, 'seat']]),
      wheels: [[-0.88, 1.25, 0.4, 0.32, 1], [0.88, 1.25, 0.4, 0.32, 1], [-0.88, -1.4, 0.4, 0.34, 0], [0.88, -1.4, 0.4, 0.34, 0]],
      lights: [[-0.7, 1.95, -1.05, -0.05, 2.12, -0.9, '#2a5aff'], [0.05, 1.95, -1.05, 0.7, 2.12, -0.9, '#ff2a2a']]
    },
    {
      name: 'Autobus', icon: '🚌', desc: 'odkryty, z pasażerami – powolny, ale nie do zepchnięcia', speed: 18.5, accel: 10.5, turn: 1.95, grip: 9.5, off: 0.65, mud: 0.7, mass: 3.2, rad: 1.25, seat: [0.88, 1.15],
      parts: mirror([
        [-1.0, 0.4, -2.8, 1.0, 0.7, 2.6, '#303034'], [-1.0, 0.7, -2.8, 1.0, 1.3, 2.6, '#f2c230'],
        [-0.95, 1.3, 1.55, 0.95, 1.6, 2.6, '#f2c230'], [-0.95, 1.6, 1.5, 0.95, 2.05, 1.58, 'ice'],
        [1.0, 1.0, -2.7, 1.02, 1.1, 2.5, 'P', 1], [0.98, 1.3, -2.8, 1.0, 1.75, 1.5, '#f2c230', 1],
        [-1.0, 1.3, -2.8, 1.0, 1.75, -2.7, '#f2c230'], [0.55, 0.9, 2.6, 0.85, 1.05, 2.63, 'curb_white', 1],
        [0.15, 1.3, -2.5, 0.85, 1.75, -2.35, 'seat', 1], [0.15, 1.3, -1.7, 0.85, 1.75, -1.55, 'seat', 1],
        [0.15, 1.3, -0.9, 0.85, 1.75, -0.75, 'seat', 1], [-0.4, 1.3, 0.2, 0.4, 1.95, 0.36, 'seat'],
        [-0.04, 1.6, 1.3, 0.04, 1.9, 1.55, 'metal'], [-0.26, 1.85, 1.3, 0.26, 2.05, 1.37, 'seat']]),
      wheels: [[-1.0, 1.8, 0.5, 0.4, 1], [1.0, 1.8, 0.5, 0.4, 1], [-1.0, -1.9, 0.5, 0.4, 0], [1.0, -1.9, 0.5, 0.4, 0]]
    },
    {
      name: 'Monster truck', icon: '🛻', desc: 'olbrzymie koła – przejedzie po wszystkim', speed: 20.5, accel: 15, turn: 2.2, grip: 9, off: 0.92, mud: 0.9, mass: 2, rad: 1.15, seat: [1.18, 0],
      parts: mirror([
        [-0.5, 0.9, -1.3, 0.5, 1.2, 1.3, '#303034'], [-0.95, 1.2, -1.5, 0.95, 1.6, 1.6, 'P'],
        [-0.9, 1.6, 0.5, 0.9, 1.85, 1.6, 'P'], [-0.95, 1.6, -1.5, 0.95, 1.85, -1.3, 'P'],
        [0.85, 1.6, -1.5, 0.95, 1.85, -0.4, 'P', 1], [-0.38, 1.6, -0.95, 0.38, 2.3, -0.75, 'seat'],
        [0.68, 1.6, -1.0, 0.78, 3.4, -0.9, 'metal', 1], [0.68, 1.6, 0.45, 0.78, 3.4, 0.55, 'metal', 1],
        [-0.78, 3.3, -1.0, 0.78, 3.4, 0.55, 'metal'], [-0.78, 3.3, -1.0, -0.68, 3.4, 0.55, 'metal'], [0.68, 3.3, -1.0, 0.78, 3.4, 0.55, 'metal'],
        [0.4, 1.65, 1.6, 0.7, 1.8, 1.63, 'curb_white', 1], [-0.04, 1.8, 0.22, 0.04, 2.05, 0.45, 'metal'], [-0.24, 2.0, 0.2, 0.24, 2.2, 0.27, 'seat']]),
      wheels: [[-1.15, 1.1, 0.8, 0.6, 1], [1.15, 1.1, 0.8, 0.6, 1], [-1.15, -1.1, 0.8, 0.6, 0], [1.15, -1.1, 0.8, 0.6, 0]]
    },
    {
      name: 'Skuter', icon: '🛵', desc: 'malutki i zrywny – najzwinniejszy ze wszystkich', speed: 20, accel: 19, turn: 2.75, grip: 10, off: 0.5, mud: 0.35, mass: 0.6, rad: 0.58, seat: [0.33, 0.25], lean: true,
      parts: [
        [-0.22, 0.25, -0.5, 0.22, 0.35, 0.6, 'P'], [-0.25, 0.35, 0.55, 0.25, 1.1, 0.7, 'P'],
        [-0.25, 0.3, -1.0, 0.25, 0.62, -0.2, 'P'], [-0.22, 0.62, -0.85, 0.22, 0.75, -0.2, 'seat'],
        [-0.42, 1.1, 0.55, 0.42, 1.18, 0.65, 'metal'], [-0.1, 0.9, 0.7, 0.1, 1.02, 0.74, 'curb_white'],
        [-0.12, 0.45, -1.02, 0.12, 0.55, -0.98, 'curb_red']],
      wheels: [[0, 0.85, 0.28, 0.18, 1], [0, -0.8, 0.28, 0.2, 0]]
    }
  ];
  // parametry w jednostkach świata (bloki): prędkość, przyspieszenie, promień, promień tylnego koła
  VEH.forEach(V => { V.vmax = V.speed * SPD; V.acc = V.accel * SPD; V.r = V.rad * VS; V.wr = V.wheels[V.wheels.length - 1][2] * VS; });
  function vehMesh(v, color) {
    const mb = new MeshBuilder(), c = col01(color);
    for (const p of VEH[v].parts) {
      if (p[6] === 'P') mb.box(p[0], p[1], p[2], p[3], p[4], p[5], T.paint, c);
      else if (p[6][0] === '#') mb.box(p[0], p[1], p[2], p[3], p[4], p[5], T.paint, col01(p[6]));
      else mb.box(p[0], p[1], p[2], p[3], p[4], p[5], T[p[6]]);
    }
    return mb;
  }
  function wheelMesh(rw, ww) {
    const mb = new MeshBuilder(), h = ww / 2;
    mb.box(-h, -rw, -rw, h, rw, rw, { top: T.tire, bottom: T.tire, px: T.wheel, nx: T.wheel, pz: T.tire, nz: T.tire });
    return mb;
  }
  const PX = 1.3 / 16; // piksel postaci w blokach
  const BODY_Z0 = -0.74, BODY_Z1 = BODY_Z0 + 4 * PX, SEAT_Y = 0.42;
  const NECK = [0, SEAT_Y + 12 * PX, (BODY_Z0 + BODY_Z1) / 2];
  function bodyMesh(ch) {
    const mb = new MeshBuilder(), t = ch.tiles;
    const shirt = { top: t.shirt, bottom: t.shirt, px: t.shirt, nx: t.shirt, pz: t.shirt, nz: t.shirt };
    mb.box(-4 * PX, SEAT_Y, BODY_Z0, 4 * PX, NECK[1], BODY_Z1, shirt);
    const legs = { top: t.pants, bottom: t.pants, px: t.pants, nx: t.pants, pz: t.pants, nz: t.pants };
    mb.box(-4 * PX, SEAT_Y, BODY_Z0, -0.005, SEAT_Y + 4 * PX, BODY_Z0 + 12 * PX, legs);
    mb.box(0.005, SEAT_Y, BODY_Z0, 4 * PX, SEAT_Y + 4 * PX, BODY_Z0 + 12 * PX, legs);
    const arm = { top: t.shirt, bottom: t.shirt, px: t.shirt, nx: t.shirt, pz: t.skin, nz: t.shirt };
    const ay0 = NECK[1] - 5 * PX, ay1 = NECK[1] - 1 * PX;
    mb.box(-8 * PX, ay0, BODY_Z0 + 0.5 * PX, -4 * PX, ay1, 0.22, arm);
    mb.box(4 * PX, ay0, BODY_Z0 + 0.5 * PX, 8 * PX, ay1, 0.22, arm);
    return mb;
  }
  function headMesh(ch) {
    const mb = new MeshBuilder(), t = ch.tiles, h = 4 * PX;
    mb.box(-h, 0, -h, h, 8 * PX, h, { top: t.top, bottom: t.skin, pz: t.face, nz: t.back, px: t.side, nx: -(t.side + 1) });
    if (ch.style === 'chef') mb.box(-h + PX, 8 * PX, -h + PX, h - PX, 13 * PX, h - PX, T.white);
    if (ch.style === 'buns') { mb.box(-h - 2 * PX, 6 * PX, -2 * PX, -h, 9 * PX, 1 * PX, t.back); mb.box(h, 6 * PX, -2 * PX, h + 2 * PX, 9 * PX, 1 * PX, t.back); }
    if (ch.style === 'robot') mb.box(-0.3 * PX, 8 * PX, -0.3 * PX, 0.3 * PX, 11 * PX, 0.3 * PX, T.metal);
    if (ch.style === 'alien') { mb.box(-3 * PX, 8 * PX, 0, -2.4 * PX, 11 * PX, 0.6 * PX, t.skin); mb.box(2.4 * PX, 8 * PX, 0, 3 * PX, 11 * PX, 0.6 * PX, t.skin); }
    return mb;
  }
  function cubeMesh(tiles, s) {
    const mb = new MeshBuilder();
    mb.box(-s, -s, -s, s, s, s, tiles);
    return mb;
  }

  // ---------- dźwięk ----------
  const Snd = {
    ctx: null, on: true, master: null,
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain(); this.master.gain.value = this.on ? 0.8 : 0; this.master.connect(this.ctx.destination);
    },
    setOn(v) { this.on = v; if (this.master) this.master.gain.value = v ? 0.8 : 0; },
    beep(f, d, type, vol, f2) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(f, t);
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
      g.gain.setValueAtTime(vol || 0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + d);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + d + 0.02);
    },
    noise(d, vol, freq) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, len = Math.floor(this.ctx.sampleRate * d);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate), data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq || 800;
      const g = this.ctx.createGain(); g.gain.value = vol || 0.3;
      s.connect(f); f.connect(g); g.connect(this.master); s.start(t);
    },
    engine() {
      if (!this.ctx) return null;
      const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = 50; f.type = 'lowpass'; f.frequency.value = 520; g.gain.value = 0;
      o.connect(f); f.connect(g); g.connect(this.master); o.start();
      return { o, g, stop() { try { o.stop(); } catch (e) { /* już zatrzymany */ } } };
    },
    pickup() { this.beep(660, 0.08, 'square', 0.08); setTimeout(() => this.beep(990, 0.12, 'square', 0.08), 70); },
    boom() { this.noise(0.6, 0.5, 600); this.beep(120, 0.4, 'sine', 0.25, 40); },
    bump() { this.noise(0.12, 0.25, 300); },
    boing() { this.beep(220, 0.25, 'sine', 0.15, 660); },
    turbo() { this.noise(0.5, 0.18, 2500); this.beep(300, 0.4, 'sawtooth', 0.05, 900); }
  };

  // ---------- stan ----------
  const $ = id => document.getElementById(id);
  const isPhone = (('ontouchstart' in window) || navigator.maxTouchPoints > 0) && Math.min(screen.width, screen.height) < 700;
  const cfg = {
    players: 1, chars: [0, 1], veh: [0, 0], assist: true, route: 'loop', abLen: 1, bots: 3, diff: 1, theme: 'laka', laps: 3, shape: 1, barriers: true,
    view: isPhone ? '2d' : '3d', seed: 1 + Math.floor(Math.random() * 99999)
  };
  let R = null;          // renderer WebGL (tylko widok 3D)
  let game = null;       // bieżący wyścig
  let net = null;        // pokój gry online (RaceNet)
  let paused = false;
  let previewTrack = null;
  const meshes = { veh: {}, wheels: {} };

  function ensureRenderer() {
    if (R) return true;
    try { R = BG.createRenderer($('gl')); } catch (e) { R = null; }
    if (!R) return false;
    meshes.bonus = R.upload(cubeMesh(T.bonus, 0.42));
    meshes.tnt = R.upload(cubeMesh({ top: T.tnt_top, bottom: T.tnt_top, px: T.tnt, nx: T.tnt, pz: T.tnt, nz: T.tnt }, 0.5));
    meshes.body = CHARS.map(c => R.upload(bodyMesh(c)));
    meshes.head = CHARS.map(c => R.upload(headMesh(c)));
    meshes.dyn = { vb: R.gl.createBuffer(), ib: R.gl.createBuffer(), count: 0 };
    return true;
  }
  function vehMeshFor(v, ch) {
    const key = v + '_' + ch;
    return meshes.veh[key] || (meshes.veh[key] = R.upload(vehMesh(v, CHARS[ch].kart)));
  }
  function lightMeshesFor(v) {
    const key = 'L' + v;
    return meshes.veh[key] || (meshes.veh[key] = VEH[v].lights.map(l => {
      const mb = new MeshBuilder();
      mb.box(l[0], l[1], l[2], l[3], l[4], l[5], T.white, col01(l[6]));
      return R.upload(mb);
    }));
  }
  // które światło świeci: na przemian, każdy pojazd w innym rytmie
  const lightOn = (r, i) => Math.floor(game.t * 6 + r.ch * 0.37) % 2 === i % 2;
  function wheelMeshFor(rw, ww) {
    const key = rw + '_' + ww;
    return meshes.wheels[key] || (meshes.wheels[key] = R.upload(wheelMesh(rw, ww)));
  }
  const AB_LEN = [1300, 2400, 3800];      // długość trasy A→B (bloki)
  const PAGE = 260;                       // długość kawałka świata (punkty trasy)
  const CP_LEN = 560;                     // odstęp punktów kontrolnych (bez końca)
  function trackFor() {
    const key = cfg.route + '|' + cfg.seed + '|' + cfg.shape + '|' + (cfg.route === 'ab' ? cfg.abLen : '');
    if (previewTrack && previewTrack.key === key) return previewTrack;
    const t = cfg.route === 'loop' ? Object.assign(genTrack(cfg.seed, cfg.shape), { loop: true })
      : makeOpenTrack(cfg.seed, cfg.shape, cfg.route, AB_LEN[cfg.abLen]);
    t.key = key;
    return t;
  }
  // indeks punktu trasy: w pętli zawija się, na trasie otwartej zatrzymuje na końcach
  const ti = k => { const t = game.track; return t.loop ? ((k % t.N) + t.N) % t.N : (k < 0 ? 0 : k >= t.N ? t.N - 1 : k); };

  function newRacer(ch, veh, human, k, lane, track) {
    const { X, Z, NX, NZ, HD } = track;
    return {
      ch, veh, human, x: X[k] + NX[k] * lane, z: Z[k] + NZ[k] * lane, y: 0, vx: 0, vz: 0, vy: 0, h: HD[k],
      steer: 0, driftT: 0, spinMax: 1, spinBase: 0, idx: k, lap: 0, armed: true, prog: k, finished: false, finishT: 0, lapStart: 0, bestLap: 0,
      item: null, itemT: 0, turboT: 0, shieldT: 0, spinT: 0, slipT: 0, ghostT: 0, offT: 0, wrongT: 0,
      wheel: 0, fwd: 0, ctrl: { thr: 0, steer: 0, item: false }, prevItem: false, place: 0, msg: '', msgT: 0,
      ai: { lane: lane, laneT: 0, stuckT: 0, revT: 0, skill: 1, mul: 1 }, camH: HD[k], fov: 1.2, shake: 0, eng: null, surf: S_ROAD,
      timeLeft: 40, nextCP: START_K + CP_LEN, cps: 0, stopped: false
    };
  }

  // bramy na trasie otwartej w zakresie punktów
  function gatesNear(track, a, b) {
    const out = [];
    if (track.loop) return out;
    if (START_K >= a && START_K < b) out.push({ k: START_K, kind: 'start' });
    if (track.mode === 'ab') { if (track.finishK >= a && track.finishK < b) out.push({ k: track.finishK, kind: 'finish' }); }
    else for (let k = START_K + CP_LEN * Math.max(1, Math.ceil((a - START_K) / CP_LEN)); k < b; k += CP_LEN) out.push({ k, kind: 'cp' });
    return out;
  }

  // zadanie: zbuduj stronę świata (dane, potem siatki 3D albo mapę 2D)
  function* pageJob(index) {
    const g = game, tr = g.track;
    const k0 = index * PAGE, k1 = Math.min(tr.N, (index + 1) * PAGE);
    const box = pageBox(tr, k0, k1, g.world.barriers);
    const page = yield* genPage(tr, Object.assign({
      theme: g.world.theme, seed: cfg.seed, barriers: g.world.barriers, loop: false, k0, k1, index,
      gates: gatesNear(tr, k0 - 150, k1 + 150)
    }, box));
    if (game !== g) return;
    addPage(page);
    yield* pageVisuals(page);
  }
  function addPage(p) {
    const w = game.world;
    game.pages.push(p);
    w.boxes.push(...p.boxes); w.tnts.push(...p.tnts); w.hazards.push(...p.hazards);
  }
  function* pageVisuals(p) {
    if (game.mode === '3d') {
      p.model = M.trans(p.ox, 0, p.oz);
      p.chunks = [];
      for (let cz = 0; cz < p.D; cz += CH) for (let cx = 0; cx < p.W; cx += CH) {
        const mb = BG.buildChunk(p, cx, cz, CH, !!p.own);
        if (mb.n) p.chunks.push({ m: R.upload(mb), x: cx + CH / 2 + p.ox, z: cz + CH / 2 + p.oz });
        yield;
      }
    } else p.map2d = yield* map2DGen(p);
    // dane potrzebne tylko do budowy – zwolnij pamięć (trasy otwarte)
    if (p.own) { p.vox = null; p.dist = null; p.near = null; }
  }
  function freePage(p) {
    if (p.chunks) for (const c of p.chunks) R.free(c.m);
    p.chunks = null; p.map2d = null;
    const w = game.world, inP = o => o.k >= p.k0 && o.k < p.k1;
    w.boxes = w.boxes.filter(o => !inP(o));
    w.tnts = w.tnts.filter(o => !(o.fixed && inP(o)));
    w.hazards = w.hazards.filter(o => !inP(o));
    if (lastP === p) lastP = null;
  }
  // które strony są potrzebne: od tyłu stawki do ~700 bloków przed prowadzącym
  function ensurePages(sync) {
    const g = game, tr = g.track;
    if (tr.loop) return;
    const humans = g.humans.map(r => r.idx);
    const lead = Math.max(...g.racers.map(r => r.idx)), tail = Math.min(...humans);
    const want0 = Math.max(0, Math.floor((tail - 160) / PAGE)), want1 = Math.floor((lead + 720) / PAGE);
    if (tr.mode === 'endless') extendTrack(tr, (want1 + 1) * PAGE + 160);
    for (let i = want0; i <= want1; i++) {
      if (i * PAGE >= tr.N - (tr.mode === 'endless' ? 160 : 0) || g.pageIdx.has(i)) continue;
      g.pageIdx.add(i);
      const job = pageJob(i);
      if (sync) runGen(job); else g.jobs.push(job);
    }
    for (const p of g.pages.slice()) if (p.index < want0 - 1) {
      freePage(p);
      g.pages.splice(g.pages.indexOf(p), 1);
      g.pageIdx.delete(p.index);
    }
  }
  function pumpJobs(ms) {
    const g = game, t0 = performance.now();
    while (g.jobs.length && performance.now() - t0 < ms) {
      if (g.jobs[0].next().done) g.jobs.shift();
    }
  }

  // online: { roster: [{k: 'b'|miejsce, c, v}], mySlot, host, go }
  function startRace(online) {
    let mode = cfg.view;
    if (mode === '3d' && !ensureRenderer()) {
      mode = '2d';
      alert('Ta przeglądarka nie obsługuje grafiki 3D (WebGL) – gra uruchomi się w widoku 2D z góry.');
    }
    Snd.init();
    endGame();
    const track = trackFor();
    const theme = cfg.theme === 'losowy' ? ['laka', 'pustynia', 'zima'][cfg.seed % 3] : cfg.theme;
    const world = { theme, th: THEMES[theme], barriers: cfg.barriers, boxes: [], tnts: [], hazards: [] };
    let clouds = null, sea = null;
    if (mode === '3d') {
      // chmury (kafel 640×640 powtarzany wokół kamery) i morze pod światem
      const cl = new MeshBuilder(), cn = makeNoise(cfg.seed + 99);
      for (let gx = 0; gx < 640; gx += 8) for (let gz = 0; gz < 640; gz += 8) {
        if (cn(gx / 40, gz / 40) > 0.6) cl.box(gx, 40, gz, gx + 8, 41.5, gz + 8, T.white, [1, 1, 1]);
      }
      const sm = new MeshBuilder();
      const S = 700, sc = world.th.sea;
      sm.quad([[-S, -0.9, -S], [S, -0.9, -S], [S, -0.9, S], [-S, -0.9, S]], T.white, sc);
      clouds = R.upload(cl); sea = R.upload(sm);
    }
    // zawodnicy
    const N = track.N;
    const humans = cfg.players;
    const used = new Set(cfg.chars.slice(0, humans));
    const botChars = [];
    for (let i = 0; i < CHARS.length && botChars.length < cfg.bots; i++) if (!used.has(i)) botChars.push(i);
    const racers = [];
    let order = botChars.map(c => ({ c, h: -1, v: Math.floor(Math.random() * VEH.length) }))
      .concat(cfg.chars.slice(0, humans).map((c, i) => ({ c, h: i, v: cfg.veh[i] })));
    if (online) {
      // kolejność na starcie taka sama u wszystkich: komputer, potem gracze według miejsc
      let bi = 0;
      order = online.roster.map(e => e.k === 'b'
        ? { c: e.c, h: -1, v: e.v, net: 'b', bi: bi++, remote: !online.host }
        : { c: e.c, v: e.v, h: e.k === online.mySlot ? 0 : -1, net: e.k, netHuman: e.k !== online.mySlot, remote: e.k !== online.mySlot });
    }
    order.forEach((o, i) => {
      const k = track.loop ? (N - 10 - i * 7) % N : START_K - 4 - i * 7;
      const r = newRacer(o.c, o.v, o.h, k, (i % 2 ? -1 : 1) * HW * 0.4, track);
      r.ai.skill = [0.8, 0.9, 0.985][cfg.diff] - (o.h < 0 ? (botChars.indexOf(o.c) * 0.012) : 0);
      if (mode === '2d') r.sprite = makeSprite(o.v, o.c);
      if (o.net !== undefined) { r.net = o.net; r.bi = o.bi; r.remote = !!o.remote; r.netHuman = !!o.netHuman; r.snaps = []; }
      racers.push(r);
    });
    const humanRacers = racers.filter(r => r.human >= 0).sort((a, b) => a.human - b.human);
    humanRacers.forEach(r => { r.eng = Snd.engine(); });
    game = {
      mode, track, world, pages: [], pageIdx: new Set(), jobs: [], clouds, sea, racers, humans: humanRacers,
      t: -3.5, state: 'countdown', parts: [], endT: 0, firstFinishT: 0, lastBeep: 4, minimap: makeMinimap(track), pageT: 0,
      net: online ? { host: online.host, mySlot: online.mySlot, go: online.go, ev: [], evN: 0, seen: new Set(), sendT: 0 } : null
    };
    if (online) game.t = Math.min(-0.5, (net.serverNow() - online.go) / 1000);
    lastP = null;
    if (track.loop) {
      const page = runGen(genPage(track, { theme, seed: cfg.seed, barriers: cfg.barriers, loop: true, k0: 0, k1: N, ox: 0, oz: 0, W: track.W, D: track.D }));
      addPage(page);
      runGen(pageVisuals(page));
    } else ensurePages(true);
    paused = false;
    showScreen('race');
    layout();
  }

  function endGame() {
    if (!game) return;
    for (const p of game.pages) if (p.chunks) for (const c of p.chunks) R.free(c.m);
    if (game.mode === '3d') { R.free(game.clouds); R.free(game.sea); }
    for (const r of game.racers) if (r.eng) r.eng.stop();
    game = null;
  }

  // ---------- świat: zapytania (komórka → strona świata) ----------
  let lastP = null, curP = null;
  function inPage(p, ix, iz) {
    const lx = ix - p.ox, lz = iz - p.oz;
    return lx >= 0 && lz >= 0 && lx < p.W && lz < p.D && (!p.own || p.own[lz * p.W + lx]);
  }
  // zwraca indeks komórki w stronie curP albo -1
  function cellIdx(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    let p = lastP && inPage(lastP, ix, iz) ? lastP : null;
    if (!p) for (const q of game.pages) if (inPage(q, ix, iz)) { p = lastP = q; break; }
    curP = p;
    return p ? (iz - p.oz) * p.W + (ix - p.ox) : -1;
  }
  // wysokość przeszkody w komórce; w pętli poza światem jest ściana, na trasie otwartej – morze
  function colHAt(x, z) {
    const c = cellIdx(x, z);
    return c < 0 ? (game.track.loop ? 99 : 0) : curP.colH[c];
  }

  // ---------- sterowanie ----------
  const keys = new Set();
  const BIND = [
    { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], item: ['Space', 'KeyE', 'KeyQ', 'ShiftLeft'] },
    { up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], item: ['Enter', 'ShiftRight', 'Slash', 'Numpad0', 'ControlRight', 'NumpadEnter'] }
  ];
  const GAME_KEYS = new Set([].concat(...BIND.map(b => [].concat(b.up, b.down, b.left, b.right, b.item))));
  const touch = [{}, {}];
  addEventListener('keydown', e => {
    if (game && $('race').classList.contains('show') && GAME_KEYS.has(e.code)) e.preventDefault();
    if ((e.code === 'Escape' || e.code === 'KeyP') && game && game.state !== 'done') { e.preventDefault(); setPause(!paused); return; }
    keys.add(e.code);
  });
  addEventListener('keyup', e => keys.delete(e.code));
  addEventListener('blur', () => { keys.clear(); if (game && !game.net && game.state !== 'done') setPause(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && game && !game.net && game.state !== 'done') setPause(true); });

  function readInput(r) {
    const p = r.human;
    const binds = cfg.players === 1 ? [BIND[0], BIND[1]] : [BIND[p]];
    const any = list => binds.some(b => list(b).some(k => keys.has(k)));
    let up = any(b => b.up), down = any(b => b.down), left = any(b => b.left), right = any(b => b.right), item = any(b => b.item);
    const t = touch[p];
    up = up || t.up; down = down || t.down; left = left || t.left; right = right || t.right; item = item || t.item;
    let steer = (right ? 1 : 0) - (left ? 1 : 0), thr = (up ? 1 : 0) - (down ? 1 : 0);
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const padList = [];
    for (const g of pads) if (g && g.connected) padList.push(g);
    const pad = padList[p];
    if (pad) {
      const ax = pad.axes[0] || 0;
      if (Math.abs(ax) > 0.2) steer = clamp(ax, -1, 1);
      const bt = i => pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.3);
      if (bt(0) || bt(7)) thr = 1;
      if (bt(1) || bt(6)) thr = -1;
      if (bt(14)) steer = -1; if (bt(15)) steer = 1;
      if (bt(12)) thr = 1; if (bt(13)) thr = -1;
      if (bt(2) || bt(3) || bt(5) || bt(4)) item = true;
    }
    r.ctrl.thr = thr; r.ctrl.steer = steer;
    r.ctrl.item = item && !r.prevItem;
    r.prevItem = item;
  }

  // ---------- komputerowy kierowca ----------
  function aiInput(r, dt) {
    const tr = game.track, N = tr.N, a = r.ai;
    const speed = Math.hypot(r.vx, r.vz);
    const curLat = (r.x - tr.X[r.idx]) * tr.NX[r.idx] + (r.z - tr.Z[r.idx]) * tr.NZ[r.idx];
    a.laneT -= dt;
    if (a.laneT <= 0) { a.lane = (Math.random() - 0.5) * HW * 0.9; a.laneT = 3 + Math.random() * 4; }
    let lane = a.lane;
    // omijanie przeszkód
    let hazardAhead = null;
    const list = game.world.hazards.concat(game.dropped || []);
    for (const hz of list) {
      if (hz.ref && !hz.ref.active) continue;
      const df = tr.loop ? (hz.k - r.idx + N) % N : hz.k - r.idx;
      if (df < 3 || df > 50) continue;
      const vr = VEH[r.veh].r;
      if (Math.abs(lane - hz.o) < hz.rad + vr + 0.5) {
        const l1 = hz.o - hz.rad - vr - 0.8, l2 = hz.o + hz.rad + vr + 0.8;
        const ok1 = l1 > -HW + vr, ok2 = l2 < HW - vr;
        lane = ok1 && ok2 ? (Math.abs(l1 - curLat) < Math.abs(l2 - curLat) ? l1 : l2) : ok1 ? l1 : l2;
      }
      if (!hazardAhead || df < hazardAhead.df) hazardAhead = { df, hz };
    }
    const look = Math.round(8 + speed * 0.42);
    const k = ti(r.idx + look);
    const tx = tr.X[k] + tr.NX[k] * lane, tz = tr.Z[k] + tr.NZ[k] * lane;
    const want = Math.atan2(tx - r.x, tz - r.z);
    const diff = angDiff(want, r.h);
    let steer = clamp(-diff * 2.6, -1, 1);
    const curv = tr.CURV[r.idx];
    const vmax = VEH[r.veh].vmax * r.ai.mul;
    const curvFar = tr.CURV[ti(r.idx + Math.round(speed * 0.5))];
    const target = vmax * (1 - Math.min(0.55, Math.max(curv, curvFar) * 0.5));
    let thr = speed < target ? 1 : (speed > target + 4 ? -1 : 0);
    if (Math.abs(diff) > 0.9 && speed > 15) thr = -1;
    // utknięcie
    if (a.revT > 0) { a.revT -= dt; thr = -1; steer = -steer; }
    else if (Math.abs(r.fwd) < 2 && game.state === 'race' && r.spinT <= 0) { a.stuckT += dt; if (a.stuckT > 1.3) { a.revT = 0.9; a.stuckT = 0; } }
    else a.stuckT = 0;
    // bonusy
    let item = false;
    if (r.item) {
      r.itemT += dt;
      const lvl = cfg.diff;
      if (r.item === 'turbo') item = curv < 0.25 && r.itemT > 0.8;
      else if (r.item === 'tarcza') item = (hazardAhead && hazardAhead.df < 24) || r.itemT > 5;
      else if (r.item === 'skok') item = (hazardAhead && hazardAhead.hz.type === 'pile' && hazardAhead.df > 6 && hazardAhead.df < 16 && Math.abs(curLat - hazardAhead.hz.o) < 4) || r.itemT > 7;
      else if (r.item === 'tnt') {
        const behind = game.racers.some(o => o !== r && ((r.prog - o.prog) > 5 && (r.prog - o.prog) < 28));
        item = (behind && r.itemT > 1) || r.itemT > 9;
      }
      if (lvl === 0 && Math.random() < 0.5) item = item && r.itemT > 2.5;
    }
    r.ctrl.thr = thr; r.ctrl.steer = steer; r.ctrl.item = item;
  }

  // ---------- fizyka ----------
  function useItem(r) {
    const it = r.item;
    if (!it) return;
    if (it === 'skok' && r.y > groundUnder(r) + 0.05) return;
    r.item = null; r.itemT = 0;
    const fx = Math.sin(r.h), fz = Math.cos(r.h);
    const heard = r.human >= 0;
    if (it === 'turbo') {
      r.turboT = 2.4;
      r.vx += fx * 6 * SPD; r.vz += fz * 6 * SPD;
      if (heard) Snd.turbo();
    } else if (it === 'tarcza') {
      r.shieldT = 6;
      if (heard) Snd.beep(520, 0.3, 'triangle', 0.1, 1040);
    } else if (it === 'tnt') {
      const back = VEH[r.veh].r + 1.8;
      const t = { id: (game.net ? game.net.mySlot : 'L') + '_' + (game.tntN = (game.tntN || 0) + 1), x: r.x - fx * back, z: r.z - fz * back, active: true, t: 0, fixed: false, armT: 0.7, owner: r };
      const tr = game.track;
      t.k = r.idx; t.o = (t.x - tr.X[r.idx]) * tr.NX[r.idx] + (t.z - tr.Z[r.idx]) * tr.NZ[r.idx];
      game.world.tnts.push(t);
      (game.dropped = game.dropped || []).push({ k: t.k, o: t.o, rad: 1.9, type: 'tnt', ref: t });
      netEvent('t', t.id, +t.x.toFixed(2), +t.z.toFixed(2));
      if (heard) Snd.beep(200, 0.15, 'square', 0.1);
    } else if (it === 'skok') {
      r.vy = 10.5 * K;
      if (heard) Snd.boing();
    }
  }

  function startSpin(r, t) {
    const tr = game.track;
    r.spinT = r.spinMax = t;
    // po zarzuceniu pojazd ustawia się wzdłuż trasy
    r.spinBase = r.h + angDiff(tr.HD[r.idx], r.h) * (r.wrongT > 0 ? 0 : 0.7);
  }

  function groundUnder(r) {
    const h = colHAt(r.x, r.z);
    return h <= r.y + 0.35 ? h : 0;
  }

  function explode(x, y, z) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
      const hot = i < 14;
      game.parts.push({ x, y: y + 0.5, z, vx: Math.cos(a) * s, vy: 2 + Math.random() * 6, vz: Math.sin(a) * s, g: hot ? -2 : 6, life: 0, max: 0.5 + Math.random() * 0.6, size: hot ? 1.2 : 0.9, grow: 1.6, col: hot ? [1, 0.6 + Math.random() * 0.3, 0.15] : [0.35, 0.35, 0.35], a: 0.95, tile: T.puff });
    }
  }
  function puff(x, y, z, col, n, spread, size) {
    for (let i = 0; i < n; i++) {
      game.parts.push({ x: x + (Math.random() - 0.5) * spread, y, z: z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 1.5, vz: (Math.random() - 0.5) * 2, g: -0.5, life: 0, max: 0.5 + Math.random() * 0.4, size: size || 0.6, grow: 1.2, col, a: 0.7, tile: T.puff });
    }
  }

  function message(r, text, t) { r.msg = text; r.msgT = t || 1.6; }

  function stepRacer(r, dt) {
    const w = game.world, tr = game.track, N = tr.N;
    r.turboT = Math.max(0, r.turboT - dt); r.shieldT = Math.max(0, r.shieldT - dt);
    r.spinT = Math.max(0, r.spinT - dt); r.slipT = Math.max(0, r.slipT - dt); r.ghostT = Math.max(0, r.ghostT - dt);
    r.msgT = Math.max(0, r.msgT - dt);
    const racing = game.state === 'race' || game.state === 'finishing';
    if (r.stopped) { r.ctrl.thr = 0; r.ctrl.steer = 0; r.ctrl.item = false; }
    else if (r.human < 0 || r.finished || r.auto) aiInput(r, dt); else readInput(r);
    if (racing && r.ctrl.item) useItem(r);

    const c = cellIdx(r.x, r.z), cp = curP;
    const ground = groundUnder(r);
    const onGround = r.y <= ground + 0.02 && r.vy <= 0;
    const surf = onGround && c >= 0 ? (cp.colH[c] > 0 ? S_ROAD : cp.surf[c]) : -1;
    r.surf = surf;
    const shield = r.shieldT > 0;

    r.steer += clamp(r.ctrl.steer - r.steer, -dt * 7, dt * 7);
    let fx = Math.sin(r.h), fz = Math.cos(r.h);
    let fwd = r.vx * fx + r.vz * fz, lat = r.vx * fz - r.vz * fx;

    const V = VEH[r.veh];
    let vmax = V.vmax * (r.human < 0 || r.finished || r.auto ? r.ai.mul : 1);
    const vbase = vmax;
    if (r.finished) vmax *= 0.6;
    let mul = 1;
    if (surf === S_OFF) mul = V.off;
    else if (surf === S_MUD && !shield) mul = V.mud;
    else if (surf === S_WATER) mul = Math.max(0.35, V.off * 0.6);
    if (r.turboT > 0) mul = Math.max(mul, 1) * 1.5;
    vmax *= mul;
    const accel = r.turboT > 0 ? V.acc * 2.2 : V.acc;
    // drift: hamulec + mocny skręt przy dużej prędkości; po wyjściu z driftu mały zastrzyk turbo
    const drifting = onGround && racing && r.spinT <= 0 && r.ctrl.thr < -0.1 && Math.abs(r.ctrl.steer) > 0.5 && fwd > vbase * 0.45;

    if (onGround) {
      if (!racing) fwd *= Math.exp(-6 * dt);
      else if (r.spinT > 0) fwd *= Math.exp(-2.5 * dt);
      else {
        const th = r.ctrl.thr;
        if (th > 0.1) { if (fwd < vmax) fwd = Math.min(vmax, fwd + accel * th * dt); }
        else if (drifting) fwd -= 5 * SPD * dt;
        else if (th < -0.1) { if (fwd > 0.5) fwd -= 30 * SPD * -th * dt; else fwd = Math.max(-7 * K, fwd - 11 * K * -th * dt); }
        else fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), 5 * SPD * dt);
        if (r.turboT > 0) fwd = Math.max(fwd, vmax * 0.85);
        if (fwd > vmax) fwd = Math.max(vmax, fwd - 26 * SPD * dt);
      }
      // przyczepność
      let grip = V.grip;
      if (r.slipT > 0 && !shield) grip = 1.0;
      if (surf === S_ICE && !shield) { grip = 1.3; }
      if (drifting) grip = Math.min(grip, 2.6);
      lat *= Math.exp(-grip * dt);
      if (drifting) lat = clamp(lat, -0.4 * fwd, 0.4 * fwd);
    }
    if (drifting) {
      r.driftT += dt;
      if (Math.random() < 0.6) puff(r.x - fx * V.r, r.y + 0.2, r.z - fz * V.r, [0.85, 0.85, 0.85], 1, V.r, 0.8);
    } else if (r.driftT > 0) {
      if (r.driftT > 0.6 && racing) {
        r.turboT = Math.max(r.turboT, Math.min(1.5, r.driftT * 0.6));
        if (r.human >= 0) { message(r, '🔥 Drift! +turbo', 1); Snd.turbo(); }
      }
      r.driftT = 0;
    }
    // skręcanie
    if (racing && r.spinT <= 0) {
      const sp = Math.abs(fwd);
      const k = clamp(sp / (5 * K), 0, 1) * (1 - Math.min(0.3, sp / V.vmax * 0.25)) * (drifting ? 1.4 : 1.12);
      let st = r.steer;
      if (r.human >= 0 && !r.auto && cfg.assist && fwd > 3) {
        // pomoc w kierowaniu: nie da się zawrócić w miejscu, a bez skrętu auto samo prostuje się wzdłuż trasy
        const dev = angDiff(r.h, tr.HD[r.idx]);
        if (Math.abs(dev) > 1.0 && Math.sign(-st) === Math.sign(dev)) st = 0;
        if (Math.abs(r.ctrl.steer) < 0.1 && onGround && Math.abs(dev) < 1.3) {
          // trzymanie się drogi: celuj w punkt przed sobą, na swoim pasie (nie dalej niż przy krawężniku)
          const lat0 = (r.x - tr.X[r.idx]) * tr.NX[r.idx] + (r.z - tr.Z[r.idx]) * tr.NZ[r.idx];
          const lane = clamp(lat0, -HW * 0.65, HW * 0.65);
          const kk = ti(r.idx + Math.round(6 + fwd * 0.35));
          const want = Math.atan2(tr.X[kk] + tr.NX[kk] * lane - r.x, tr.Z[kk] + tr.NZ[kk] * lane - r.z);
          r.h += angDiff(want, r.h) * Math.min(1, 3 * dt);
        }
      }
      r.h += -st * V.turn * k * Math.sign(fwd || 1) * dt * (onGround ? 1 : 0.35);
    }
    if (r.spinT > 0) {
      // zarzucenie zamiast obrotu w kółko – pojazd wraca na kierunek jazdy
      const p = 1 - r.spinT / r.spinMax;
      r.h = r.spinBase + Math.sin(p * Math.PI * 3) * 0.55 * (1 - p);
    }
    fx = Math.sin(r.h); fz = Math.cos(r.h);
    r.vx = fx * fwd + fz * lat; r.vz = fz * fwd - fx * lat;
    r.fwd = fwd;

    r.x += r.vx * dt; r.z += r.vz * dt;

    // pion: skoki i spadanie
    const g2 = groundUnder(r);
    if (r.y > g2 + 0.001 || r.vy > 0) {
      r.vy -= 26 * K * dt; r.y += r.vy * dt;
      if (r.y <= g2) {
        if (r.vy < -9 * K) { puff(r.x, r.y + 0.1, r.z, w.th.dust, 6, 1.6, 0.7); if (r.human >= 0) Snd.bump(); r.shake = 0.25; }
        r.y = g2; r.vy = 0;
      }
    } else r.y = g2;

    // trampolina, olej, lód
    if (onGround && racing && c >= 0) {
      if (surf === S_SLIME && Math.abs(fwd) > 3) { r.vy = 9.5 * K; if (r.human >= 0) Snd.boing(); puff(r.x, 0.2, r.z, [0.5, 0.95, 0.4], 5, 1.4, 0.5); }
      if (surf === S_OIL && !shield && r.slipT <= 0 && Math.abs(fwd) > 8) { r.slipT = 0.8; startSpin(r, 0.7); message(r, 'Plama oleju!'); if (r.human >= 0) Snd.beep(300, 0.3, 'sine', 0.1, 150); }
      if (surf === S_MUD && !shield && Math.abs(fwd) > 4 && Math.random() < 0.3) puff(r.x, 0.2, r.z, [0.35, 0.24, 0.12], 1, 1.2, 0.5);
      if (surf === S_OFF && Math.abs(fwd) > 10 && Math.random() < 0.45) puff(r.x - fx * V.r, 0.2, r.z - fz * V.r, w.th.dust, 1, 1.2, 0.55);
    }
    if (r.turboT > 0 && Math.random() < 0.8) {
      game.parts.push({ x: r.x - fx * V.r * 1.4 + (Math.random() - 0.5) * 0.6, y: r.y + 0.7, z: r.z - fz * V.r * 1.4, vx: -fx * 5, vy: 0.5, vz: -fz * 3, g: 0, life: 0, max: 0.25, size: 0.55, grow: -1, col: [1, 0.55 + Math.random() * 0.35, 0.1], a: 1, tile: T.glow });
    }

    collideCells(r);
    if (w.barriers) collideWall(r, V);

    // bonusy
    for (const b of w.boxes) {
      if (!b.active) continue;
      const dx = r.x - b.x, dz = r.z - b.z;
      if (dx * dx + dz * dz < (V.r + 0.9) ** 2 && r.y < 3.5) {
        b.active = false; b.t = 3;
        netEvent('b', b.id);
        for (let i = 0; i < 8; i++) game.parts.push({ x: b.x, y: 1.6, z: b.z, vx: (Math.random() - 0.5) * 5, vy: Math.random() * 4 + 1, vz: (Math.random() - 0.5) * 5, g: 8, life: 0, max: 0.5, size: 0.35, grow: 0, col: [1, 0.85, 0.2], a: 1, tile: T.glow });
        if (!r.item) {
          r.item = rollItem(r); r.itemT = 0;
          if (r.human >= 0) { Snd.pickup(); message(r, ITEMS[r.item].icon + ' ' + ITEMS[r.item].name + '!', 1.2); }
        }
      }
    }
    // TNT
    for (const t of w.tnts) {
      if (!t.active || (t.owner === r && t.armT > 0)) continue;
      const dx = r.x - t.x, dz = r.z - t.z;
      if (dx * dx + dz * dz < (V.r + 1) ** 2 && r.y < 1.8) {
        t.active = false; t.t = 7;
        netEvent('x', t.id);
        explode(t.x, 0, t.z);
        if (game.humans.some(h => Math.hypot(h.x - t.x, h.z - t.z) < 40)) Snd.boom();
        if (!shield) { startSpin(r, 1.0); r.vy = 6 * K; r.vx *= 0.25; r.vz *= 0.25; message(r, 'BUM!', 1.2); r.shake = 0.5; }
        else message(r, 'Tarcza ochroniła Cię!', 1.2);
      }
    }

    // pozycja na torze, okrążenia
    let best = r.idx, bd = Infinity;
    for (let o = -14; o <= 14; o++) {
      const k = ti(r.idx + o);
      const dx = tr.X[k] - r.x, dz = tr.Z[k] - r.z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = k; }
    }
    const prev = r.idx;
    if (!tr.loop) {
      // trasa otwarta: meta (A→B) albo punkty kontrolne z czasem (bez końca)
      if (tr.mode === 'ab' && best >= tr.finishK && !r.finished && racing) finishRacer(r);
      if (tr.mode === 'endless' && r.human >= 0 && !r.finished && racing) {
        r.timeLeft -= dt;
        if (best >= r.nextCP) {
          r.cps++;
          const bonus = Math.max(12, 21 - r.cps * 0.5);
          r.timeLeft += bonus; r.nextCP += CP_LEN;
          message(r, '⏱️ Punkt kontrolny! +' + Math.round(bonus) + ' s', 1.6);
          Snd.beep(990, 0.12, 'square', 0.09); setTimeout(() => Snd.beep(1320, 0.15, 'square', 0.09), 110);
        }
        if (r.timeLeft <= 0) {
          r.timeLeft = 0; r.finished = true; r.stopped = true; r.finishT = game.t;
          message(r, '⌛ Koniec czasu! ' + fmtDist(best - START_K), 4);
          Snd.beep(330, 0.5, 'sawtooth', 0.08, 110);
          if (!game.firstFinishT) game.firstFinishT = game.t;
        }
      }
    } else if (prev > N * 0.75 && best < N * 0.25) {
      if (r.armed) {
        r.lap++; r.armed = false;
        if (racing && r.lap >= 2) {
          const lt = game.t - r.lapStart;
          if (!r.bestLap || lt < r.bestLap) r.bestLap = lt;
        }
        r.lapStart = game.t;
        if (r.lap > cfg.laps && !r.finished && racing) finishRacer(r);
        else if (r.lap === cfg.laps && r.human >= 0 && cfg.laps > 1) { message(r, 'Ostatnie okrążenie!', 2); Snd.beep(880, 0.25, 'square', 0.08); }
        else if (r.lap > 1 && r.human >= 0) message(r, 'Okrążenie ' + r.lap + '/' + cfg.laps, 1.4);
      }
    } else if (prev < N * 0.25 && best > N * 0.75) { r.lap--; r.armed = true; }
    if (tr.loop && best > N * 0.4 && best < N * 0.6) r.armed = true;
    r.idx = best;
    const along = (r.x - tr.X[best]) * tr.TX[best] + (r.z - tr.Z[best]) * tr.TZ[best];
    r.prog = r.lap * N + best + clamp(along, -0.5, 0.5);
    const latOff = Math.abs((r.x - tr.X[best]) * tr.NX[best] + (r.z - tr.Z[best]) * tr.NZ[best]);

    // poza trasą → powrót na tor
    const limit = w.barriers ? WALL + 2 : HW + 26;
    if (!w.barriers && latOff > HW + 17 && r.human >= 0 && racing) message(r, 'Wracaj na trasę!', 0.3);
    if (latOff > limit && (onGround || !w.barriers)) {
      r.offT += dt;
      if (r.offT > (w.barriers ? 0.7 : 0.4)) respawn(r);
    } else r.offT = 0;
    // zły kierunek
    if (racing && !r.finished && fx * tr.TX[best] + fz * tr.TZ[best] < -0.35 && Math.abs(fwd) > 2) r.wrongT += dt; else r.wrongT = 0;
    if (cfg.assist && r.human >= 0 && r.wrongT > 2.5) { respawn(r); r.wrongT = 0; }
    // utknięcie (np. przodem w bandzie) mimo gazu → powrót na trasę
    if (cfg.assist && r.human >= 0 && !r.auto && racing && r.ctrl.thr > 0.5 && Math.abs(fwd) < 2.5 && r.spinT <= 0) r.stuckT = (r.stuckT || 0) + dt;
    else r.stuckT = 0;
    if (r.stuckT > 1.8) { respawn(r); r.stuckT = 0; }
    // komputer (i autopilot po mecie): brak postępu przez kilka sekund → powrót na trasę
    if (racing) {
      if (r.prog > (r.bestProg || 0) + 6) { r.bestProg = r.prog; r.progT = 0; } else r.progT = (r.progT || 0) + dt;
      if ((r.human < 0 || r.finished || r.auto) && r.progT > 3.5) respawn(r);
    }
    r.wheel += fwd * dt / V.wr;
    r.shake = Math.max(0, r.shake - dt);
  }

  function rollItem(r) {
    const p = r.place, n = game.racers.length;
    const back = n > 1 ? p / (n - 1) : 0.5;
    const wts = [['turbo', 2.5 + back * 4], ['tarcza', 2], ['tnt', 3.2 - back * 2], ['skok', 1.8]];
    let s = wts.reduce((a, b) => a + b[1], 0) * Math.random();
    for (const [k, v] of wts) { s -= v; if (s <= 0) return k; }
    return 'turbo';
  }

  function respawn(r) {
    const tr = game.track;
    // wolne miejsce na trasie (bez kupki bloków) w pobliżu
    let k = r.idx;
    for (let i = 0; i < 30; i++) {
      const kk = ti(r.idx + i), c = cellIdx(tr.X[kk], tr.Z[kk]);
      if (c >= 0 && curP.colH[c] === 0) { k = kk; break; }
    }
    r.idx = k; r.bestProg = r.prog; r.progT = 0;
    r.x = tr.X[k]; r.z = tr.Z[k]; r.y = 0; r.vx = r.vz = r.vy = 0; r.h = tr.HD[k]; r.camH = r.h;
    r.offT = 0; r.spinT = 0; r.slipT = 0; r.ghostT = 1.8;
    if (r.human >= 0) message(r, 'Powrót na trasę', 1.2);
  }

  // Banda jako gładka linia wzdłuż toru: lekkie odbicie, mniejsza prędkość, auto prostuje się i jedzie dalej
  function collideWall(r, V) {
    const tr = game.track, k = r.idx;
    if (r.y > 2.2) return;
    const lat = (r.x - tr.X[k]) * tr.NX[k] + (r.z - tr.Z[k]) * tr.NZ[k];
    const lim = WALL - 0.5 - V.r;
    const over = Math.abs(lat) - lim;
    if (over <= 0 || over > 4) return;
    const sgn = Math.sign(lat), nx = -tr.NX[k] * sgn, nz = -tr.NZ[k] * sgn; // do środka toru
    r.x += nx * over; r.z += nz * over;
    const vn = r.vx * nx + r.vz * nz;
    if (vn >= 0) return;
    const hit = -vn;
    r.vx -= 1.25 * vn * nx; r.vz -= 1.25 * vn * nz;       // lekkie odbicie
    const keep = 1 - Math.min(0.3, hit * 0.012);         // zwolnienie zależne od siły uderzenia
    r.vx *= keep; r.vz *= keep;
    // ustaw pojazd wzdłuż bandy (w stronę, w którą jechał) i przekieruj część pędu wzdłuż niej
    const along = Math.sin(r.h) * tr.TX[k] + Math.cos(r.h) * tr.TZ[k] >= 0 ? 1 : -1;
    const fwdDir = along > 0 ? tr.HD[k] : tr.HD[k] + Math.PI;
    r.h += angDiff(fwdDir, r.h) * Math.min(0.7, 0.2 + hit * 0.02);
    r.vx += tr.TX[k] * along * hit * 0.4; r.vz += tr.TZ[k] * along * hit * 0.4;
    if (hit > 8) {
      r.shake = Math.min(0.3, hit * 0.01);
      if (r.human >= 0) Snd.bump();
      puff(r.x - nx * V.r, r.y + 0.6, r.z - nz * V.r, [0.85, 0.8, 0.6], 2, 0.8, 0.6);
    }
  }

  function collideCells(r) {
    const w = game.world, rad = VEH[r.veh].r;
    for (let pass = 0; pass < 2; pass++) {
      for (let gz = Math.floor(r.z - rad); gz <= Math.floor(r.z + rad); gz++) for (let gx = Math.floor(r.x - rad); gx <= Math.floor(r.x + rad); gx++) {
        const ci = cellIdx(gx + 0.5, gz + 0.5), cp = curP;
        if (ci < 0 ? !game.track.loop : (cp.colH[ci] <= r.y + 0.35 || cp.wallMask[ci])) continue;
        const cx = clamp(r.x, gx, gx + 1), cz = clamp(r.z, gz, gz + 1);
        let dx = r.x - cx, dz = r.z - cz, d2 = dx * dx + dz * dz;
        if (d2 >= rad * rad) continue;
        let d = Math.sqrt(d2), nx, nz;
        if (d < 1e-4) {
          nx = r.x - (gx + 0.5); nz = r.z - (gz + 0.5);
          if (Math.abs(nx) > Math.abs(nz)) { nx = Math.sign(nx); nz = 0; } else { nz = Math.sign(nz) || 1; nx = 0; }
          d = 0;
        } else { nx = dx / d; nz = dz / d; }
        const push = rad - d;
        r.x += nx * push; r.z += nz * push;
        const vn = r.vx * nx + r.vz * nz;
        if (vn < 0) {
          r.vx -= 1.35 * vn * nx; r.vz -= 1.35 * vn * nz;
          if (-vn > 9) {
            r.vx *= 0.75; r.vz *= 0.75; r.shake = 0.3;
            if (r.human >= 0) Snd.bump();
            puff(r.x - nx * rad, r.y + 0.5, r.z - nz * rad, [0.8, 0.8, 0.8], 3, 0.6, 0.5);
          }
        }
      }
    }
  }

  function collideRacers() {
    const rs = game.racers;
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i], b = rs[j];
      if (a.ghostT > 0 || b.ghostT > 0 || Math.abs(a.y - b.y) > 2 || a.offline || b.offline || (a.remote && b.remote)) continue;
      let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      const minD = VEH[a.veh].r + VEH[b.veh].r;
      if (d >= minD || d < 1e-4) continue;
      dx /= d; dz /= d;
      const push = (minD - d) / 2;
      let wa = (a.shieldT > 0 ? 0.2 : 1) / VEH[a.veh].mass, wb = (b.shieldT > 0 ? 0.2 : 1) / VEH[b.veh].mass;
      if (a.remote) wa = 0; if (b.remote) wb = 0;   // auto innego gracza przesuwa tylko jego właściciel
      const sum = wa + wb; wa = wa * 2 / sum; wb = wb * 2 / sum;
      a.x -= dx * push * wa; a.z -= dz * push * wa;
      b.x += dx * push * wb; b.z += dz * push * wb;
      const rel = (b.vx - a.vx) * dx + (b.vz - a.vz) * dz;
      if (rel < 0) {
        const imp = -rel * 0.75;
        a.vx -= dx * imp * wa; a.vz -= dz * imp * wa; b.vx += dx * imp * wb; b.vz += dz * imp * wb;
        if (imp > 5 && (a.human >= 0 || b.human >= 0)) Snd.bump();
      }
    }
  }

  // ---------- gra online: wysyłanie i odbiór stanu ----------
  function netEvent(type, ...args) {
    const n = game && game.net;
    if (!n) return;
    n.ev.push({ id: ++n.evN, t: game.t, a: [type, ...args] });
  }
  const FLAGS = { turbo: 1, shield: 2, ghost: 4, fin: 8, stop: 16, quit: 32 };
  function encRacer(r) {
    const f = (r.turboT > 0 ? 1 : 0) | (r.shieldT > 0 ? 2 : 0) | (r.ghostT > 0 ? 4 : 0) | (r.finished ? 8 : 0) | (r.stopped ? 16 : 0) | (r.quit ? 32 : 0);
    return [r.x.toFixed(2), r.z.toFixed(2), r.y.toFixed(2), r.h.toFixed(3), r.fwd.toFixed(1), r.steer.toFixed(2), r.idx, r.lap, f,
      r.finishT.toFixed(2), Math.max(0, r.timeLeft).toFixed(1), r.cps, r.prog.toFixed(1)].join(',');
  }
  function decRacer(str, t) {
    const v = str.split(',').map(Number);
    if (v.length < 13 || v.some(x => !Number.isFinite(x))) return null;
    return { t, x: v[0], z: v[1], y: v[2], h: v[3], fwd: v[4], steer: v[5], idx: v[6] | 0, lap: v[7] | 0, f: v[8] | 0, finishT: v[9], timeLeft: v[10], cps: v[11] | 0, prog: v[12] };
  }
  function netTick(dt) {
    const g = game, n = g.net;
    n.sendT -= dt;
    if (n.sendT > 0) return;
    const people = g.racers.filter(r => r.human >= 0 || r.netHuman).length;
    n.sendT = people > 4 ? 0.12 : 0.1;
    n.ev = n.ev.filter(e => e.t > g.t - 3);
    const ev = n.ev.length ? JSON.stringify(n.ev.map(e => [e.id, ...e.a])) : null;
    const me = g.humans[0];
    net.send(n.mySlot, g.t.toFixed(2) + '|' + encRacer(me), ev);
    if (n.host) {
      const bots = g.racers.filter(r => r.net === 'b');
      if (bots.length) net.send('b', g.t.toFixed(2) + '|' + bots.map(encRacer).join(';'));
    }
  }
  // stan od innych graczy (wszystkie miejsca naraz)
  function netReceive(val) {
    const g = game;
    if (!g || !g.net) return;
    for (const key of Object.keys(val)) {
      const item = val[key];
      if (!item || typeof item.d !== 'string') continue;
      if (key === String(g.net.mySlot) || (key === 'b' && g.net.host)) continue;
      const [ts, body] = item.d.split('|');
      const t = +ts;
      if (!Number.isFinite(t) || !body) continue;
      if (key === 'b') {
        body.split(';').forEach((str, i) => {
          const r = g.racers.find(q => q.net === 'b' && q.bi === i);
          const sn = decRacer(str, t);
          if (r && sn) pushSnap(r, sn);
        });
      } else {
        const r = g.racers.find(q => q.net === +key);
        const sn = decRacer(body, t);
        if (r && sn) pushSnap(r, sn);
      }
      if (typeof item.e === 'string' && item.e.length < 2000) {
        let list = null;
        try { list = JSON.parse(item.e); } catch (e) { /* uszkodzone */ }
        if (Array.isArray(list)) for (const ev of list) {
          if (!Array.isArray(ev)) continue;
          const id = key + ':' + ev[0];
          if (g.net.seen.has(id)) continue;
          g.net.seen.add(id);
          applyEvent(ev.slice(1), key);
        }
      }
    }
  }
  function pushSnap(r, sn) {
    const s = r.snaps;
    if (s.length && sn.t <= s[s.length - 1].t) return;
    s.push(sn);
    if (s.length > 30) s.shift();
  }
  function applyEvent(a, key) {
    const g = game, w = g.world, type = a[0];
    if (type === 'b') {
      const b = w.boxes.find(q => q.id === a[1]);
      if (b && b.active) {
        b.active = false; b.t = 3;
        for (let i = 0; i < 6; i++) g.parts.push({ x: b.x, y: 1.6, z: b.z, vx: (Math.random() - 0.5) * 5, vy: Math.random() * 4 + 1, vz: (Math.random() - 0.5) * 5, g: 8, life: 0, max: 0.5, size: 0.35, grow: 0, col: [1, 0.85, 0.2], a: 1, tile: T.glow });
      }
    } else if (type === 't' && typeof a[1] === 'string' && Number.isFinite(a[2]) && Number.isFinite(a[3])) {
      if (w.tnts.some(q => q.id === a[1])) return;
      const owner = g.racers.find(q => String(q.net) === key) || null;
      const tr = g.track, k = owner ? owner.idx : 0;
      const t = { id: a[1], x: a[2], z: a[3], active: true, t: 0, fixed: false, armT: 0.7, owner, k };
      t.o = (t.x - tr.X[k]) * tr.NX[k] + (t.z - tr.Z[k]) * tr.NZ[k];
      w.tnts.push(t);
      (g.dropped = g.dropped || []).push({ k, o: t.o, rad: 1.9, type: 'tnt', ref: t });
    } else if (type === 'x') {
      const t = w.tnts.find(q => q.id === a[1]);
      if (t && t.active) {
        t.active = false; t.t = 7;
        explode(t.x, 0, t.z);
        if (g.humans.some(h => Math.hypot(h.x - t.x, h.z - t.z) < 40)) Snd.boom();
      }
    }
  }
  // pojazd innego gracza: płynne przejście między odebranymi położeniami (z opóźnieniem ~0,15 s)
  function netInterp(r, dt) {
    const g = game, s = r.snaps;
    // rozłączony = brak nowych danych od 8 s (krótkie przerwy w zasięgu nie wyrzucają gracza z wyścigu)
    const lastT = s.length ? s[s.length - 1].t : 0;
    const quit = s.length && (s[s.length - 1].f & 32);
    if (r.netHuman) r.offline = !!quit || (g.t > 8 && g.t - lastT > 8);
    if (!s.length) return;
    const tt = g.t - 0.15, L = s[s.length - 1];
    let a = null, b = null;
    for (let i = s.length - 1; i >= 0; i--) if (s[i].t <= tt) { a = s[i]; b = s[i + 1] || null; break; }
    let x, z, y, h;
    if (a && b) {
      const f = (tt - a.t) / Math.max(1e-3, b.t - a.t);
      x = a.x + (b.x - a.x) * f; z = a.z + (b.z - a.z) * f; y = a.y + (b.y - a.y) * f; h = a.h + angDiff(b.h, a.h) * f;
    } else {
      const base = a || s[0], e = clamp(tt - base.t, 0, 0.3);
      x = base.x + Math.sin(base.h) * base.fwd * e; z = base.z + Math.cos(base.h) * base.fwd * e; y = base.y; h = base.h;
    }
    r.x = x; r.z = z; r.y = y; r.h = h;
    r.fwd = L.fwd; r.steer = L.steer; r.vx = Math.sin(h) * L.fwd; r.vz = Math.cos(h) * L.fwd;
    r.idx = L.idx; r.lap = L.lap; r.prog = L.prog; r.timeLeft = L.timeLeft; r.cps = L.cps;
    r.turboT = L.f & 1 ? 0.2 : 0; r.shieldT = L.f & 2 ? 0.2 : 0; r.ghostT = L.f & 4 ? 0.2 : 0;
    r.stopped = !!(L.f & 16);
    if ((L.f & 8) && !r.finished) { r.finished = true; r.finishT = L.finishT; if (r.netHuman && !g.firstFinishT) g.firstFinishT = g.t; }
    r.wheel += r.fwd * dt / VEH[r.veh].wr;
    if (r.turboT > 0 && Math.random() < 0.6) {
      const fx = Math.sin(h), fz = Math.cos(h), V = VEH[r.veh];
      g.parts.push({ x: x - fx * V.r * 1.4, y: y + 0.7, z: z - fz * V.r * 1.4, vx: -fx * 5, vy: 0.5, vz: -fz * 3, g: 0, life: 0, max: 0.25, size: 0.55, grow: -1, col: [1, 0.7, 0.1], a: 1, tile: T.glow });
    }
  }

  function finishRacer(r) {
    r.finished = true; r.finishT = game.t;
    if (r.human >= 0) {
      const place = 1 + game.racers.filter(o => o.finished && o !== r).length;
      message(r, place === 1 ? '🏆 Wygrana!' : 'Meta! ' + place + '. miejsce', 4);
      if (place === 1) { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => Snd.beep(f, 0.18, 'square', 0.08), i * 120)); }
      else Snd.beep(660, 0.3, 'square', 0.08);
      if (!game.firstFinishT) game.firstFinishT = game.t;
    }
  }

  function update(dt) {
    const g = game;
    if (g.state === 'countdown') {
      g.t += dt;
      const sec = Math.ceil(-g.t);
      if (sec < g.lastBeep && sec >= 1 && sec <= 3) { Snd.beep(440, 0.15, 'square', 0.1); g.lastBeep = sec; }
      if (g.t >= 0) { g.state = 'race'; g.t = 0; Snd.beep(880, 0.4, 'square', 0.12); for (const r of g.racers) r.lapStart = 0; }
    } else g.t += dt;
    // komputer: gumka (doganianie / czekanie) – względem wszystkich graczy (też online)
    const lead = Math.max(...g.racers.filter(r => (r.human >= 0 || r.netHuman) && !r.offline).map(h => h.prog));
    for (const r of g.racers) {
      if (r.human >= 0 && !r.finished && !r.auto) continue;
      let m = r.ai.skill;
      if (r.human < 0) {
        const gap = r.prog - lead;
        const L = g.track.loop ? g.track.N : 1300;
        if (gap > L * 0.25) m *= 0.92; else if (gap < -L * 0.2) m *= 1.07;
      }
      r.ai.mul = m;
    }
    for (const r of g.racers) { if (r.remote) netInterp(r, dt); else stepRacer(r, dt); }
    if (g.net) netTick(dt);
    if (!g.track.loop) {
      // komputer daleko za graczami (świat za nimi znika) → podjeżdża bliżej
      const tail = Math.min(...g.humans.map(h => h.idx));
      for (const r of g.racers) if (r.human < 0 && !r.remote && r.idx < tail - 230) { r.idx = ti(tail - 120); respawn(r); }
      g.pageT -= dt;
      if (g.pageT <= 0) { g.pageT = 0.4; ensurePages(false); }
    }
    collideRacers();
    // miejsca
    const endless = g.track.mode === 'endless';
    const sorted = g.racers.slice().sort((a, b) => endless ? b.prog - a.prog
      : (a.finished && b.finished) ? a.finishT - b.finishT : a.finished ? -1 : b.finished ? 1 : b.prog - a.prog);
    sorted.forEach((r, i) => r.place = i);
    // obiekty
    for (const b of g.world.boxes) if (!b.active) { b.t -= dt; if (b.t <= 0) b.active = true; }
    for (const t of g.world.tnts) {
      t.armT = Math.max(0, t.armT - dt);
      if (!t.active && t.fixed) { t.t -= dt; if (t.t <= 0) t.active = true; }
    }
    if (g.dropped) g.dropped = g.dropped.filter(h => h.ref.active);
    g.world.tnts = g.world.tnts.filter(t => t.active || t.fixed);
    for (const p of g.parts) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy -= p.g * dt; p.size = Math.max(0.05, p.size + p.grow * dt); }
    g.parts = g.parts.filter(p => p.life < p.max);
    if (g.parts.length > 400) g.parts.splice(0, g.parts.length - 400);
    // koniec wyścigu
    if (g.state === 'race' || g.state === 'finishing') {
      const allDone = g.racers.filter(r => (r.human >= 0 || r.netHuman) && !r.offline).every(h => h.finished);
      if (g.firstFinishT && g.state === 'race') g.state = 'finishing';
      if (allDone || (!endless && g.firstFinishT && g.t - g.firstFinishT > FINISH_WAIT)) {
        if (!g.endT) g.endT = g.t + 2.5;
      }
      if (g.endT && g.t >= g.endT) { g.state = 'done'; showResults(); }
    }
  }

  // ---------- rysowanie ----------
  let viewports = [];
  function layout() {
    const c = $('gl'), h = $('hud');
    const W = innerWidth, H = innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, cfg.players > 1 ? 1.5 : 1.75);
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    h.width = Math.round(W * dpr); h.height = Math.round(H * dpr);
    c.style.width = h.style.width = W + 'px'; c.style.height = h.style.height = H + 'px';
    const n = game ? game.humans.length : cfg.players;
    if (n <= 1) viewports = [{ x: 0, y: 0, w: W, h: H }];
    else if (W >= H) viewports = [{ x: 0, y: 0, w: W / 2, h: H }, { x: W / 2, y: 0, w: W / 2, h: H }];
    else viewports = [{ x: 0, y: 0, w: W, h: H / 2 }, { x: 0, y: H / 2, w: W, h: H / 2 }];
    viewports.dpr = dpr;
    c.style.display = game && game.mode === '2d' ? 'none' : 'block';
    placeTouch();
  }
  addEventListener('resize', () => { if (game) layout(); });

  const TINT_SHIELD = new Float32Array([0.75, 0.9, 1.35, 1]);
  const TINT_TNT = new Float32Array([1.6, 1.6, 1.6, 1]);
  const TINT_LIGHT_ON = new Float32Array([1.7, 1.7, 1.7, 1]);
  const TINT_LIGHT_OFF = new Float32Array([0.28, 0.28, 0.32, 1]);

  function render3D() {
    const g = game, dpr = viewports.dpr, H = innerHeight;
    const hud = $('hud').getContext('2d');
    hud.setTransform(dpr, 0, 0, dpr, 0, 0);
    hud.clearRect(0, 0, innerWidth, innerHeight);
    const th = g.world.th;
    const fog = th.sky;
    g.humans.forEach((me, vi) => {
      const v = viewports[vi];
      if (!v) return;
      // kamera
      if (me.spinT <= 0) me.camH += angDiff(me.h, me.camH) * Math.min(1, STEP * 60 * 0.09);
      const fx = Math.sin(me.camH), fz = Math.cos(me.camH);
      const sh = me.shake > 0 ? (Math.random() - 0.5) * me.shake * 0.6 : 0;
      const spK = clamp(Math.abs(me.fwd) / VEH[me.veh].vmax, 0, 1.4);
      const back = (6.6 + spK * 0.9) * VS, camUp = (2.7 + VEH[me.veh].seat[0] * 0.9 - spK * 0.25) * VS;
      const eye = [me.x - fx * back + sh, camUp + me.y * 0.7 + sh, me.z - fz * back];
      eye[1] = Math.max(eye[1], Math.min(40, colHAt(eye[0], eye[2])) + 1.5);
      const tgt = [me.x + fx * 3 * VS, 1.1 * VS + me.y * 0.8, me.z + fz * 3 * VS];
      const asp = v.w / v.h;
      let fovY = clamp(2 * Math.atan(Math.tan(40 * Math.PI / 180) / asp), 58 * Math.PI / 180, 82 * Math.PI / 180);
      const wantF = 1 + spK * 0.16 + (me.turboT > 0 ? 0.1 : 0);
      me.fov += (wantF - me.fov) * 0.08;
      fovY *= me.fov;
      const proj = M.persp(fovY, asp, 0.15, 330);
      const view = M.lookAt(eye, tgt, [0, 1, 0]);
      const vp = M.mul(proj, view);
      R.view(Math.round(v.x * dpr), Math.round((H - v.y - v.h) * dpr), Math.round(v.w * dpr), Math.round(v.h * dpr), vp, eye, fog, 75, 175);
      R.draw(g.sea, M.trans(Math.round(eye[0]), 0, Math.round(eye[2])));
      for (const p of g.pages) if (p.chunks) for (const c of p.chunks) {
        const dx = c.x - eye[0], dz = c.z - eye[2];
        const dd = Math.hypot(dx, dz);
        if (dd > 196) continue;
        if (dd > 30 && (dx * fx + dz * fz) / dd < -0.35) continue;
        R.draw(c.m, p.model);
      }
      const ctx0 = Math.floor((eye[0] - 320) / 640), ctz0 = Math.floor((eye[2] - 320) / 640), drift = (g.t * 0.6) % 8;
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) R.draw(g.clouds, M.trans((ctx0 + a) * 640 + drift, 0, (ctz0 + b) * 640));
      // zawodnicy
      for (const r of g.racers) {
        if (r.offline || (r.ghostT > 0 && Math.floor(r.ghostT * 10) % 2)) continue;
        let base = M.chain(M.trans(r.x, r.y, r.z), M.rotY(r.h), M.scale(VS));
        if (VEH[r.veh].lean) base = M.mul(base, M.rotZ(r.steer * clamp(Math.abs(r.fwd) / 20, 0, 1) * 0.4));
        const tint = r.shieldT > 0 ? TINT_SHIELD : null;
        const V = VEH[r.veh];
        R.draw(vehMeshFor(r.veh, r.ch), base, tint);
        const seat = M.mul(base, M.trans(0, V.seat[0], V.seat[1]));
        R.draw(meshes.body[r.ch], seat, tint);
        R.draw(meshes.head[r.ch], M.chain(seat, M.trans(NECK[0], NECK[1], NECK[2]), M.rotY(-r.steer * 0.4)), tint);
        if (V.lights) lightMeshesFor(r.veh).forEach((m, i) => R.draw(m, base, lightOn(r, i) ? TINT_LIGHT_ON : TINT_LIGHT_OFF));
        const rearR = V.wheels[V.wheels.length - 1][2];
        for (const [wx, wz, wr, ww, front] of V.wheels) {
          let m = M.mul(base, M.trans(wx, wr, wz));
          if (front) m = M.mul(m, M.rotY(-r.steer * 0.45));
          R.draw(wheelMeshFor(wr, ww), M.mul(m, M.rotX(r.wheel * rearR / wr)), tint);
        }
      }
      // bonusy i TNT
      for (const b of g.world.boxes) {
        if (!b.active) continue;
        R.draw(meshes.bonus, M.chain(M.trans(b.x, 1.6 + Math.sin(g.t * 3 + b.x) * 0.25, b.z), M.rotY(g.t * 1.6 + b.z), M.rotX(0.6), M.scale(K)));
      }
      for (const t of g.world.tnts) {
        if (!t.active) continue;
        const fl = t.armT > 0 && Math.floor(t.armT * 10) % 2;
        R.draw(meshes.tnt, M.mul(M.trans(t.x, 0.5 * K, t.z), M.scale(K)), fl ? TINT_TNT : null);
      }
      // cienie i cząsteczki (przezroczyste)
      const mb = new MeshBuilder();
      const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
      for (const r of g.racers) {
        const gy = groundUnder(r) + 0.03, s = VEH[r.veh].r * 1.3, l = VEH[r.veh].r * 2.0;
        const c = Math.cos(r.h), sn = Math.sin(r.h);
        const P = (ax, az) => [r.x + ax * c + az * sn, gy, r.z - ax * sn + az * c];
        const a = clamp(0.5 - (r.y - gy) * 0.08, 0.15, 0.5);
        mb.quad([P(-s, l), P(s, l), P(s, -l), P(-s, -l)], T.glow, [0, 0, 0], a);
      }
      // poświata migających świateł
      for (const r of g.racers) {
        const V = VEH[r.veh];
        if (!V.lights) continue;
        const c = Math.cos(r.h), sn = Math.sin(r.h);
        V.lights.forEach((l, i) => {
          if (!lightOn(r, i)) return;
          const lx = (l[0] + l[3]) / 2 * VS, ly = (l[4] + 0.05) * VS, lz = (l[2] + l[5]) / 2 * VS;
          const px = r.x + lx * c + lz * sn, py = r.y + ly, pz = r.z - lx * sn + lz * c, s = 1.4;
          const q = (a, b) => [px + right[0] * a + up[0] * b, py + right[1] * a + up[1] * b, pz + right[2] * a + up[2] * b];
          mb.quad([q(-s, s), q(s, s), q(s, -s), q(-s, -s)], T.glow, col01(l[6]), 0.85);
        });
      }
      for (const p of g.parts) {
        const s = p.size * K / 2, fade = 1 - p.life / p.max;
        const q = (a, b) => [p.x + right[0] * a + up[0] * b, p.y + right[1] * a + up[1] * b, p.z + right[2] * a + up[2] * b];
        mb.quad([q(-s, s), q(s, s), q(s, -s), q(-s, -s)], p.tile, p.col, p.a * fade);
      }
      if (mb.n) {
        R.upload(mb, meshes.dyn);
        R.blend(true);
        R.draw(meshes.dyn);
        R.blend(false);
      }
      speedLines(hud, v, clamp((spK - 0.75) * 2.5, 0, 1) + (me.turboT > 0 ? 0.6 : 0));
      drawHud(hud, me, v, (x, y, z) => {
        const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
        const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
        const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
        if (cw <= 0.1) return null;
        return [v.x + (cx / cw * 0.5 + 0.5) * v.w, v.y + (1 - (cy / cw * 0.5 + 0.5)) * v.h];
      });
    });
    if (viewports.length > 1) {
      hud.fillStyle = '#111';
      const v = viewports[1];
      if (v.x > 0) hud.fillRect(v.x - 2, 0, 4, innerHeight); else hud.fillRect(0, v.y - 2, innerWidth, 4);
    }
  }

  // ---------- widok 2D z góry ----------
  const tileXY = t => [(t % BG.PER_ROW) * BG.TILE, Math.floor(t / BG.PER_ROW) * BG.TILE];
  function* map2DGen(w) {
    const { W, D, H, vox, dist, own } = w;
    const P = own ? 3 : clamp(Math.floor(2400 / Math.max(W, D)), 3, 8);
    const c = document.createElement('canvas');
    c.width = W * P; c.height = D * P;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    const top = new Int8Array(W * D);
    const plants = [];
    for (let z = 0; z < D; z++) for (let xx = 0; xx < W; xx++) {
      if (xx === 0 && z % 3 === 0) yield;
      const ci = z * W + xx;
      if (own && !own[ci]) { top[ci] = -9; continue; }
      // nad torem pomijamy wysokie bloki (np. baner bramy), żeby nie zasłaniały jezdni
      let y = dist[ci] <= WALL + 1 ? Math.min(H - 1, Y0 + 2) : H - 1;
      let id = 0;
      for (; y >= 0; y--) {
        id = vox[(y * D + z) * W + xx];
        if (!id) continue;
        if (BG.BLOCKS[id].draw === 'cross') { plants.push([xx, z, BG.BLOCKS[id].top]); continue; }
        break;
      }
      const def = BG.BLOCKS[id] || BG.BLOCKS[B.dirt];
      const [tx, ty] = tileXY(def.top);
      x.drawImage(BG.atlas, tx, ty, BG.TILE, BG.TILE, xx * P, z * P, P, P);
      top[ci] = y - Y0;
    }
    // jasność według wysokości i cienie od strony lewej-górnej
    for (let z = 0; z < D; z++) for (let xx = 0; xx < W; xx++) {
      if (xx === 0 && z % 8 === 0) yield;
      const h = top[z * W + xx];
      if (h === -9) continue;
      if (h > 0) { x.fillStyle = 'rgba(255,255,255,' + Math.min(0.3, h * 0.035) + ')'; x.fillRect(xx * P, z * P, P, P); }
      if (h < -1) { x.fillStyle = 'rgba(0,0,30,.18)'; x.fillRect(xx * P, z * P, P, P); }
      let sh = 0;
      if (xx > 0) sh = Math.max(sh, top[z * W + xx - 1] - h);
      if (z > 0) sh = Math.max(sh, top[(z - 1) * W + xx] - h);
      if (xx > 0 && z > 0) sh = Math.max(sh, top[(z - 1) * W + xx - 1] - h);
      if (sh > 0) { x.fillStyle = 'rgba(0,0,0,' + Math.min(0.42, 0.16 + sh * 0.07) + ')'; x.fillRect(xx * P, z * P, P, P); }
    }
    for (const [px, pz, t] of plants) {
      const [tx, ty] = tileXY(t);
      x.drawImage(BG.atlas, tx, ty, BG.TILE, BG.TILE, px * P, pz * P, P, P);
    }
    return c;
  }
  // Widok z góry pojazdu z kierowcą (rysowane górne ściany brył, od najniższej)
  function makeSprite(v, ch) {
    const V = VEH[v], C = CHARS[ch], t = C.tiles, S = 24;
    const boxes = V.parts.map(p => ({ b: p, tile: p[6] === 'P' || p[6][0] === '#' ? null : T[p[6]] }));
    for (const [wx, wz, wr, ww] of V.wheels) boxes.push({ b: [wx - ww / 2, 0, wz - wr, wx + ww / 2, wr * 2, wz + wr], tile: T.tire });
    const [dy, dz] = V.seat, ny = NECK[1] + dy, nz = NECK[2] + dz;
    const ay1 = ny - PX;
    const ch2 = [
      [-4 * PX, SEAT_Y + dy, BODY_Z0 + dz, -0.005, SEAT_Y + 4 * PX + dy, BODY_Z0 + 12 * PX + dz, t.pants],
      [0.005, SEAT_Y + dy, BODY_Z0 + dz, 4 * PX, SEAT_Y + 4 * PX + dy, BODY_Z0 + 12 * PX + dz, t.pants],
      [-4 * PX, SEAT_Y + dy, BODY_Z0 + dz, 4 * PX, ny, BODY_Z1 + dz, t.shirt],
      [-8 * PX, ay1 - 4 * PX, BODY_Z0 + dz, -4 * PX, ay1, 0.22 + dz, t.shirt],
      [4 * PX, ay1 - 4 * PX, BODY_Z0 + dz, 8 * PX, ay1, 0.22 + dz, t.shirt],
      [-4 * PX, ny, nz - 4 * PX, 4 * PX, ny + 8 * PX, nz + 4 * PX, t.top]
    ];
    for (const b of ch2) boxes.push({ b, tile: b[6] });
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const { b } of boxes) { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[2]); x1 = Math.max(x1, b[3]); z1 = Math.max(z1, b[5]); }
    // dach terenówki zasłaniałby kierowcę – rysujemy go na końcu, ale półprzezroczysty
    const c = document.createElement('canvas');
    c.width = Math.ceil((x1 - x0) * S); c.height = Math.ceil((z1 - z0) * S);
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    boxes.sort((a, b) => a.b[4] - b.b[4]);
    for (const { b, tile } of boxes) {
      const px = Math.round((b[0] - x0) * S), pz = Math.round((b[2] - z0) * S);
      const pw = Math.max(1, Math.round((b[3] - b[0]) * S)), ph = Math.max(1, Math.round((b[5] - b[2]) * S));
      const over = b[4] > ny + 8 * PX - 0.01 && b[6] === 'metal';
      x.globalAlpha = over ? 0.55 : 1;
      if (tile === null) { x.fillStyle = b[6] && b[6][0] === '#' ? b[6] : C.kart; x.fillRect(px, pz, pw, ph); }
      else { const [tx, ty] = tileXY(tile); x.drawImage(BG.atlas, tx, ty, BG.TILE, BG.TILE, px, pz, pw, ph); }
      x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1; x.strokeRect(px + 0.5, pz + 0.5, pw - 1, ph - 1);
    }
    x.globalAlpha = 1;
    return { c, x0, z0, w: x1 - x0, h: z1 - z0 };
  }

  function render2D() {
    const g = game, dpr = viewports.dpr;
    const ctx = $('hud').getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sea = g.world.th.sea.map(v => Math.round(v * 255));
    ctx.fillStyle = 'rgb(' + sea.join(',') + ')';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    g.humans.forEach((me, vi) => {
      const v = viewports[vi];
      if (!v) return;
      if (me.spinT <= 0) me.camH += angDiff(me.h, me.camH) * 0.08;
      const speedK = clamp(Math.abs(me.fwd) / VEH[me.veh].vmax, 0, 1.3);
      const zoom = clamp(Math.min(v.w, v.h) / (25 * K), 7, 16) * (1.12 - speedK * 0.3) * (me.turboT > 0 ? 0.9 : 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
      const sh = me.shake > 0 ? (Math.random() - 0.5) * me.shake * 8 : 0;
      ctx.translate(v.x + v.w / 2 + sh, v.y + v.h * (v.h > v.w ? 0.66 : 0.6) + sh);
      ctx.rotate(me.camH - Math.PI);
      ctx.scale(zoom, zoom);
      ctx.translate(-me.x, -me.z);
      ctx.imageSmoothingEnabled = false;
      for (const p of g.pages) if (p.map2d) ctx.drawImage(p.map2d, 0, 0, p.map2d.width, p.map2d.height, p.ox, p.oz, p.W, p.D);
      // bonusy i TNT
      const [bx, by] = tileXY(T.bonus), [tx, ty] = tileXY(T.tnt_top);
      for (const b of g.world.boxes) {
        if (!b.active) continue;
        const s = (0.95 + Math.sin(g.t * 3 + b.x) * 0.1) * K;
        ctx.save(); ctx.translate(b.x, b.z); ctx.rotate(g.t * 1.6 + b.z);
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-s / 2 + 0.15, -s / 2 + 0.15, s, s);
        ctx.drawImage(BG.atlas, bx, by, BG.TILE, BG.TILE, -s / 2, -s / 2, s, s);
        ctx.restore();
      }
      for (const t of g.world.tnts) {
        if (!t.active) continue;
        const q = K / 2;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(t.x - q + 0.25, t.z - q + 0.25, K, K);
        ctx.drawImage(BG.atlas, tx, ty, BG.TILE, BG.TILE, t.x - q, t.z - q, K, K);
        if (t.armT > 0 && Math.floor(t.armT * 10) % 2) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(t.x - q, t.z - q, K, K); }
      }
      // pojazdy (wyżej = później)
      const order = g.racers.slice().sort((a, b) => a.y - b.y);
      for (const r of order) {
        if (r.offline || (r.ghostT > 0 && Math.floor(r.ghostT * 10) % 2)) continue;
        const sp = r.sprite, V = VEH[r.veh];
        const gy = groundUnder(r), lift = r.y - gy;
        ctx.save();
        ctx.translate(r.x + 0.3 + lift * 0.35, r.z + 0.3 + lift * 0.35);
        ctx.rotate(-r.h);
        ctx.fillStyle = 'rgba(0,0,0,' + clamp(0.35 - lift * 0.04, 0.12, 0.35) + ')';
        ctx.beginPath(); ctx.ellipse(0, 0, V.r * 1.15, V.r * 1.7, 0, 0, 7); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.translate(r.x, r.z);
        ctx.rotate(-r.h);
        const k = (1 + lift * 0.06) * VS;
        ctx.scale(k, k);
        ctx.drawImage(sp.c, sp.x0, sp.z0, sp.w, sp.h);
        if (V.lights) V.lights.forEach((l, i) => {
          const on = lightOn(r, i);
          ctx.fillStyle = on ? l[6] : '#30303a';
          ctx.fillRect(l[0], l[2], l[3] - l[0], l[5] - l[2]);
          if (on) {
            ctx.globalAlpha = 0.45; ctx.beginPath();
            ctx.arc((l[0] + l[3]) / 2, (l[2] + l[5]) / 2, 0.9, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
          }
        });
        if (r.shieldT > 0) {
          ctx.strokeStyle = 'rgba(110,200,255,' + (0.55 + Math.sin(g.t * 12) * 0.25) + ')'; ctx.lineWidth = 0.18;
          ctx.beginPath(); ctx.arc(0, 0, V.rad * 2.1, 0, 7); ctx.stroke();
        }
        ctx.restore();
      }
      // cząsteczki
      for (const p of g.parts) {
        const fade = 1 - p.life / p.max;
        ctx.fillStyle = 'rgba(' + Math.round(p.col[0] * 255) + ',' + Math.round(p.col[1] * 255) + ',' + Math.round(p.col[2] * 255) + ',' + (p.a * fade * 0.8) + ')';
        ctx.beginPath(); ctx.arc(p.x, p.z, p.size * K * (0.4 + p.y * 0.05), 0, 7); ctx.fill();
      }
      const m = ctx.getTransform();
      ctx.restore();
      drawHud(ctx, me, v, (x, y, z) => {
        const q = m.transformPoint(new DOMPoint(x, z));
        return [q.x / dpr, q.y / dpr - y * zoom * 0.2];
      });
    });
    if (viewports.length > 1) {
      ctx.fillStyle = '#111';
      const v = viewports[1];
      if (v.x > 0) ctx.fillRect(v.x - 2, 0, 4, innerHeight); else ctx.fillRect(0, v.y - 2, innerWidth, 4);
    }
  }

  // smugi pędu na brzegach ekranu
  function speedLines(ctx, v, k) {
    if (k <= 0.02) return;
    const cx = v.x + v.w / 2, cy = v.y + v.h * 0.45, R = Math.hypot(v.w, v.h) / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,' + Math.min(0.45, 0.18 + k * 0.2) + ')';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const n = Math.round(10 + k * 18);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r1 = R * (0.55 + Math.random() * 0.3), r2 = r1 + R * (0.12 + k * 0.25);
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // odległość w blokach → metry (1 metr ≈ K bloków)
  function fmtDist(cells) {
    const m = Math.max(0, cells) / K;
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2).replace('.', ',') + ' km';
  }
  function fmtTime(t) {
    if (!(t > 0)) return '–';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  // rysuje linię trasy od a do b (loop: zamknięta) przez funkcję tp(x,z) → [px,pz]
  function strokeRoute(x, track, a, b, tp, closed) {
    x.beginPath();
    for (let i = a; i <= b; i += 2) { const k = Math.min(i, b); const [px, pz] = tp(track.X[k % track.N], track.Z[k % track.N]); i === a ? x.moveTo(px, pz) : x.lineTo(px, pz); }
    if (closed) x.closePath();
  }
  function markerAB(x, px, pz, label, bg, size) {
    x.beginPath(); x.arc(px, pz, size, 0, 7); x.fillStyle = bg; x.fill();
    x.lineWidth = 2; x.strokeStyle = '#fff'; x.stroke();
    x.fillStyle = '#fff'; x.font = '800 ' + Math.round(size * 1.3) + 'px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(label, px, pz + 1);
  }
  // minimapa całej trasy (pętla i A→B); w trybie bez końca rysowana na bieżąco
  function makeMinimap(track) {
    if (track.mode === 'endless') return null;
    const c = document.createElement('canvas'), S = 200;
    c.width = c.height = S;
    const x = c.getContext('2d');
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = 0; k < track.N; k++) { minX = Math.min(minX, track.X[k]); maxX = Math.max(maxX, track.X[k]); minZ = Math.min(minZ, track.Z[k]); maxZ = Math.max(maxZ, track.Z[k]); }
    const sc = (S - 24) / Math.max(maxX - minX, maxZ - minZ, 1);
    const ox = (S - (maxX - minX) * sc) / 2 - minX * sc, oz = (S - (maxZ - minZ) * sc) / 2 - minZ * sc;
    const tp = (px, pz) => [ox + px * sc, oz + pz * sc];
    x.lineJoin = 'round'; x.lineCap = 'round';
    for (const [wd, col] of [[track.loop ? 13 : 10, 'rgba(0,0,0,.55)'], [track.loop ? 8 : 6, '#f0f0f0']]) {
      strokeRoute(x, track, track.loop ? 0 : START_K, track.loop ? track.N : track.finishK, tp, track.loop);
      x.lineWidth = wd; x.strokeStyle = col; x.stroke();
    }
    if (track.loop) {
      const [sx, sz] = tp(track.X[0], track.Z[0]);
      x.fillStyle = '#d33'; x.fillRect(sx - 4, sz - 4, 8, 8);
    } else {
      const [ax, az] = tp(track.X[START_K], track.Z[START_K]), [bx, bz] = tp(track.X[track.finishK], track.Z[track.finishK]);
      markerAB(x, ax, az, 'A', '#2f9a4a', 8); markerAB(x, bx, bz, 'B', '#d33', 8);
    }
    return { c, tp, S };
  }


  function drawHud(ctx, me, v, project) {
    const g = game, n = g.racers.length;
    const ch = CHARS[me.ch];
    const sc = clamp(Math.min(v.w, v.h) / 420, 0.7, 1.4);
    ctx.save();
    ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
    ctx.textBaseline = 'top';
    const pad = 10 * sc;
    const txt = (s, x, y, size, color, align) => {
      ctx.font = '800 ' + size + 'px system-ui, sans-serif';
      ctx.textAlign = align || 'left';
      ctx.lineWidth = Math.max(3, size / 6); ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineJoin = 'round';
      ctx.strokeText(s, x, y); ctx.fillStyle = color || '#fff'; ctx.fillText(s, x, y);
    };
    // miejsce, okrążenie, czas
    if (g.humans.length > 1) txt('GRACZ ' + (me.human + 1) + ' · ' + ch.name, v.x + pad, v.y + pad, 13 * sc, ch.kart);
    const top = v.y + pad + (g.humans.length > 1 ? 18 * sc : 0);
    txt((me.place + 1) + '.', v.x + pad, top, 40 * sc, me.place === 0 ? '#ffd23a' : '#fff');
    ctx.font = '800 ' + 40 * sc + 'px system-ui, sans-serif';
    const pw = ctx.measureText((me.place + 1) + '.').width;
    txt('/ ' + n, v.x + pad + pw + 6, top + 18 * sc, 18 * sc, '#ddd');
    const trk = g.track;
    if (trk.loop) txt('Okrążenie ' + clamp(me.lap, 1, cfg.laps) + '/' + cfg.laps, v.x + pad, top + 46 * sc, 15 * sc);
    else if (trk.mode === 'ab') txt('Do mety: ' + fmtDist(trk.finishK - me.idx), v.x + pad, top + 46 * sc, 15 * sc);
    else txt('Dystans: ' + fmtDist(me.idx - START_K), v.x + pad, top + 46 * sc, 15 * sc);
    if (trk.mode === 'endless' && g.state !== 'countdown') {
      const tl = Math.ceil(me.timeLeft);
      txt('⏱️ ' + tl + ' s', v.x + v.w / 2, v.y + v.h - 70 * sc - (isTouch ? 70 : 0), (tl <= 10 ? 34 : 26) * sc, tl <= 10 && Math.floor(g.t * 3) % 2 ? '#ff5040' : '#fff', 'center');
      txt('następny punkt: ' + fmtDist(me.nextCP - me.idx), v.x + v.w / 2, v.y + v.h - 36 * sc - (isTouch ? 70 : 0), 12 * sc, '#eee', 'center');
    }
    txt(fmtTime(me.finished ? me.finishT : Math.max(0, g.t)), v.x + pad, top + 66 * sc, 15 * sc, '#e8f4ff');
    txt(Math.round(Math.abs(me.fwd) * 4.4) + ' km/h', v.x + pad, top + 86 * sc, 13 * sc, '#cfe');
    // bonus
    const bs = 54 * sc, bx = v.x + v.w / 2 - bs / 2, by = v.y + pad;
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.strokeStyle = me.item ? '#ffd23a' : 'rgba(255,255,255,.6)'; ctx.lineWidth = 3;
    roundRect(ctx, bx, by, bs, bs, 10 * sc); ctx.fill(); ctx.stroke();
    if (me.item) {
      ctx.font = 32 * sc + 'px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.fillText(ITEMS[me.item].icon, bx + bs / 2, by + bs / 2 + 2);
      ctx.textBaseline = 'top';
      if (!isTouch) txt(cfg.players === 1 ? 'Spacja' : (me.human === 0 ? 'Spacja' : 'Enter'), bx + bs / 2, by + bs + 3, 11 * sc, '#fff', 'center');
    }
    // aktywne efekty
    let ey = by + bs + 18 * sc;
    for (const [t, max, label, col] of [[me.turboT, 2.4, '⚡ Turbo', '#ffb020'], [me.shieldT, 6, '🛡️ Tarcza', '#6cf']]) {
      if (t <= 0) continue;
      const w = 90 * sc;
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(v.x + v.w / 2 - w / 2, ey, w, 8 * sc);
      ctx.fillStyle = col; ctx.fillRect(v.x + v.w / 2 - w / 2, ey, w * t / max, 8 * sc);
      txt(label, v.x + v.w / 2, ey + 10 * sc, 12 * sc, col, 'center');
      ey += 30 * sc;
    }
    // minimapa
    const ms = clamp(Math.min(v.w, v.h) * 0.3, 90, 180);
    const mx = v.x + v.w - ms - pad, my = v.y + pad;
    let mtp;
    if (g.minimap) {
      const mm = g.minimap, k = ms / mm.S;
      ctx.globalAlpha = 0.85; ctx.drawImage(mm.c, mx, my, ms, ms); ctx.globalAlpha = 1;
      mtp = (x, z) => { const [a, b] = mm.tp(x, z); return [a * k, b * k]; };
    } else {
      // bez końca: wycinek trasy wokół gracza, kierunek jazdy w górę
      const scl = ms / 520, ch0 = Math.cos(me.camH - Math.PI), sh0 = Math.sin(me.camH - Math.PI);
      mtp = (x, z) => { const dx = (x - me.x) * scl, dz = (z - me.z) * scl; return [ms / 2 + dx * ch0 - dz * sh0, ms * 0.62 + dx * sh0 + dz * ch0]; };
      ctx.save(); ctx.translate(mx, my);
      ctx.fillStyle = 'rgba(0,0,0,.3)'; roundRect(ctx, 0, 0, ms, ms, 12); ctx.fill(); ctx.clip();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const [wd, col] of [[9, 'rgba(0,0,0,.55)'], [5, '#f0f0f0']]) {
        strokeRoute(ctx, trk, Math.max(0, me.idx - 260), Math.min(trk.N - 1, me.idx + 520), mtp, false);
        ctx.lineWidth = wd; ctx.strokeStyle = col; ctx.stroke();
      }
      if (me.nextCP < trk.N) { const [cx2, cz2] = mtp(trk.X[me.nextCP], trk.Z[me.nextCP]); ctx.fillStyle = '#ffd23a'; ctx.fillRect(cx2 - 5, cz2 - 5, 10, 10); }
      ctx.restore();
    }
    for (const r of g.racers.slice().sort((a, b) => (a === me) - (b === me))) {
      const [px, pz] = mtp(r.x, r.z);
      if (px < 0 || pz < 0 || px > ms || pz > ms) continue;
      ctx.beginPath(); ctx.arc(mx + px, my + pz, (r === me ? 5.5 : r.human >= 0 || r.netHuman ? 4.5 : 3.5) * sc, 0, 7);
      ctx.fillStyle = CHARS[r.ch].kart; ctx.fill();
      ctx.lineWidth = r.human >= 0 ? 2 : 1; ctx.strokeStyle = r === me ? '#fff' : '#000'; ctx.stroke();
    }
    // imiona nad innymi
    for (const r of g.racers) {
      if (r === me) continue;
      const d = Math.hypot(r.x - me.x, r.z - me.z);
      if (d > 38) continue;
      const sp = project(r.x, r.y + (2.7 + VEH[r.veh].seat[0]) * VS, r.z);
      if (!sp) continue;
      const [sx, sy] = sp;
      if (r.offline) continue;
      const label = r.human >= 0 ? 'G' + (r.human + 1) + ' ' + CHARS[r.ch].name : r.netHuman ? 'G' + (r.net + 1) + ' ' + CHARS[r.ch].name : CHARS[r.ch].name;
      txt(label, sx, sy - 8, clamp(14 - d * 0.15, 9, 14) * sc, CHARS[r.ch].kart, 'center');
    }
    // komunikaty
    const cx = v.x + v.w / 2, cy = v.y + v.h * 0.36;
    if (g.state === 'countdown') {
      const s = Math.ceil(-g.t);
      if (s <= 3) txt(String(s), cx, cy - 30 * sc, 80 * sc, '#ffd23a', 'center');
      else txt('Przygotuj się!', cx, cy, 30 * sc, '#fff', 'center');
    } else if (g.t < 1) txt('START!', cx, cy - 20 * sc, 64 * sc, '#5f5', 'center');
    if (me.msgT > 0) txt(me.msg, cx, cy + 50 * sc, 26 * sc, '#fff', 'center');
    if (me.wrongT > 1) txt('↺ Zły kierunek!', cx, cy + 90 * sc, 26 * sc, '#ff6050', 'center');
    if (g.firstFinishT && !me.finished && (g.humans.length > 1 || g.net) && g.track.mode !== 'endless') {
      const left = Math.ceil(FINISH_WAIT - (g.t - g.firstFinishT));
      if (left > 0) txt('Koniec za ' + left + ' s', cx, v.y + v.h - 120 * sc, 18 * sc, '#ffd23a', 'center');
    }
    ctx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---------- pętla ----------
  let last = performance.now(), acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!game) return;
    const tp0 = performance.now();
    if (game.jobs.length) pumpJobs(paused ? 14 : 7);
    const tp1 = performance.now();
    if (game.net && game.state !== 'done') {
      // online: czas gry wynika z zegara serwera (wspólny start), pauza nie zatrzymuje wyścigu
      const want = (net.serverNow() - game.net.go) / 1000;
      if (want - game.t > 1.5) game.t = want - STEP;   // karta była w tle – przeskok
      let steps = 0;
      while (game.t + STEP <= want && steps < 8) { update(STEP); steps++; }
    } else if (!paused && game.state !== 'done') {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) { update(STEP); acc -= STEP; steps++; }
      if (steps === 6) acc = 0;
    }
    for (const r of game.humans) if (r.eng && Snd.ctx) {
      const on = !paused && game.state !== 'done' && !game.away;
      r.eng.o.frequency.setTargetAtTime(45 + Math.abs(r.fwd) * 5.5 + (r.turboT > 0 ? 40 : 0) + (r.ctrl.thr > 0 ? 8 : 0), Snd.ctx.currentTime, 0.05);
      r.eng.g.gain.setTargetAtTime(on ? (cfg.players > 1 ? 0.025 : 0.035) : 0, Snd.ctx.currentTime, 0.05);
    }
    if (!game.away) { if (game.mode === '2d') render2D(); else render3D(); }
    // pomiar (do testów): najdłuższe budowanie świata i rysowanie w jednej klatce
    const pf = game.perf || (game.perf = { pump: 0, draw: 0 });
    pf.pump = Math.max(pf.pump, tp1 - tp0); pf.draw = Math.max(pf.draw, performance.now() - tp1);
  }
  requestAnimationFrame(frame);

  // ---------- dotyk ----------
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches);
  function placeTouch() {
    const box = $('touch');
    box.innerHTML = '';
    if (!isTouch || !game) return;
    game.humans.forEach((r, i) => {
      const v = viewports[i];
      const s = clamp(Math.min(v.w, v.h) / 6, 52, 84);
      const mk = (label, key, x, y, w, h, cls) => {
        const b = document.createElement('div');
        b.className = 'tbtn ' + (cls || ''); b.textContent = label;
        Object.assign(b.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', fontSize: s * 0.42 + 'px' });
        const ids = new Set();
        const upd = () => { touch[i][key] = ids.size > 0; b.classList.toggle('on', ids.size > 0); };
        b.addEventListener('pointerdown', e => { e.preventDefault(); ids.add(e.pointerId); try { b.releasePointerCapture(e.pointerId); } catch (er) { /* brak */ } upd(); });
        const off = e => { ids.delete(e.pointerId); upd(); };
        b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
        box.appendChild(b);
      };
      const m = 12, bot = v.y + v.h - s - m - (i === game.humans.length - 1 ? 0 : 0);
      mk('◀', 'left', v.x + m, bot, s, s);
      mk('▶', 'right', v.x + m * 2 + s, bot, s, s);
      mk('▲', 'up', v.x + v.w - s * 1.15 - m, bot - s * 0.35, s * 1.15, s * 1.35, 'gas');
      mk('▼', 'down', v.x + v.w - s * 2.15 - m * 2, bot + s * 0.25, s * 0.95, s * 0.75);
      mk('★', 'item', v.x + v.w - s * 1.05 - m, bot - s * 1.4 - m, s * 0.95, s * 0.95, 'item');
    });
  }

  // ---------- ekrany ----------
  function showScreen(name) {
    for (const id of ['menu', 'race']) $(id).classList.toggle('show', id === name);
    $('pause').classList.add('hidden'); $('results').classList.add('hidden'); $('btnPause').classList.remove('hidden');
    document.body.classList.toggle('racing', name === 'race');
    if (name !== 'race') $('touch').innerHTML = '';
  }
  function setPause(p) {
    if (!game) return;
    paused = p;
    $('pause').classList.toggle('hidden', !p);
    $('btnSound2').textContent = Snd.on ? '🔊 Dźwięk: wł.' : '🔇 Dźwięk: wył.';
    $('btnRestart').classList.toggle('hidden', !!game.net);
    $('pauseNote').classList.toggle('hidden', !game.net);
    if (!p) { last = performance.now(); keys.clear(); }
  }
  function showResults() {
    const g = game;
    if (g.away) { updateStartBtn(); return; } // gracz jest w pokoju – wyniki pokażą się po powrocie
    const order = g.racers.slice().sort((a, b) => a.place - b.place);
    const tb = $('resTable');
    tb.innerHTML = '';
    order.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.human >= 0) tr.className = 'me';
      const who = r.human >= 0 ? (g.humans.length > 1 ? 'Gracz ' + (r.human + 1) : 'Ty') : r.netHuman ? 'Gracz ' + (r.net + 1) + (r.offline ? ' (rozłączony)' : '') : 'komputer';
      const endless = g.track.mode === 'endless';
      const cells = [(i + 1) + '.', '', CHARS[r.ch].name + ' <small>' + who + '</small>',
        endless ? fmtDist(r.idx - START_K) : r.finished ? fmtTime(r.finishT) : 'nie ukończył',
        endless ? (r.human >= 0 || r.netHuman ? r.cps + ' pkt' : '') : g.track.loop && !r.remote ? fmtTime(r.bestLap) : ''];
      cells.forEach((c, j) => {
        const td = document.createElement('td');
        if (j === 1) td.appendChild(portrait(r.ch, 28)); else td.innerHTML = c;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const best = order.find(r => r.human >= 0);
    const endless = g.track.mode === 'endless';
    const multi = g.humans.length > 1 || !!g.net;
    const nm = r => r.human >= 0 ? (g.net ? 'Ty' : 'Gracz ' + (r.human + 1)) : r.netHuman ? 'Gracz ' + (r.net + 1) : CHARS[r.ch].name;
    let title = endless ? (g.humans.length > 1 ? (order[0].human >= 0 ? '🏆 Najdalej: Gracz ' + (order[0].human + 1) : 'Najdalej: ' + CHARS[order[0].ch].name)
      : '🏁 Przejechałeś ' + fmtDist(best.idx - START_K))
      : g.humans.length > 1
      ? (order[0].human >= 0 ? '🏆 Wygrywa Gracz ' + (order[0].human + 1) + '!' : 'Wygrywa ' + CHARS[order[0].ch].name + '!')
      : (best.place === 0 ? '🏆 Zwycięstwo!' : 'Meta – ' + (best.place + 1) + '. miejsce');
    if (g.net) {
      const w0 = order[0];
      title = w0.human >= 0 ? (endless ? '🏆 Dojechałeś najdalej!' : '🏆 Zwycięstwo!')
        : (endless ? 'Najdalej: ' : 'Wygrywa ') + nm(w0) + (w0.netHuman || w0.human >= 0 ? ' (' + CHARS[w0.ch].name + ')' : '') + (endless ? '' : '!');
    }
    $('resTitle').textContent = title;
    // online: kolejny wyścig rozpoczyna gospodarz
    const guest = !!(g.net && !g.net.host);
    $('btnAgain').classList.toggle('hidden', guest); $('btnNew').classList.toggle('hidden', guest);
    $('resWait').classList.toggle('hidden', !guest);
    $('btnMenu').textContent = g.net ? '☰ Wróć do pokoju' : '☰ Menu';
    const rt = g.track.loop ? cfg.laps + ' okr.' : g.track.mode === 'ab' ? 'z A do B, ' + fmtDist(g.track.finishK - START_K) : 'bez końca';
    $('resInfo').textContent = 'Trasa nr ' + cfg.seed + ' · ' + THEMES[g.world.theme].name + ' · ' + rt;
    $('resNote').textContent = endless ? 'Przejechany dystans · punkty kontrolne' : g.track.loop ? 'Czas wyścigu · najlepsze okrążenie' : 'Czas przejazdu';
    $('results').classList.remove('hidden');
    $('btnPause').classList.add('hidden');
    for (const r of g.humans) if (r.eng) r.eng.g.gain.value = 0;
  }

  function portrait(ci, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    const t = CHARS[ci].tiles.face;
    x.drawImage(BG.atlas, (t % BG.PER_ROW) * BG.TILE, Math.floor(t / BG.PER_ROW) * BG.TILE, BG.TILE, BG.TILE, 0, 0, size, size);
    c.className = 'face';
    return c;
  }

  // ---------- menu ----------
  function seg(id, values, get, set) {
    const box = $(id);
    if (!box) return; // np. stara wersja strony z pamięci przeglądarki
    box.innerHTML = '';
    values.forEach(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.innerHTML = label;
      b.className = get() === val ? 'sel' : '';
      b.addEventListener('click', () => { set(val); refreshMenu(); });
      box.appendChild(b);
    });
  }
  function charPicker(id, p) {
    const box = $(id);
    if (!box) return; // np. stara wersja strony z pamięci przeglądarki
    box.innerHTML = '';
    CHARS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      const taken = cfg.players > 1 && cfg.chars[1 - p] === i;
      b.className = 'char' + (cfg.chars[p] === i ? ' sel' : '') + (taken ? ' taken' : '');
      b.disabled = taken;
      b.appendChild(portrait(i, 40));
      const s = document.createElement('span'); s.textContent = c.name; b.appendChild(s);
      b.style.setProperty('--kart', c.kart);
      b.addEventListener('click', () => { cfg.chars[p] = i; refreshMenu(); });
      box.appendChild(b);
    });
  }
  function vehPicker(id, p) {
    const box = $(id);
    if (!box) return; // np. stara wersja strony z pamięci przeglądarki
    box.innerHTML = '';
    const maxS = Math.max(...VEH.map(v => v.speed)), dots = n => '●'.repeat(n) + '○'.repeat(4 - n);
    VEH.forEach((V, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'veh' + (cfg.veh[p] === i ? ' sel' : '');
      const sp = Math.round(1 + (V.speed - 18) / (maxS - 18) * 3), off = Math.round(1 + (V.off - 0.4) / 0.55 * 3);
      b.innerHTML = '<span class="vi">' + V.icon + '</span><b>' + V.name + '</b><small>Szybkość ' + dots(sp) + '<br>Teren ' + dots(off) + '</small>';
      b.title = V.desc;
      b.addEventListener('click', () => { cfg.veh[p] = i; refreshMenu(); });
      box.appendChild(b);
    });
    const d = $(id + 'desc');
    if (d) d.textContent = VEH[cfg.veh[p]].name + ' – ' + VEH[cfg.veh[p]].desc;
  }
  function drawPreview() {
    previewTrack = trackFor();
    const tr = previewTrack;
    const theme = cfg.theme === 'losowy' ? ['laka', 'pustynia', 'zima'][cfg.seed % 3] : cfg.theme;
    const th = THEMES[theme];
    const c = $('preview'), x = c.getContext('2d'), S = c.width;
    x.fillStyle = th.mapBg; x.fillRect(0, 0, S, S);
    // pikselowa trawa
    const r = rng(cfg.seed);
    for (let i = 0; i < 500; i++) { x.fillStyle = 'rgba(0,0,0,' + (r() * 0.08) + ')'; x.fillRect(Math.floor(r() * S / 6) * 6, Math.floor(r() * S / 6) * 6, 6, 6); }
    // zakres trasy na podglądzie (bez końca: początkowe ~2 km)
    const k0 = tr.loop ? 0 : START_K - 30, k1 = tr.loop ? tr.N - 1 : tr.mode === 'ab' ? tr.finishK + 20 : Math.min(tr.N - 1, 3400);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let k = k0; k <= k1; k++) { minX = Math.min(minX, tr.X[k]); maxX = Math.max(maxX, tr.X[k]); minZ = Math.min(minZ, tr.Z[k]); maxZ = Math.max(maxZ, tr.Z[k]); }
    const pad = tr.loop ? 24 : 30;
    const sc = (S - 2 * pad) / Math.max(maxX - minX, maxZ - minZ, 1);
    const ox = (S - (maxX - minX) * sc) / 2 - minX * sc, oz = (S - (maxZ - minZ) * sc) / 2 - minZ * sc;
    const tp = (px, pz) => [ox + px * sc, oz + pz * sc];
    x.lineJoin = 'round'; x.lineCap = 'round';
    const wide = s0 => Math.max(s0 * sc, tr.loop ? 0 : 2);
    for (const [wd, col] of [[cfg.barriers ? 2 * WALL * sc + 2 : 0, cfg.barriers ? 'rgba(0,0,0,.25)' : 'transparent'], [wide(2 * HW) + 3, '#d33'], [wide(2 * HW), th.mapRoad]]) {
      if (!wd) continue;
      strokeRoute(x, tr, k0, k1, tp, tr.loop);
      x.lineWidth = wd; x.strokeStyle = col; x.stroke();
    }
    if (tr.loop) {
      // linia startu i kierunek
      const sx = ox + tr.X[0] * sc, sz = oz + tr.Z[0] * sc;
      x.save(); x.translate(sx, sz); x.rotate(Math.atan2(tr.NZ[0], tr.NX[0]));
      for (let i = -3; i < 3; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * 3, j * 3 - 3, 3, 3); }
      x.restore();
      const ax = ox + tr.X[20] * sc, az = oz + tr.Z[20] * sc;
      x.save(); x.translate(ax, az); x.rotate(Math.atan2(tr.TZ[20], tr.TX[20]));
      x.fillStyle = '#fff'; x.beginPath(); x.moveTo(7, 0); x.lineTo(-5, -5); x.lineTo(-5, 5); x.closePath(); x.fill();
      x.restore();
      $('trackInfo').textContent = 'Tor nr ' + cfg.seed + ' · długość ' + fmtDist(tr.N) + (tr.shape < cfg.shape ? ' (uproszczony)' : '');
    } else {
      const [ax, az] = tp(tr.X[START_K], tr.Z[START_K]);
      markerAB(x, ax, az, 'A', '#2f9a4a', 9);
      if (tr.mode === 'ab') {
        const [bx, bz] = tp(tr.X[tr.finishK], tr.Z[tr.finishK]);
        markerAB(x, bx, bz, 'B', '#d33', 9);
        $('trackInfo').textContent = 'Trasa nr ' + cfg.seed + ' · z A do B: ' + fmtDist(tr.finishK - START_K);
      } else {
        const [ex, ez] = tp(tr.X[k1], tr.Z[k1]);
        x.save(); x.translate(ex, ez); x.rotate(Math.atan2(tr.TZ[k1], tr.TX[k1]));
        x.fillStyle = '#fff'; x.beginPath(); x.moveTo(9, 0); x.lineTo(-6, -7); x.lineTo(-6, 7); x.closePath(); x.fill();
        x.restore();
        $('trackInfo').textContent = 'Trasa nr ' + cfg.seed + ' · bez końca – dalsza droga powstaje w czasie jazdy';
      }
    }
    $('seedInput').value = cfg.seed;
    lobbyPublish();
  }

  function refreshMenu() {
    seg('segPlayers', [[1, '👤 Jeden gracz'], [2, '👥 Dwóch graczy']], () => cfg.players, v => { cfg.players = v; if (v === 2 && cfg.chars[0] === cfg.chars[1]) cfg.chars[1] = (cfg.chars[0] + 1) % CHARS.length; });
    seg('segBots', [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], () => cfg.bots, v => cfg.bots = v);
    seg('segDiff', [[0, 'łatwy'], [1, 'średni'], [2, 'trudny']], () => cfg.diff, v => cfg.diff = v);
    seg('segTheme', [['laka', '🌳 Łąka'], ['pustynia', '🌵 Pustynia'], ['zima', '❄️ Zima'], ['losowy', '🎲 Losowy']], () => cfg.theme, v => { cfg.theme = v; drawPreview(); });
    seg('segLaps', [[1, '1'], [2, '2'], [3, '3'], [5, '5']], () => cfg.laps, v => cfg.laps = v);
    seg('segRoute', [['loop', '🔁 Pętla'], ['ab', '🅰️➡️🅱️ Z A do B'], ['endless', '♾️ Bez końca']], () => cfg.route, v => { cfg.route = v; drawPreview(); });
    seg('segAbLen', [[0, 'krótka'], [1, 'średnia'], [2, 'długa']], () => cfg.abLen, v => { cfg.abLen = v; drawPreview(); });
    if ($('lapsBox')) {
      $('lapsBox').classList.toggle('hidden', cfg.route !== 'loop');
      $('abLenBox').classList.toggle('hidden', cfg.route !== 'ab');
      $('endlessNote').classList.toggle('hidden', cfg.route !== 'endless');
    }
    seg('segShape', [[0, '〰️ Łagodny'], [1, '🌀 Kręty'], [2, '🐍 Bardzo kręty']], () => cfg.shape, v => { cfg.shape = v; drawPreview(); });
    seg('segBarriers', [[true, '🧱 Z bandami'], [false, '🌾 Bez band']], () => cfg.barriers, v => { cfg.barriers = v; drawPreview(); });
    seg('segView', [['3d', '🧊 3D zza pojazdu'], ['2d', '🗺️ 2D z góry']], () => cfg.view, v => cfg.view = v);
    seg('segAssist', [[true, '🧭 Pomoc w kierowaniu'], [false, '🏁 Bez pomocy']], () => cfg.assist, v => cfg.assist = v);
    charPicker('chars1', 0);
    vehPicker('veh1', 0);
    if (cfg.players > 1) vehPicker('veh2', 1);
    $('p2box').classList.toggle('hidden', cfg.players < 2);
    $('p1label').textContent = cfg.players > 1 ? 'Gracz 1 – postać' : 'Twoja postać';
    if ($('v1label')) $('v1label').textContent = cfg.players > 1 ? 'Gracz 1 – pojazd' : 'Twój pojazd';
    if (cfg.players > 1) charPicker('chars2', 1);
    $('diffBox').classList.toggle('hidden', cfg.bots === 0);
    $('ctrlSolo').classList.toggle('hidden', cfg.players > 1);
    $('ctrlDuo').classList.toggle('hidden', cfg.players < 2);
    // gra online: jeden gracz na urządzeniu, trasę wybiera gospodarz
    const guest = !!(net && !net.host);
    $('segPlayers').classList.toggle('hidden', !!net);
    document.querySelectorAll('.hostOnly').forEach(e => e.classList.toggle('hidden', guest));
    $('cardBots').classList.toggle('hidden', guest);
    if (net && (net.me.c !== cfg.chars[0] || net.me.v !== cfg.veh[0])) net.setMe(cfg.chars[0], cfg.veh[0]);
    lobbyPublish();
    updateStartBtn();
  }

  // ---------- gra online: poczekalnia ----------
  const NET_KEYS = ['seed', 'route', 'shape', 'abLen', 'theme', 'barriers', 'laps', 'diff', 'bots'];
  const hostSettings = () => { const o = {}; for (const k of NET_KEYS) o[k] = cfg[k]; return o; };
  let pubTimer = 0, lastSettingsJSON = '';
  function lobbyPublish() {
    if (!net || !net.host) return;
    clearTimeout(pubTimer);
    pubTimer = setTimeout(() => { if (net) net.publishSettings(hostSettings()); }, 250);
  }
  function setUrl(u) { try { history.replaceState(null, '', u); } catch (e) { /* brak historii */ } }
  function enterRoom(host, room) {
    if (net) net.leave();
    cfg.players = 1;
    net = RaceNet.create({
      room, host, me: { c: cfg.chars[0], v: cfg.veh[0] },
      onChange: renderLobby, onStart: onNetStart, onStates: netReceive
    });
    if (host) net.publishSettings(hostSettings());
    net.start();
    setUrl(location.pathname + '?wyscig=' + room);
    refreshMenu();
  }
  function leaveRoom() {
    if (game && game.net) quitRace();
    if (net) net.leave();
    net = null;
    setUrl(location.pathname);
    $('netNotice').textContent = '';
    refreshMenu();
  }
  function onNetStart(c, st) {
    for (const k of NET_KEYS) if (st[k] !== undefined) cfg[k] = st[k];
    cfg.players = 1;
    if (!Array.isArray(st.roster) || !st.roster.some(e => e.k === net.slot)) {
      $('netNotice').textContent = 'Wyścig już trwa – dołączysz do następnego.';
      return;
    }
    $('netNotice').textContent = '';
    startRace({ roster: st.roster, mySlot: net.slot, host: net.host, go: c.go });
  }
  function hostStart() {
    const slots = Object.keys(net.players).map(Number).filter(k => k === 0 || net.online(k)).sort((a, b) => a - b);
    const humans = slots.map(k => ({ k, c: net.players[k].c | 0, v: net.players[k].v | 0 }));
    humans[0] && (humans[0].c = cfg.chars[0], humans[0].v = cfg.veh[0]);
    const used = new Set(humans.map(h => h.c));
    const nb = Math.min(cfg.bots, 8 - humans.length), bots = [];
    for (let i = 0; i < CHARS.length && bots.length < nb; i++) if (!used.has(i)) bots.push({ k: 'b', c: i, v: Math.floor(Math.random() * VEH.length) });
    net.startRace(Object.assign(hostSettings(), { roster: bots.concat(humans) }));
  }
  // przejście do pokoju w trakcie wyścigu online: wyścig trwa dalej (auto jedzie samo), można wrócić
  function toLobby() {
    if (!(game && game.net && game.state !== 'done')) { if (game && game.net) quitRace(); else { endGame(); showScreen('menu'); } return; }
    paused = false;
    game.away = true;
    game.humans[0].auto = true;
    showScreen('menu');
    refreshMenu();
    renderLobby();
  }
  function backToRace() {
    if (!(game && game.away)) return;
    game.away = false;
    game.humans[0].auto = false;
    showScreen('race');
    layout();
    if (game.state === 'done') showResults();
  }
  // wycofanie się z trwającego wyścigu (inni widzą, że wyszliśmy)
  function quitRace() {
    if (game && game.net && game.humans[0]) {
      game.humans[0].quit = true;
      game.net.sendT = 0;
      netTick(0);
    }
    endGame();
    showScreen('menu');
    refreshMenu();
  }
  function settingsText(st) {
    if (!st) return '';
    const route = st.route === 'loop' ? '🔁 pętla, ' + st.laps + ' okr.' : st.route === 'ab' ? '🅰️➡️🅱️ z A do B' : '♾️ bez końca';
    const shape = ['łagodny', 'kręty', 'bardzo kręty'][st.shape] || '';
    const th = st.theme === 'losowy' ? 'losowy świat' : (THEMES[st.theme] || {}).name;
    return 'Ustawienia gospodarza: ' + route + ' · tor ' + shape + ' · ' + th + ' · ' + (st.barriers ? 'z bandami' : 'bez band') +
      ' · komputer: ' + (st.bots ? st.bots + ' (' + ['łatwy', 'średni', 'trudny'][st.diff] + ')' : 'brak');
  }
  function renderLobby() {
    const inRoom = !!net;
    $('onOff').classList.toggle('hidden', inRoom);
    $('onIn').classList.toggle('hidden', !inRoom);
    if (!inRoom) return;
    const st = net.status();
    if (st.kind === 'ok' && game && game.net && game.state !== 'done') st.text = 'Wyścig trwa – możesz do niego wrócić przyciskiem poniżej.';
    $('led').className = 'led ' + st.kind;
    $('netText').textContent = st.text;
    $('roomCode').textContent = net.room;
    $('shareLink').textContent = RaceNet.link(net.room);
    $('shareBox').classList.toggle('hidden', !net.host || !!net.err);
    $('btnShare').classList.toggle('hidden', !navigator.share);
    // lista graczy
    const box = $('netPlayers');
    box.innerHTML = '';
    for (let k = 0; k < RaceNet.MAX; k++) {
      const pl = net.players[k];
      const row = document.createElement('div');
      row.className = 'np' + (pl ? '' : ' empty');
      if (pl) {
        row.appendChild(portrait(pl.c | 0, 26));
        const on = k === net.slot || net.online(k);
        const t = document.createElement('span');
        t.innerHTML = '<b>Gracz ' + (k + 1) + '</b> ' + (CHARS[pl.c | 0] || CHARS[0]).name + ' ' + (VEH[pl.v | 0] || VEH[0]).icon +
          (k === 0 ? ' 👑' : '') + (k === net.slot ? ' <small>(Ty)</small>' : '') + (on ? '' : ' <small>(offline)</small>');
        row.appendChild(t);
      } else row.textContent = 'wolne miejsce';
      box.appendChild(row);
    }
    // gość: ustawienia gospodarza (podgląd toru)
    if (!net.host && net.settings) {
      $('netSettings').textContent = settingsText(net.settings);
      const js = JSON.stringify(hostSettingsOf(net.settings));
      if (js !== lastSettingsJSON && !(game && game.state !== 'done')) {
        lastSettingsJSON = js;
        for (const k of NET_KEYS) if (net.settings[k] !== undefined) cfg[k] = net.settings[k];
        refreshMenu(); drawPreview();
      }
    } else $('netSettings').textContent = net.host ? 'Ty wybierasz trasę i ustawienia – gracze zobaczą je u siebie.' : '';
    updateStartBtn();
  }
  const hostSettingsOf = st => { const o = {}; for (const k of NET_KEYS) o[k] = st[k]; return o; };
  function updateStartBtn() {
    const racing = !!(game && game.net && game.away && game.state !== 'done');
    const away = !!(game && game.net && game.away);
    if ($('btnBackRace')) {
      $('btnBackRace').classList.toggle('hidden', !away);
      $('btnBackRace').textContent = racing ? '🏁 Wróć do wyścigu (trwa – Twoje auto jedzie samo)' : '🏆 Zobacz wyniki wyścigu';
    }
    const b = $('btnStart');
    if (b.disabled && b.textContent.startsWith('Budowanie')) return;
    if (!net) { b.disabled = false; b.textContent = '🏁 Start!'; return; }
    if (net.host) { b.disabled = !!net.err; b.textContent = '🏁 Start dla wszystkich (' + Math.max(1, Object.keys(net.players).filter(k => k === '0' || net.online(k)).length) + ')'; }
    else { b.disabled = true; b.textContent = net.slot >= 0 ? '⏳ Czekam, aż gospodarz rozpocznie…' : '⏳ Łączę z pokojem…'; }
  }

  function init() {
    refreshMenu();
    drawPreview();
    $('btnReroll').addEventListener('click', () => { cfg.seed = 1 + Math.floor(Math.random() * 99999); drawPreview(); });
    $('seedInput').addEventListener('change', () => {
      const v = parseInt($('seedInput').value, 10);
      if (v > 0 && v < 1e6) { cfg.seed = v; drawPreview(); } else $('seedInput').value = cfg.seed;
    });
    $('btnStart').addEventListener('click', () => {
      if (net) { if (net.host) hostStart(); return; }
      $('btnStart').disabled = true; $('btnStart').textContent = 'Budowanie świata…';
      setTimeout(() => {
        try { startRace(); } finally { $('btnStart').disabled = false; $('btnStart').textContent = '🏁 Start!'; }
      }, 30);
    });
    // gra online
    $('onlineOff').classList.toggle('hidden', RaceNet.configured());
    $('btnHostRoom').disabled = !RaceNet.configured();
    $('btnJoinRoom').disabled = !RaceNet.configured();
    $('btnHostRoom').addEventListener('click', () => enterRoom(true, RaceNet.randomCode(6)));
    $('btnJoinRoom').addEventListener('click', () => {
      const code = RaceNet.cleanCode($('joinCode').value);
      if (!RaceNet.ROOM_RE.test(code)) { alert('Podaj kod pokoju (6–12 liter i cyfr).'); return; }
      enterRoom(false, code);
    });
    $('btnLeaveRoom').addEventListener('click', leaveRoom);
    $('btnCopy').addEventListener('click', async () => {
      const l = RaceNet.link(net.room);
      try { await navigator.clipboard.writeText(l); $('btnCopy').textContent = 'Skopiowano ✓'; } catch (e) { prompt('Skopiuj link:', l); }
      setTimeout(() => { $('btnCopy').textContent = 'Kopiuj link'; }, 2000);
    });
    $('btnShare').addEventListener('click', () => { navigator.share({ title: 'Wyścigi klocków', text: 'Zagraj ze mną w Wyścigi klocków!', url: RaceNet.link(net.room) }).catch(() => {}); });
    addEventListener('pagehide', () => { if (net) net.leave(); });
    const qRoom = RaceNet.cleanCode(new URLSearchParams(location.search).get('wyscig'));
    if (qRoom && RaceNet.ROOM_RE.test(qRoom) && RaceNet.configured()) enterRoom(false, qRoom);
    renderLobby();
    $('btnPause').addEventListener('click', () => setPause(true));
    $('btnResume').addEventListener('click', () => setPause(false));
    $('btnRestart').addEventListener('click', () => startRace());
    $('btnQuit').addEventListener('click', () => { if (game && game.net) toLobby(); else { endGame(); showScreen('menu'); } });
    $('btnBackRace').addEventListener('click', backToRace);
    $('btnSound2').addEventListener('click', () => { Snd.setOn(!Snd.on); setPause(true); });
    $('btnAgain').addEventListener('click', () => { if (net && net.host) hostStart(); else startRace(); });
    $('btnNew').addEventListener('click', () => { cfg.seed = 1 + Math.floor(Math.random() * 99999); drawPreview(); if (net && net.host) hostStart(); else startRace(); });
    $('btnMenu').addEventListener('click', () => { if (game && game.net) quitRace(); else { endGame(); showScreen('menu'); } });
    showScreen('menu');
    if (!document.createElement('canvas').getContext('webgl')) { $('noGL').classList.remove('hidden'); cfg.view = '2d'; refreshMenu(); }
  }
  init();

  // do testów w konsoli
  window.Wyscigi = { cfg, genTrack, makeOpenTrack, get game() { return game; }, sim(n) { for (let i = 0; i < n && game && game.state !== 'done'; i++) { update(STEP); while (game.jobs.length) if (game.jobs[0].next().done) game.jobs.shift(); } } };
})();
