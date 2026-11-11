'use strict';
// Wyścigi klocków – logika gry: tor losowy, świat z bloków, fizyka gokartów,
// przeszkody i bonusy, komputerowi kierowcy, podzielony ekran dla dwóch graczy.
(function () {
  const BG = window.BlockGL;
  const { T, B, CHARS, MeshBuilder, buildWorldChunks, M, rng, hex } = BG;

  // ---------- stałe ----------
  const HW = 4.6;               // pół szerokości jezdni
  const WALL = HW + 4;          // odległość bandy od środka toru
  const Y0 = 4, HY = 30, CH = 16;
  const STEP = 1 / 60;
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
    { n: [7, 13], R: [52, 78], rad: [0.45, 1], smooth: true, warp: 0, curv: 0.55, len: [280, 800] },
    { n: [9, 15], R: [58, 86], rad: [0.32, 1], smooth: true, warp: [5, 9], curv: 0.6, len: [330, 1000] },
    { n: [11, 18], R: [66, 96], rad: [0.25, 1], smooth: false, warp: [8, 14], curv: 0.66, len: [400, 1250] }
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
      const t = finishTrack(pts, seed);
      t.shape = shape;
      return t;
    }
    if (shape > 0) return genTrack(seed, shape - 1);
    // awaryjnie: elipsa
    const pts = [];
    for (let k = 0; k < 400; k++) { const a = k / 400 * Math.PI * 2; pts.push([Math.cos(a) * 80, Math.sin(a) * 45]); }
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
    const minD = (2 * WALL + 4) ** 2;
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
    const curvAt = i => Math.abs(angDiff(heading((i + 8) % N), heading((i + N - 8) % N)));
    // start w środku najdłuższej prostej
    let best = 0, bestV = Infinity;
    for (let i = 0; i < N; i += 2) {
      let s = 0;
      for (let k = -30; k <= 12; k += 3) s += curvAt((i + k + N) % N);
      if (s < bestV) { bestV = s; best = i; }
    }
    pts = pts.slice(best).concat(pts.slice(0, best));
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const margin = 34;
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
      for (let k = 4; k <= 26; k += 4) m = Math.max(m, Math.abs(angDiff(HD[(i + k) % N], HD[i])));
      CURV[i] = m;
    }
    return { seed, N, X, Z, TX, TZ, NX, NZ, HD, CURV, W, D };
  }

  // ---------- świat ----------
  function genWorld(track, theme, seed, barriers) {
    const { W, D, N, X, Z, NX, NZ } = track;
    const th = THEMES[theme];
    const r = rng(seed * 31 + 7);
    const noise = makeNoise(seed % 10007), noise2 = makeNoise((seed * 3 + 11) % 10007);
    const dist = new Float32Array(W * D).fill(99), near = new Int32Array(W * D).fill(-1);
    const FLAT = barriers ? WALL : HW + 13; // do tej odległości teren jest płaski
    const RR = FLAT + 9;
    for (let k = 0; k < N; k++) {
      const cx = X[k], cz = Z[k];
      for (let z = Math.max(0, Math.floor(cz - RR)); z <= Math.min(D - 1, Math.ceil(cz + RR)); z++)
        for (let x = Math.max(0, Math.floor(cx - RR)); x <= Math.min(W - 1, Math.ceil(cx + RR)); x++) {
          const d = Math.hypot(x + 0.5 - cx, z + 0.5 - cz), c = z * W + x;
          if (d < dist[c]) { dist[c] = d; near[c] = k; }
        }
    }
    const vox = new Uint8Array(W * D * HY);
    const colH = new Float32Array(W * D);
    const surf = new Uint8Array(W * D).fill(S_OFF);
    const height = new Int8Array(W * D);
    const set = (x, wy, z, id) => { const y = wy + Y0; if (x >= 0 && z >= 0 && x < W && z < D && y >= 0 && y < HY) vox[(y * D + z) * W + x] = id; };
    const get = (x, wy, z) => { const y = wy + Y0; return (x < 0 || z < 0 || x >= W || z >= D || y < 0 || y >= HY) ? 0 : vox[(y * D + z) * W + x]; };
    const column = (x, z, h, top) => {
      for (let y = -3; y < h; y++) set(x, y, z, y === h - 1 ? top : (y >= h - 3 ? th.sub : (theme === 'pustynia' ? B.sandstone : B.stone)));
    };
    for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
      const c = z * W + x, d = dist[c];
      if (d <= HW) {
        let top = th.road;
        const k = near[c];
        if (d > HW - 1) top = (Math.floor(k / 3) % 2) ? B.curb_red : B.curb_white;
        if (k <= 1 || k >= N - 1) top = B.finish;
        column(x, z, 0, top);
        surf[c] = S_ROAD;
      } else if (d < (barriers ? WALL - 0.5 : FLAT)) {
        column(x, z, 0, th.top);
        if (th.plantP && r() < th.plantP * 0.3) set(x, 0, z, th.plants[Math.floor(r() * th.plants.length)]);
      } else if (barriers && d < WALL + 0.5) {
        column(x, z, 0, th.top);
        set(x, 0, z, th.wall);
        colH[c] = 1;
      } else {
        const n = noise(x / 26, z / 26);
        const edge = Math.min(x, z, W - 1 - x, D - 1 - z);
        const fade = clamp((d - FLAT - 1.5) / 7, 0, 1) * clamp(edge / 7, 0, 1);
        if (n < th.lakeLevel && d > FLAT + 2.5 && edge > 2) {
          column(x, z, -1, th.sub);
          set(x, -1, z, th.lake);
          surf[c] = th.lakeSurf;
          height[c] = 0;
          continue;
        }
        let h = Math.floor(Math.max(0, (n - 0.5) * 18) * fade);
        if (h > 10) h = 10;
        height[c] = h;
        colH[c] = h;
        column(x, z, h, h >= 6 ? th.peak : th.top);
      }
    }
    // drzewa, kaktusy, kwiaty (tylko poza bandą)
    const trees = [];
    for (let z = 2; z < D - 2; z++) for (let x = 2; x < W - 2; x++) {
      const c = z * W + x;
      if (dist[c] < FLAT + 2 || surf[c] !== S_OFF) continue;
      const h = height[c];
      if (r() < th.treeP && h < 6 && !trees.some(t => Math.abs(t[0] - x) < 6 && Math.abs(t[1] - z) < 6)) {
        trees.push([x, z]);
        if (th.tree === 'oak') {
          const t = 4 + Math.floor(r() * 2);
          for (let y = 0; y < t; y++) set(x, h + y, z, B.log);
          for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
            const rr = dx * dx + dz * dz + (dy + 0.5) * (dy + 0.5) * 1.3;
            if (rr <= 5.2 && (rr < 4 || r() < 0.6) && !get(x + dx, h + t + dy, z + dz)) set(x + dx, h + t + dy, z + dz, B.leaves);
          }
          colH[c] = h + t;
        } else if (th.tree === 'pine') {
          const t = 6 + Math.floor(r() * 2);
          for (let y = 0; y < t; y++) set(x, h + y, z, B.log);
          let layer = 0;
          for (let y = t + 1; y >= 2; y--) {
            const rad = Math.min(2, Math.floor(layer / 2)) + (layer % 2 && layer > 2 ? 0 : 0);
            for (let dx = -rad; dx <= rad; dx++) for (let dz = -rad; dz <= rad; dz++) {
              if (Math.abs(dx) + Math.abs(dz) > rad + 1) continue;
              if (!get(x + dx, h + y, z + dz)) set(x + dx, h + y, z + dz, B.pine);
            }
            layer++;
          }
          colH[c] = h + t;
        } else {
          const t = 2 + Math.floor(r() * 2);
          for (let y = 0; y < t; y++) set(x, h + y, z, B.cactus);
          colH[c] = h + t;
        }
      } else if (th.plantP && r() < th.plantP && !get(x, h, z)) {
        set(x, h, z, th.plants[Math.floor(r() * th.plants.length)]);
      }
    }

    // brama startowa
    const gate = [];
    const p0x = X[0], p0z = Z[0];
    for (const s of [1, -1]) {
      const gx = Math.floor(p0x + NX[0] * (HW + 1.7) * s), gz = Math.floor(p0z + NZ[0] * (HW + 1.7) * s);
      gate.push([gx, gz]);
      for (let y = 0; y < 6; y++) set(gx, y, gz, B.log);
      colH[gz * W + gx] = 6;
    }
    {
      const [a, b] = gate;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let t = 0; t <= L; t += 0.3) {
        const gx = Math.round(a[0] + (b[0] - a[0]) * t / L), gz = Math.round(a[1] + (b[1] - a[1]) * t / L);
        if (get(gx, 0, gz) === B.log) continue;
        set(gx, 5, gz, B.finish);
        set(gx, 6, gz, B.planks);
      }
    }

    // bonusy: rzędy kostek w poprzek toru
    const boxes = [];
    const rows = [0.13, 0.38, 0.63, 0.87].map(f => Math.floor(N * f));
    for (const k of rows) for (const o of [-3.2, -1.07, 1.07, 3.2]) boxes.push({ x: X[k] + NX[k] * o, z: Z[k] + NZ[k] * o, k, active: true, t: 0 });

    // przeszkody
    const hazards = [];
    const tnts = [];
    const cellsAround = (px, pz, rad) => {
      const out = [];
      for (let z = Math.floor(pz - rad); z <= Math.floor(pz + rad); z++) for (let x = Math.floor(px - rad); x <= Math.floor(px + rad); x++) {
        if (x < 0 || z < 0 || x >= W || z >= D) continue;
        if (Math.hypot(x + 0.5 - px, z + 0.5 - pz) <= rad && dist[z * W + x] <= HW + 0.2) out.push([x, z]);
      }
      return out;
    };
    let k = 46;
    const types = ['pile', 'pile', 'mud', 'slick', 'slime', 'tnt', 'tnt', 'mud'];
    while (k < N - 30) {
      if (rows.some(rk => Math.abs(rk - k) < 9)) { k += 5; continue; }
      const type = types[Math.floor(r() * types.length)];
      const side = r() < 0.5 ? -1 : 1;
      if (type === 'pile') {
        const o = r() < 0.3 ? 0 : side * 2.5;
        const px = X[k] + NX[k] * o, pz = Z[k] + NZ[k] * o;
        const cells = cellsAround(px, pz, 1.3);
        for (const [x, z] of cells) { set(x, 0, z, th.pile); colH[z * W + x] = Math.max(colH[z * W + x], 1); }
        const cx = Math.floor(px), cz = Math.floor(pz);
        if (r() < 0.6 && dist[cz * W + cx] <= HW) { set(cx, 1, cz, th.pile); colH[cz * W + cx] = 2; }
        hazards.push({ k, o, rad: 1.6, type });
      } else if (type === 'mud' || type === 'slick') {
        const o = (r() - 0.5) * 4;
        const rad = type === 'mud' ? 2.3 : 1.8;
        const px = X[k] + NX[k] * o, pz = Z[k] + NZ[k] * o;
        for (const [x, z] of cellsAround(px, pz, rad)) {
          const c = z * W + x;
          if (colH[c] > 0) continue;
          set(x, -1, z, type === 'mud' ? B.mud : th.slick);
          surf[c] = type === 'mud' ? S_MUD : th.slickSurf;
        }
        hazards.push({ k, o, rad: rad + 0.3, type });
      } else if (type === 'slime') {
        const o = (r() - 0.5) * 4.5;
        const px = X[k] + NX[k] * o, pz = Z[k] + NZ[k] * o;
        for (const [x, z] of cellsAround(px, pz, 1.5)) {
          const c = z * W + x;
          if (colH[c] > 0) continue;
          set(x, -1, z, B.slime); surf[c] = S_SLIME;
        }
      } else {
        const o = (r() - 0.5) * 6;
        const tnt = { x: X[k] + NX[k] * o, z: Z[k] + NZ[k] * o, k, o, active: true, t: 0, fixed: true, armT: 0, owner: null };
        tnts.push(tnt);
        hazards.push({ k, o, rad: 1.2, type: 'tnt', ref: tnt });
      }
      k += 17 + Math.floor(r() * 22);
    }
    return { W, D, H: HY, Y0, vox, colH, surf, dist, near, boxes, hazards, tnts, theme, th, barriers };
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
    }
  ];
  function vehMesh(v, color) {
    const mb = new MeshBuilder(), c = col01(color);
    for (const p of VEH[v].parts) {
      if (p[6] === 'P') mb.box(p[0], p[1], p[2], p[3], p[4], p[5], T.paint, c);
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
    players: 1, chars: [0, 1], veh: [0, 0], bots: 3, diff: 1, theme: 'laka', laps: 3, shape: 1, barriers: true,
    view: isPhone ? '2d' : '3d', seed: 1 + Math.floor(Math.random() * 99999)
  };
  let R = null;          // renderer WebGL (tylko widok 3D)
  let game = null;       // bieżący wyścig
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
  function wheelMeshFor(rw, ww) {
    const key = rw + '_' + ww;
    return meshes.wheels[key] || (meshes.wheels[key] = R.upload(wheelMesh(rw, ww)));
  }
  const trackFor = () => (previewTrack && previewTrack.seed === cfg.seed && previewTrack.wantShape === cfg.shape) ? previewTrack
    : Object.assign(genTrack(cfg.seed, cfg.shape), { wantShape: cfg.shape });

  function newRacer(ch, veh, human, k, lane, track) {
    const { X, Z, NX, NZ, HD } = track;
    return {
      ch, veh, human, x: X[k] + NX[k] * lane, z: Z[k] + NZ[k] * lane, y: 0, vx: 0, vz: 0, vy: 0, h: HD[k],
      steer: 0, idx: k, lap: 0, armed: true, prog: k, finished: false, finishT: 0, lapStart: 0, bestLap: 0,
      item: null, itemT: 0, turboT: 0, shieldT: 0, spinT: 0, slipT: 0, ghostT: 0, offT: 0, wrongT: 0,
      wheel: 0, fwd: 0, ctrl: { thr: 0, steer: 0, item: false }, prevItem: false, place: 0, msg: '', msgT: 0,
      ai: { lane: lane, laneT: 0, stuckT: 0, revT: 0, skill: 1, mul: 1 }, camH: HD[k], fov: 1.2, shake: 0, eng: null, surf: S_ROAD
    };
  }

  function startRace() {
    let mode = cfg.view;
    if (mode === '3d' && !ensureRenderer()) {
      mode = '2d';
      alert('Ta przeglądarka nie obsługuje grafiki 3D (WebGL) – gra uruchomi się w widoku 2D z góry.');
    }
    Snd.init();
    endGame();
    const track = trackFor();
    const theme = cfg.theme === 'losowy' ? ['laka', 'pustynia', 'zima'][cfg.seed % 3] : cfg.theme;
    const world = genWorld(track, theme, cfg.seed, cfg.barriers);
    let chunks = [], clouds = null, sea = null, map2d = null;
    if (mode === '3d') {
      chunks = buildWorldChunks(world, CH).map(c => ({ m: R.upload(c.mb), x: c.cx, z: c.cz }));
      // chmury i „morze” wokół wyspy
      const cl = new MeshBuilder(), cn = makeNoise(cfg.seed + 99);
      for (let gx = -120; gx < world.W + 120; gx += 8) for (let gz = -120; gz < world.D + 120; gz += 8) {
        if (cn(gx / 40, gz / 40) > 0.6) cl.box(gx, 40, gz, gx + 8, 41.5, gz + 8, T.white, [1, 1, 1]);
      }
      const sm = new MeshBuilder();
      const S = 700, sc = world.th.sea;
      sm.quad([[-S, -0.9, -S], [world.W + S, -0.9, -S], [world.W + S, -0.9, world.D + S], [-S, -0.9, world.D + S]], T.white, sc);
      clouds = R.upload(cl); sea = R.upload(sm);
    } else map2d = buildMap2D(world);
    // zawodnicy
    const N = track.N;
    const humans = cfg.players;
    const used = new Set(cfg.chars.slice(0, humans));
    const botChars = [];
    for (let i = 0; i < CHARS.length && botChars.length < cfg.bots; i++) if (!used.has(i)) botChars.push(i);
    const racers = [];
    const order = botChars.map(c => ({ c, h: -1, v: Math.floor(Math.random() * VEH.length) }))
      .concat(cfg.chars.slice(0, humans).map((c, i) => ({ c, h: i, v: cfg.veh[i] })));
    order.forEach((o, i) => {
      const k = (N - 6 - i * 4) % N;
      const r = newRacer(o.c, o.v, o.h, k, i % 2 ? -2.1 : 2.1, track);
      r.ai.skill = [0.8, 0.9, 0.985][cfg.diff] - (o.h < 0 ? (botChars.indexOf(o.c) * 0.012) : 0);
      if (mode === '2d') r.sprite = makeSprite(o.v, o.c);
      racers.push(r);
    });
    const humanRacers = racers.filter(r => r.human >= 0).sort((a, b) => a.human - b.human);
    humanRacers.forEach(r => { r.eng = Snd.engine(); });
    game = {
      mode, track, world, chunks, clouds, sea, map2d, racers, humans: humanRacers,
      t: -3.5, state: 'countdown', parts: [], endT: 0, firstFinishT: 0, lastBeep: 4, minimap: makeMinimap(track, world.th)
    };
    paused = false;
    showScreen('race');
    layout();
  }

  function endGame() {
    if (!game) return;
    if (game.mode === '3d') {
      for (const c of game.chunks) R.free(c.m);
      R.free(game.clouds); R.free(game.sea);
    }
    for (const r of game.racers) if (r.eng) r.eng.stop();
    game = null;
  }

  // ---------- świat: zapytania ----------
  function cellIdx(x, z) {
    const w = game.world, ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= w.W || iz >= w.D) return -1;
    return iz * w.W + ix;
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
  addEventListener('blur', () => { keys.clear(); if (game && game.state !== 'done') setPause(true); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && game && game.state !== 'done') setPause(true); });

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
    if (a.laneT <= 0) { a.lane = (Math.random() - 0.5) * 4; a.laneT = 3 + Math.random() * 4; }
    let lane = a.lane;
    // omijanie przeszkód
    let hazardAhead = null;
    const list = game.world.hazards.concat(game.dropped || []);
    for (const hz of list) {
      if (hz.ref && !hz.ref.active) continue;
      const df = (hz.k - r.idx + N) % N;
      if (df < 2 || df > 26) continue;
      if (Math.abs(lane - hz.o) < hz.rad + 1.3) {
        const l1 = hz.o - hz.rad - 1.4, l2 = hz.o + hz.rad + 1.4;
        const ok1 = l1 > -HW + 1, ok2 = l2 < HW - 1;
        lane = ok1 && ok2 ? (Math.abs(l1 - curLat) < Math.abs(l2 - curLat) ? l1 : l2) : ok1 ? l1 : l2;
      }
      if (!hazardAhead || df < hazardAhead.df) hazardAhead = { df, hz };
    }
    const look = Math.round(5 + speed * 0.42);
    const k = (r.idx + look) % N;
    const tx = tr.X[k] + tr.NX[k] * lane, tz = tr.Z[k] + tr.NZ[k] * lane;
    const want = Math.atan2(tx - r.x, tz - r.z);
    const diff = angDiff(want, r.h);
    let steer = clamp(-diff * 2.6, -1, 1);
    const curv = tr.CURV[r.idx];
    const vmax = VEH[r.veh].speed * r.ai.mul;
    const target = vmax * (1 - Math.min(0.42, curv * 0.42));
    let thr = speed < target ? 1 : (speed > target + 2.5 ? -1 : 0);
    if (Math.abs(diff) > 0.9 && speed > 9) thr = -1;
    // utknięcie
    if (a.revT > 0) { a.revT -= dt; thr = -1; steer = -steer; }
    else if (Math.abs(r.fwd) < 1.2 && game.state === 'race' && r.spinT <= 0) { a.stuckT += dt; if (a.stuckT > 1.3) { a.revT = 0.9; a.stuckT = 0; } }
    else a.stuckT = 0;
    // bonusy
    let item = false;
    if (r.item) {
      r.itemT += dt;
      const lvl = cfg.diff;
      if (r.item === 'turbo') item = curv < 0.25 && r.itemT > 0.8;
      else if (r.item === 'tarcza') item = (hazardAhead && hazardAhead.df < 14) || r.itemT > 5;
      else if (r.item === 'skok') item = (hazardAhead && hazardAhead.hz.type === 'pile' && hazardAhead.df > 3 && hazardAhead.df < 8 && Math.abs(curLat - hazardAhead.hz.o) < 2.5) || r.itemT > 7;
      else if (r.item === 'tnt') {
        const behind = game.racers.some(o => o !== r && ((r.prog - o.prog) > 3 && (r.prog - o.prog) < 16));
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
      r.vx += fx * 6; r.vz += fz * 6;
      if (heard) Snd.turbo();
    } else if (it === 'tarcza') {
      r.shieldT = 6;
      if (heard) Snd.beep(520, 0.3, 'triangle', 0.1, 1040);
    } else if (it === 'tnt') {
      const t = { x: r.x - fx * 2.2, z: r.z - fz * 2.2, active: true, t: 0, fixed: false, armT: 0.7, owner: r };
      const tr = game.track;
      t.k = r.idx; t.o = (t.x - tr.X[r.idx]) * tr.NX[r.idx] + (t.z - tr.Z[r.idx]) * tr.NZ[r.idx];
      game.world.tnts.push(t);
      (game.dropped = game.dropped || []).push({ k: t.k, o: t.o, rad: 1.2, type: 'tnt', ref: t });
      if (heard) Snd.beep(200, 0.15, 'square', 0.1);
    } else if (it === 'skok') {
      r.vy = 10.5;
      if (heard) Snd.boing();
    }
  }

  function groundUnder(r) {
    const c = cellIdx(r.x, r.z);
    if (c < 0) return 0;
    const h = game.world.colH[c];
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
    if (r.human < 0 || r.finished || r.auto) aiInput(r, dt); else readInput(r);
    if (racing && r.ctrl.item) useItem(r);

    const c = cellIdx(r.x, r.z);
    const ground = groundUnder(r);
    const onGround = r.y <= ground + 0.02 && r.vy <= 0;
    const surf = onGround && c >= 0 ? (w.colH[c] > 0 ? S_ROAD : w.surf[c]) : -1;
    r.surf = surf;
    const shield = r.shieldT > 0;

    r.steer += clamp(r.ctrl.steer - r.steer, -dt * 7, dt * 7);
    let fx = Math.sin(r.h), fz = Math.cos(r.h);
    let fwd = r.vx * fx + r.vz * fz, lat = r.vx * fz - r.vz * fx;

    const V = VEH[r.veh];
    let vmax = V.speed * (r.human < 0 || r.finished || r.auto ? r.ai.mul : 1);
    if (r.finished) vmax *= 0.6;
    let mul = 1;
    if (surf === S_OFF) mul = V.off;
    else if (surf === S_MUD && !shield) mul = V.mud;
    else if (surf === S_WATER) mul = Math.max(0.35, V.off * 0.6);
    if (r.turboT > 0) mul = Math.max(mul, 1) * 1.5;
    vmax *= mul;
    const accel = r.turboT > 0 ? V.accel * 2.2 : V.accel;

    if (onGround) {
      if (!racing) fwd *= Math.exp(-6 * dt);
      else if (r.spinT > 0) fwd *= Math.exp(-2.5 * dt);
      else {
        const th = r.ctrl.thr;
        if (th > 0.1) { if (fwd < vmax) fwd = Math.min(vmax, fwd + accel * th * dt); }
        else if (th < -0.1) { if (fwd > 0.5) fwd -= 30 * -th * dt; else fwd = Math.max(-7, fwd - 11 * -th * dt); }
        else fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), 5 * dt);
        if (r.turboT > 0) fwd = Math.max(fwd, vmax * 0.85);
        if (fwd > vmax) fwd = Math.max(vmax, fwd - 26 * dt);
      }
      // przyczepność
      let grip = V.grip;
      if (r.slipT > 0 && !shield) grip = 1.0;
      if (surf === S_ICE && !shield) { grip = 1.3; }
      lat *= Math.exp(-grip * dt);
    }
    // skręcanie
    if (racing && r.spinT <= 0) {
      const sp = Math.abs(fwd);
      const k = clamp(sp / 5, 0, 1) * (1 - Math.min(0.3, sp / V.speed * 0.25));
      r.h += -r.steer * V.turn * k * Math.sign(fwd || 1) * dt * (onGround ? 1 : 0.35);
    }
    if (r.spinT > 0) r.h += 10 * dt;
    fx = Math.sin(r.h); fz = Math.cos(r.h);
    r.vx = fx * fwd + fz * lat; r.vz = fz * fwd - fx * lat;
    r.fwd = fwd;

    r.x += r.vx * dt; r.z += r.vz * dt;

    // pion: skoki i spadanie
    const g2 = groundUnder(r);
    if (r.y > g2 + 0.001 || r.vy > 0) {
      r.vy -= 26 * dt; r.y += r.vy * dt;
      if (r.y <= g2) {
        if (r.vy < -9) { puff(r.x, r.y + 0.1, r.z, w.th.dust, 6, 1.6, 0.7); if (r.human >= 0) Snd.bump(); r.shake = 0.25; }
        r.y = g2; r.vy = 0;
      }
    } else r.y = g2;

    // trampolina, olej, lód
    if (onGround && racing && c >= 0) {
      if (surf === S_SLIME && Math.abs(fwd) > 3) { r.vy = 9.5; if (r.human >= 0) Snd.boing(); puff(r.x, 0.2, r.z, [0.5, 0.95, 0.4], 5, 1.4, 0.5); }
      if (surf === S_OIL && !shield && r.slipT <= 0 && Math.abs(fwd) > 5) { r.slipT = 1.2; r.spinT = 0.55; message(r, 'Plama oleju!'); if (r.human >= 0) Snd.beep(300, 0.3, 'sine', 0.1, 150); }
      if (surf === S_MUD && !shield && Math.abs(fwd) > 4 && Math.random() < 0.3) puff(r.x, 0.2, r.z, [0.35, 0.24, 0.12], 1, 1.2, 0.5);
      if (surf === S_OFF && Math.abs(fwd) > 6 && Math.random() < 0.35) puff(r.x - fx * 1.2, 0.2, r.z - fz * 1.2, w.th.dust, 1, 1.2, 0.55);
    }
    if (r.turboT > 0 && Math.random() < 0.8) {
      game.parts.push({ x: r.x - fx * 1.3 + (Math.random() - 0.5) * 0.4, y: r.y + 0.45, z: r.z - fz * 1.3, vx: -fx * 3, vy: 0.5, vz: -fz * 3, g: 0, life: 0, max: 0.25, size: 0.55, grow: -1, col: [1, 0.55 + Math.random() * 0.35, 0.1], a: 1, tile: T.glow });
    }

    collideCells(r);

    // bonusy
    for (const b of w.boxes) {
      if (!b.active) continue;
      const dx = r.x - b.x, dz = r.z - b.z;
      if (dx * dx + dz * dz < 1.6 && r.y < 2.2) {
        b.active = false; b.t = 3;
        for (let i = 0; i < 8; i++) game.parts.push({ x: b.x, y: 1, z: b.z, vx: (Math.random() - 0.5) * 5, vy: Math.random() * 4 + 1, vz: (Math.random() - 0.5) * 5, g: 8, life: 0, max: 0.5, size: 0.35, grow: 0, col: [1, 0.85, 0.2], a: 1, tile: T.glow });
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
      if (dx * dx + dz * dz < 1.35 * 1.35 && r.y < 1.1) {
        t.active = false; t.t = 7;
        explode(t.x, 0, t.z);
        if (game.humans.some(h => Math.hypot(h.x - t.x, h.z - t.z) < 40)) Snd.boom();
        if (!shield) { r.spinT = 1.1; r.vy = 6; r.vx *= 0.25; r.vz *= 0.25; message(r, 'BUM!', 1.2); r.shake = 0.5; }
        else message(r, 'Tarcza ochroniła Cię!', 1.2);
      }
    }

    // pozycja na torze, okrążenia
    let best = r.idx, bd = Infinity;
    for (let o = -14; o <= 14; o++) {
      const k = (r.idx + o + N) % N;
      const dx = tr.X[k] - r.x, dz = tr.Z[k] - r.z, d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = k; }
    }
    const prev = r.idx;
    if (prev > N * 0.75 && best < N * 0.25) {
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
    if (best > N * 0.4 && best < N * 0.6) r.armed = true;
    r.idx = best;
    const along = (r.x - tr.X[best]) * tr.TX[best] + (r.z - tr.Z[best]) * tr.TZ[best];
    r.prog = r.lap * N + best + clamp(along, -0.5, 0.5);
    const latOff = Math.abs((r.x - tr.X[best]) * tr.NX[best] + (r.z - tr.Z[best]) * tr.NZ[best]);

    // poza trasą → powrót na tor
    const limit = w.barriers ? WALL + 1.2 : HW + 15;
    if (!w.barriers && latOff > HW + 10 && r.human >= 0 && racing) message(r, 'Wracaj na trasę!', 0.3);
    if (latOff > limit && (onGround || !w.barriers)) {
      r.offT += dt;
      if (r.offT > (w.barriers ? 0.7 : 0.4)) respawn(r);
    } else r.offT = 0;
    // zły kierunek
    if (racing && !r.finished && fx * tr.TX[best] + fz * tr.TZ[best] < -0.35 && Math.abs(fwd) > 2) r.wrongT += dt; else r.wrongT = 0;
    r.wheel += fwd * dt / VEH[r.veh].wheels[2][2];
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
    const k = r.idx;
    r.x = tr.X[k]; r.z = tr.Z[k]; r.y = 0; r.vx = r.vz = r.vy = 0; r.h = tr.HD[k]; r.camH = r.h;
    r.offT = 0; r.spinT = 0; r.slipT = 0; r.ghostT = 1.8;
    if (r.human >= 0) message(r, 'Powrót na trasę', 1.2);
  }

  function collideCells(r) {
    const w = game.world, rad = VEH[r.veh].rad;
    for (let pass = 0; pass < 2; pass++) {
      for (let gz = Math.floor(r.z - rad); gz <= Math.floor(r.z + rad); gz++) for (let gx = Math.floor(r.x - rad); gx <= Math.floor(r.x + rad); gx++) {
        const out = gx < 0 || gz < 0 || gx >= w.W || gz >= w.D;
        if (!out && w.colH[gz * w.W + gx] <= r.y + 0.35) continue;
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
          if (-vn > 6) {
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
      if (a.ghostT > 0 || b.ghostT > 0 || Math.abs(a.y - b.y) > 1.2) continue;
      let dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      const minD = VEH[a.veh].rad + VEH[b.veh].rad;
      if (d >= minD || d < 1e-4) continue;
      dx /= d; dz /= d;
      const push = (minD - d) / 2;
      let wa = (a.shieldT > 0 ? 0.2 : 1) / VEH[a.veh].mass, wb = (b.shieldT > 0 ? 0.2 : 1) / VEH[b.veh].mass;
      const sum = wa + wb; wa = wa * 2 / sum; wb = wb * 2 / sum;
      a.x -= dx * push * wa; a.z -= dz * push * wa;
      b.x += dx * push * wb; b.z += dz * push * wb;
      const rel = (b.vx - a.vx) * dx + (b.vz - a.vz) * dz;
      if (rel < 0) {
        const imp = -rel * 0.75;
        a.vx -= dx * imp * wa; a.vz -= dz * imp * wa; b.vx += dx * imp * wb; b.vz += dz * imp * wb;
        if (imp > 3 && (a.human >= 0 || b.human >= 0)) Snd.bump();
      }
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
    // komputer: gumka (doganianie / czekanie)
    const lead = Math.max(...g.humans.map(h => h.prog));
    for (const r of g.racers) {
      if (r.human >= 0 && !r.finished && !r.auto) continue;
      let m = r.ai.skill;
      if (r.human < 0) {
        const gap = r.prog - lead;
        if (gap > g.track.N * 0.25) m *= 0.92; else if (gap < -g.track.N * 0.2) m *= 1.07;
      }
      r.ai.mul = m;
    }
    for (const r of g.racers) stepRacer(r, dt);
    collideRacers();
    // miejsca
    const sorted = g.racers.slice().sort((a, b) => (a.finished && b.finished) ? a.finishT - b.finishT : a.finished ? -1 : b.finished ? 1 : b.prog - a.prog);
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
      const allDone = g.humans.every(h => h.finished);
      if (g.firstFinishT && g.state === 'race') g.state = 'finishing';
      if (allDone || (g.firstFinishT && g.t - g.firstFinishT > 30)) {
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
      const eye = [me.x - fx * 6.4 + sh, 3.1 + VEH[me.veh].seat[0] * 0.9 + me.y * 0.7 + sh, me.z - fz * 6.4];
      const ec = cellIdx(eye[0], eye[2]);
      if (ec >= 0) eye[1] = Math.max(eye[1], g.world.colH[ec] + 1.2);
      const tgt = [me.x + fx * 3, 1.3 + me.y * 0.8, me.z + fz * 3];
      const asp = v.w / v.h;
      let fovY = clamp(2 * Math.atan(Math.tan(40 * Math.PI / 180) / asp), 58 * Math.PI / 180, 82 * Math.PI / 180);
      const wantF = me.turboT > 0 ? 1.14 : 1;
      me.fov += (wantF - me.fov) * 0.08;
      fovY *= me.fov;
      const proj = M.persp(fovY, asp, 0.1, 220);
      const view = M.lookAt(eye, tgt, [0, 1, 0]);
      const vp = M.mul(proj, view);
      R.view(Math.round(v.x * dpr), Math.round((H - v.y - v.h) * dpr), Math.round(v.w * dpr), Math.round(v.h * dpr), vp, eye, fog, 45, 105);
      R.draw(g.sea);
      for (const c of g.chunks) {
        const dx = c.x - eye[0], dz = c.z - eye[2];
        const dd = Math.hypot(dx, dz);
        if (dd > 128) continue;
        if (dd > 24 && (dx * fx + dz * fz) / dd < -0.35) continue;
        R.draw(c.m);
      }
      R.draw(g.clouds, M.trans((g.t * 0.6) % 8, 0, 0));
      // zawodnicy
      for (const r of g.racers) {
        if (r.ghostT > 0 && Math.floor(r.ghostT * 10) % 2) continue;
        const base = M.mul(M.trans(r.x, r.y, r.z), M.rotY(r.h));
        const tint = r.shieldT > 0 ? TINT_SHIELD : null;
        const V = VEH[r.veh];
        R.draw(vehMeshFor(r.veh, r.ch), base, tint);
        const seat = M.mul(base, M.trans(0, V.seat[0], V.seat[1]));
        R.draw(meshes.body[r.ch], seat, tint);
        R.draw(meshes.head[r.ch], M.chain(seat, M.trans(NECK[0], NECK[1], NECK[2]), M.rotY(-r.steer * 0.4)), tint);
        const spinK = V.wheels[2][2] / V.wheels[0][2];
        for (const [wx, wz, wr, ww, front] of V.wheels) {
          let m = M.mul(base, M.trans(wx, wr, wz));
          if (front) m = M.mul(m, M.rotY(-r.steer * 0.45));
          R.draw(wheelMeshFor(wr, ww), M.mul(m, M.rotX(front ? r.wheel * spinK : r.wheel)), tint);
        }
      }
      // bonusy i TNT
      for (const b of g.world.boxes) {
        if (!b.active) continue;
        R.draw(meshes.bonus, M.chain(M.trans(b.x, 1.0 + Math.sin(g.t * 3 + b.x) * 0.15, b.z), M.rotY(g.t * 1.6 + b.z), M.rotX(0.6)));
      }
      for (const t of g.world.tnts) {
        if (!t.active) continue;
        const fl = t.armT > 0 && Math.floor(t.armT * 10) % 2;
        R.draw(meshes.tnt, M.trans(t.x, 0.5, t.z), fl ? TINT_TNT : null);
      }
      // cienie i cząsteczki (przezroczyste)
      const mb = new MeshBuilder();
      const right = [view[0], view[4], view[8]], up = [view[1], view[5], view[9]];
      for (const r of g.racers) {
        const gy = groundUnder(r) + 0.03, s = VEH[r.veh].rad * 1.4, l = VEH[r.veh].rad * 2.1;
        const c = Math.cos(r.h), sn = Math.sin(r.h);
        const P = (ax, az) => [r.x + ax * c + az * sn, gy, r.z - ax * sn + az * c];
        const a = clamp(0.5 - (r.y - gy) * 0.08, 0.15, 0.5);
        mb.quad([P(-s, l), P(s, l), P(s, -l), P(-s, -l)], T.glow, [0, 0, 0], a);
      }
      for (const p of g.parts) {
        const s = p.size / 2, fade = 1 - p.life / p.max;
        const q = (a, b) => [p.x + right[0] * a + up[0] * b, p.y + right[1] * a + up[1] * b, p.z + right[2] * a + up[2] * b];
        mb.quad([q(-s, s), q(s, s), q(s, -s), q(-s, -s)], p.tile, p.col, p.a * fade);
      }
      if (mb.n) {
        R.upload(mb, meshes.dyn);
        R.blend(true);
        R.draw(meshes.dyn);
        R.blend(false);
      }
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
  function buildMap2D(w) {
    const { W, D, H, vox, dist } = w;
    const P = clamp(Math.floor(2400 / Math.max(W, D)), 4, 10);
    const c = document.createElement('canvas');
    c.width = W * P; c.height = D * P;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    const top = new Int8Array(W * D);
    const plants = [];
    for (let z = 0; z < D; z++) for (let xx = 0; xx < W; xx++) {
      const ci = z * W + xx;
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
      const h = top[z * W + xx];
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
    const boxes = V.parts.map(p => ({ b: p, tile: p[6] === 'P' ? null : T[p[6]] }));
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
      if (tile === null) { x.fillStyle = C.kart; x.fillRect(px, pz, pw, ph); }
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
    const W = g.world.W, D = g.world.D;
    g.humans.forEach((me, vi) => {
      const v = viewports[vi];
      if (!v) return;
      if (me.spinT <= 0) me.camH += angDiff(me.h, me.camH) * 0.08;
      const speedK = clamp(Math.abs(me.fwd) / 24, 0, 1);
      const zoom = clamp(Math.min(v.w, v.h) / 27, 11, 24) * (1.08 - speedK * 0.22) * (me.turboT > 0 ? 0.92 : 1);
      ctx.save();
      ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h); ctx.clip();
      const sh = me.shake > 0 ? (Math.random() - 0.5) * me.shake * 8 : 0;
      ctx.translate(v.x + v.w / 2 + sh, v.y + v.h * (v.h > v.w ? 0.66 : 0.6) + sh);
      ctx.rotate(me.camH - Math.PI);
      ctx.scale(zoom, zoom);
      ctx.translate(-me.x, -me.z);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(g.map2d, 0, 0, g.map2d.width, g.map2d.height, 0, 0, W, D);
      // bonusy i TNT
      const [bx, by] = tileXY(T.bonus), [tx, ty] = tileXY(T.tnt_top);
      for (const b of g.world.boxes) {
        if (!b.active) continue;
        const s = 0.95 + Math.sin(g.t * 3 + b.x) * 0.1;
        ctx.save(); ctx.translate(b.x, b.z); ctx.rotate(g.t * 1.6 + b.z);
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-s / 2 + 0.15, -s / 2 + 0.15, s, s);
        ctx.drawImage(BG.atlas, bx, by, BG.TILE, BG.TILE, -s / 2, -s / 2, s, s);
        ctx.restore();
      }
      for (const t of g.world.tnts) {
        if (!t.active) continue;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(t.x - 0.35, t.z - 0.35, 1, 1);
        ctx.drawImage(BG.atlas, tx, ty, BG.TILE, BG.TILE, t.x - 0.5, t.z - 0.5, 1, 1);
        if (t.armT > 0 && Math.floor(t.armT * 10) % 2) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(t.x - 0.5, t.z - 0.5, 1, 1); }
      }
      // pojazdy (wyżej = później)
      const order = g.racers.slice().sort((a, b) => a.y - b.y);
      for (const r of order) {
        if (r.ghostT > 0 && Math.floor(r.ghostT * 10) % 2) continue;
        const sp = r.sprite, V = VEH[r.veh];
        const gy = groundUnder(r), lift = r.y - gy;
        ctx.save();
        ctx.translate(r.x + 0.3 + lift * 0.35, r.z + 0.3 + lift * 0.35);
        ctx.rotate(-r.h);
        ctx.fillStyle = 'rgba(0,0,0,' + clamp(0.35 - lift * 0.04, 0.12, 0.35) + ')';
        ctx.beginPath(); ctx.ellipse(0, 0, V.rad * 1.15, V.rad * 1.7, 0, 0, 7); ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.translate(r.x, r.z);
        ctx.rotate(-r.h);
        const k = 1 + lift * 0.1 + (r.y > 0.5 ? r.y * 0.05 : 0);
        ctx.scale(k, k);
        ctx.drawImage(sp.c, sp.x0, sp.z0, sp.w, sp.h);
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
        ctx.beginPath(); ctx.arc(p.x, p.z, p.size * (0.4 + p.y * 0.08), 0, 7); ctx.fill();
      }
      const m = ctx.getTransform();
      ctx.restore();
      drawHud(ctx, me, v, (x, y, z) => {
        const q = m.transformPoint(new DOMPoint(x, z));
        return [q.x / dpr, q.y / dpr - y * zoom * 0.25];
      });
    });
    if (viewports.length > 1) {
      ctx.fillStyle = '#111';
      const v = viewports[1];
      if (v.x > 0) ctx.fillRect(v.x - 2, 0, 4, innerHeight); else ctx.fillRect(0, v.y - 2, innerWidth, 4);
    }
  }

  function fmtTime(t) {
    if (!(t > 0)) return '–';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function makeMinimap(track, th) {
    const c = document.createElement('canvas'), S = 200;
    c.width = c.height = S;
    const x = c.getContext('2d');
    const sc = (S - 16) / Math.max(track.W - 50, track.D - 50);
    const ox = (S - (track.W - 50) * sc) / 2 - 25 * sc, oz = (S - (track.D - 50) * sc) / 2 - 25 * sc;
    const tp = (px, pz) => [ox + px * sc, oz + pz * sc];
    x.lineJoin = 'round';
    for (const [wd, col] of [[13, 'rgba(0,0,0,.55)'], [8, '#f0f0f0']]) {
      x.beginPath();
      for (let i = 0; i <= track.N; i++) { const [a, b] = tp(track.X[i % track.N], track.Z[i % track.N]); i ? x.lineTo(a, b) : x.moveTo(a, b); }
      x.closePath(); x.lineWidth = wd; x.strokeStyle = col; x.stroke();
    }
    const [sx, sz] = tp(track.X[0], track.Z[0]);
    x.fillStyle = '#d33'; x.fillRect(sx - 4, sz - 4, 8, 8);
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
    const lap = clamp(me.lap, 1, cfg.laps);
    txt('Okrążenie ' + lap + '/' + cfg.laps, v.x + pad, top + 46 * sc, 15 * sc);
    txt(fmtTime(me.finished ? me.finishT : Math.max(0, g.t)), v.x + pad, top + 66 * sc, 15 * sc, '#e8f4ff');
    txt(Math.round(Math.abs(me.fwd) * 4.2) + ' km/h', v.x + pad, top + 86 * sc, 13 * sc, '#cfe');
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
    const mm = g.minimap, ms = clamp(Math.min(v.w, v.h) * 0.3, 90, 180);
    const mx = v.x + v.w - ms - pad, my = v.y + pad;
    ctx.globalAlpha = 0.85; ctx.drawImage(mm.c, mx, my, ms, ms); ctx.globalAlpha = 1;
    const k = ms / mm.S;
    for (const r of g.racers.slice().sort((a, b) => (a === me) - (b === me))) {
      const [px, pz] = mm.tp(r.x, r.z);
      ctx.beginPath(); ctx.arc(mx + px * k, my + pz * k, (r === me ? 5.5 : r.human >= 0 ? 4.5 : 3.5) * sc, 0, 7);
      ctx.fillStyle = CHARS[r.ch].kart; ctx.fill();
      ctx.lineWidth = r.human >= 0 ? 2 : 1; ctx.strokeStyle = r === me ? '#fff' : '#000'; ctx.stroke();
    }
    // imiona nad innymi
    for (const r of g.racers) {
      if (r === me) continue;
      const d = Math.hypot(r.x - me.x, r.z - me.z);
      if (d > 38) continue;
      const sp = project(r.x, r.y + 2.7 + VEH[r.veh].seat[0], r.z);
      if (!sp) continue;
      const [sx, sy] = sp;
      const label = r.human >= 0 ? 'G' + (r.human + 1) + ' ' + CHARS[r.ch].name : CHARS[r.ch].name;
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
    if (g.firstFinishT && !me.finished && g.humans.length > 1) {
      const left = Math.ceil(30 - (g.t - g.firstFinishT));
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
    if (!paused && game.state !== 'done') {
      acc += dt;
      let steps = 0;
      while (acc >= STEP && steps < 6) { update(STEP); acc -= STEP; steps++; }
      if (steps === 6) acc = 0;
    }
    for (const r of game.humans) if (r.eng && Snd.ctx) {
      const on = !paused && game.state !== 'done';
      r.eng.o.frequency.setTargetAtTime(45 + Math.abs(r.fwd) * 5.5 + (r.turboT > 0 ? 40 : 0) + (r.ctrl.thr > 0 ? 8 : 0), Snd.ctx.currentTime, 0.05);
      r.eng.g.gain.setTargetAtTime(on ? (cfg.players > 1 ? 0.025 : 0.035) : 0, Snd.ctx.currentTime, 0.05);
    }
    if (game.mode === '2d') render2D(); else render3D();
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
    if (!p) { last = performance.now(); keys.clear(); }
  }
  function showResults() {
    const g = game;
    const order = g.racers.slice().sort((a, b) => a.place - b.place);
    const tb = $('resTable');
    tb.innerHTML = '';
    order.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (r.human >= 0) tr.className = 'me';
      const who = r.human >= 0 ? (g.humans.length > 1 ? 'Gracz ' + (r.human + 1) : 'Ty') : 'komputer';
      const cells = [(i + 1) + '.', '', CHARS[r.ch].name + ' <small>' + who + '</small>', r.finished ? fmtTime(r.finishT) : 'nie ukończył', fmtTime(r.bestLap)];
      cells.forEach((c, j) => {
        const td = document.createElement('td');
        if (j === 1) td.appendChild(portrait(r.ch, 28)); else td.innerHTML = c;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const best = order.find(r => r.human >= 0);
    const title = g.humans.length > 1
      ? (order[0].human >= 0 ? '🏆 Wygrywa Gracz ' + (order[0].human + 1) + '!' : 'Wygrywa ' + CHARS[order[0].ch].name + '!')
      : (best.place === 0 ? '🏆 Zwycięstwo!' : 'Meta – ' + (best.place + 1) + '. miejsce');
    $('resTitle').textContent = title;
    $('resInfo').textContent = 'Tor nr ' + cfg.seed + ' · ' + THEMES[g.world.theme].name + ' · ' + cfg.laps + ' okr.';
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
    const sc = (S - 30) / Math.max(tr.W - 68, tr.D - 68);
    const ox = (S - (tr.W - 68) * sc) / 2 - 34 * sc, oz = (S - (tr.D - 68) * sc) / 2 - 34 * sc;
    x.lineJoin = 'round';
    for (const [wd, col] of [[cfg.barriers ? 2 * WALL * sc + 2 : 0, cfg.barriers ? 'rgba(0,0,0,.25)' : 'transparent'], [2 * HW * sc + 3, '#d33'], [2 * HW * sc, th.mapRoad]]) {
      x.beginPath();
      for (let i = 0; i <= tr.N; i++) { const a = ox + tr.X[i % tr.N] * sc, b = oz + tr.Z[i % tr.N] * sc; i ? x.lineTo(a, b) : x.moveTo(a, b); }
      x.closePath(); x.lineWidth = wd; x.strokeStyle = col; x.stroke();
    }
    // linia startu i kierunek
    const sx = ox + tr.X[0] * sc, sz = oz + tr.Z[0] * sc;
    x.save(); x.translate(sx, sz); x.rotate(Math.atan2(tr.NZ[0], tr.NX[0]));
    for (let i = -3; i < 3; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * 3, j * 3 - 3, 3, 3); }
    x.restore();
    const ax = ox + tr.X[12] * sc, az = oz + tr.Z[12] * sc;
    x.save(); x.translate(ax, az); x.rotate(Math.atan2(tr.TZ[12], tr.TX[12]));
    x.fillStyle = '#fff'; x.beginPath(); x.moveTo(7, 0); x.lineTo(-5, -5); x.lineTo(-5, 5); x.closePath(); x.fill();
    x.restore();
    $('trackInfo').textContent = 'Tor nr ' + cfg.seed + ' · długość ' + tr.N + ' bloków' + (tr.shape < cfg.shape ? ' (uproszczony)' : '');
    $('seedInput').value = cfg.seed;
  }
  function refreshMenu() {
    seg('segPlayers', [[1, '👤 Jeden gracz'], [2, '👥 Dwóch graczy']], () => cfg.players, v => { cfg.players = v; if (v === 2 && cfg.chars[0] === cfg.chars[1]) cfg.chars[1] = (cfg.chars[0] + 1) % CHARS.length; });
    seg('segBots', [[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], () => cfg.bots, v => cfg.bots = v);
    seg('segDiff', [[0, 'łatwy'], [1, 'średni'], [2, 'trudny']], () => cfg.diff, v => cfg.diff = v);
    seg('segTheme', [['laka', '🌳 Łąka'], ['pustynia', '🌵 Pustynia'], ['zima', '❄️ Zima'], ['losowy', '🎲 Losowy']], () => cfg.theme, v => { cfg.theme = v; drawPreview(); });
    seg('segLaps', [[1, '1'], [2, '2'], [3, '3'], [5, '5']], () => cfg.laps, v => cfg.laps = v);
    seg('segShape', [[0, '〰️ Łagodny'], [1, '🌀 Kręty'], [2, '🐍 Bardzo kręty']], () => cfg.shape, v => { cfg.shape = v; drawPreview(); });
    seg('segBarriers', [[true, '🧱 Z bandami'], [false, '🌾 Bez band']], () => cfg.barriers, v => { cfg.barriers = v; drawPreview(); });
    seg('segView', [['3d', '🧊 3D zza pojazdu'], ['2d', '🗺️ 2D z góry']], () => cfg.view, v => cfg.view = v);
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
      $('btnStart').disabled = true; $('btnStart').textContent = 'Budowanie świata…';
      setTimeout(() => {
        try { startRace(); } finally { $('btnStart').disabled = false; $('btnStart').textContent = '🏁 Start!'; }
      }, 30);
    });
    $('btnPause').addEventListener('click', () => setPause(true));
    $('btnResume').addEventListener('click', () => setPause(false));
    $('btnRestart').addEventListener('click', () => startRace(true));
    $('btnQuit').addEventListener('click', () => { endGame(); showScreen('menu'); });
    $('btnSound2').addEventListener('click', () => { Snd.setOn(!Snd.on); setPause(true); });
    $('btnAgain').addEventListener('click', () => startRace(true));
    $('btnNew').addEventListener('click', () => { cfg.seed = 1 + Math.floor(Math.random() * 99999); drawPreview(); startRace(); });
    $('btnMenu').addEventListener('click', () => { endGame(); showScreen('menu'); });
    showScreen('menu');
    if (!document.createElement('canvas').getContext('webgl')) { $('noGL').classList.remove('hidden'); cfg.view = '2d'; refreshMenu(); }
  }
  init();

  // do testów w konsoli
  window.Wyscigi = { cfg, genTrack, genWorld, get game() { return game; }, sim(n) { for (let i = 0; i < n && game && game.state !== 'done'; i++) update(STEP); } };
})();
