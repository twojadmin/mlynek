'use strict';
// Wyścigi klocków – renderer: tekstury rysowane w kodzie (piksele 16×16 jak w Minetest),
// budowanie siatek z bloków i prosty WebGL (mgła, cieniowanie ścian, przezroczystość).
(function () {
  const TILE = 16, PER_ROW = 16, ATLAS = TILE * PER_ROW;

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;

  // ---------- atlas tekstur ----------
  const atlas = document.createElement('canvas');
  atlas.width = atlas.height = ATLAS;
  const actx = atlas.getContext('2d');
  const img = actx.createImageData(ATLAS, ATLAS);
  const T = {};
  let tileCount = 0;

  // Każda tekstura to funkcja (x, y, rnd) -> [r,g,b,a]
  function tile(name, fn, seed) {
    const id = tileCount++;
    T[name] = id;
    const ox = (id % PER_ROW) * TILE, oy = Math.floor(id / PER_ROW) * TILE;
    const rnd = rng(seed || (id * 7919 + 13));
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const c = fn(x, y, rnd);
      const o = ((oy + y) * ATLAS + ox + x) * 4;
      img.data[o] = clamp255(c[0]); img.data[o + 1] = clamp255(c[1]); img.data[o + 2] = clamp255(c[2]);
      img.data[o + 3] = c[3] === undefined ? 255 : c[3];
    }
    return id;
  }
  function jit(c, a, rnd) { const d = (rnd() - 0.5) * 2 * a; return [c[0] + d, c[1] + d, c[2] + d]; }
  function noisy(base, a, specks) {
    const b = hex(base), sp = (specks || []).map(s => [hex(s[0]), s[1]]);
    return (x, y, rnd) => {
      for (const [c, p] of sp) if (rnd() < p) return jit(c, 8, rnd);
      return jit(b, a, rnd);
    };
  }
  // Obrazek 8×8 skalowany ×2 (twarze postaci, ikony)
  function pix8(rows, pal, rndAmt) {
    return (x, y, rnd) => {
      const ch = rows[y >> 1][x >> 1];
      const c = pal[ch];
      if (!c) return [0, 0, 0, 0];
      return jit(hex(c), rndAmt === undefined ? 6 : rndAmt, rnd);
    };
  }

  const grass = noisy('#5da83a', 16, [['#4a9030', 0.18], ['#78c048', 0.08]]);
  const dirt = noisy('#8a5d3b', 12, [['#6b4528', 0.15], ['#a2714a', 0.08]]);
  tile('grass', grass);
  tile('grass_side', (x, y, rnd) => (y < 3 || (y === 3 && rnd() < 0.5)) ? grass(x, y, rnd) : dirt(x, y, rnd));
  tile('dirt', dirt);
  tile('stone', noisy('#8b8b8b', 12, [['#6f6f6f', 0.16], ['#a3a3a3', 0.06]]));
  tile('cobble', (x, y, rnd) => {
    const row = Math.floor(y / 5), off = (row % 2) * 3;
    const mortar = y % 5 === 4 || (x + off) % 7 === 6;
    return mortar ? jit([78, 78, 78], 8, rnd) : jit([128 + row * 6, 128 + row * 6, 128 + row * 6], 16, rnd);
  });
  tile('asphalt', noisy('#4c4c52', 9, [['#66666c', 0.08], ['#3a3a3e', 0.1]]));
  tile('sand', noisy('#e2d394', 10, [['#d2bf78', 0.15], ['#f0e4b0', 0.06]]));
  tile('sandstone', (x, y, rnd) => jit(y % 4 === 3 ? [190, 150, 95] : [216, 184, 122], 8, rnd));
  tile('road_desert', noisy('#a8743e', 9, [['#8f6232', 0.12], ['#bb8650', 0.06]]));
  tile('snow', noisy('#f2f7fb', 5, [['#dfe9f2', 0.15]]));
  tile('snow_side', (x, y, rnd) => (y < 4 || (y === 4 && rnd() < 0.5)) ? jit([242, 247, 251], 5, rnd) : dirt(x, y, rnd));
  tile('ice', (x, y, rnd) => jit((x + y * 2) % 11 === 0 ? [215, 238, 255] : [160, 205, 240], 6, rnd));
  tile('log', (x, y, rnd) => jit(x % 4 === 0 ? [80, 55, 30] : [110, 78, 44], 10, rnd));
  tile('log_top', (x, y) => {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    return d > 6.5 ? [90, 62, 34] : (Math.floor(d) % 2 ? [176, 136, 82] : [150, 112, 62]);
  });
  tile('leaves', (x, y, rnd) => rnd() < 0.13 ? [0, 0, 0, 0] : jit(rnd() < 0.3 ? [44, 112, 32] : [58, 140, 42], 14, rnd));
  tile('pine', (x, y, rnd) => rnd() < 0.1 ? [0, 0, 0, 0] : jit(rnd() < 0.3 ? [28, 70, 44] : [40, 92, 58], 10, rnd));
  tile('cactus', (x, y, rnd) => {
    if ((x === 3 || x === 12) && y % 5 === 2) return [240, 230, 160];
    return jit(x % 5 === 0 ? [50, 110, 40] : [72, 140, 56], 8, rnd);
  });
  tile('cactus_top', noisy('#6aa850', 8, [['#4c8a3a', 0.2]]));
  tile('water', (x, y, rnd) => jit(((x + y * 3) % 9 === 0) ? [90, 140, 240] : [52, 98, 210], 8, rnd));
  tile('curb_red', noisy('#c83232', 10));
  tile('curb_white', noisy('#eeeeee', 6));
  tile('finish', (x, y, rnd) => jit(((x >> 2) + (y >> 2)) % 2 ? [30, 30, 30] : [240, 240, 240], 5, rnd));
  tile('mud', noisy('#5a3b20', 10, [['#3f2914', 0.2], ['#7a5a3c', 0.08]]));
  tile('oil', (x, y, rnd) => rnd() < 0.06 ? jit([90, 60, 140], 20, rnd) : (rnd() < 0.05 ? [70, 110, 130] : jit([22, 22, 28], 6, rnd)));
  tile('slime', (x, y, rnd) => {
    const edge = x === 0 || y === 0 || x === 15 || y === 15;
    const spot = (x - 7.5) * (x - 7.5) + (y - 7.5) * (y - 7.5) < 12;
    return jit(edge ? [60, 150, 40] : spot ? [170, 250, 120] : [110, 215, 70], 8, rnd);
  });
  tile('hay', (x, y, rnd) => jit(y % 4 === 1 ? [180, 140, 40] : [222, 182, 70], 10, rnd));
  tile('hay_top', (x, y, rnd) => jit((x + y) % 5 === 0 ? [180, 140, 40] : [222, 182, 70], 10, rnd));
  const letters = { T: ['111', '010', '010', '010', '010'], N: ['101', '111', '111', '111', '101'] };
  tile('tnt', (x, y, rnd) => {
    if (y >= 5 && y <= 10) {
      // napis TNT w białym pasie
      const lx = x - 2, ly = y - 5;
      if (ly < 5 && lx >= 0 && lx < 12) {
        const li = Math.floor(lx / 4), cx = lx % 4;
        const L = letters['TNT'[li]];
        if (cx < 3 && L[ly][cx] === '1') return [20, 20, 20];
      }
      return jit([235, 235, 235], 6, rnd);
    }
    return jit(x % 4 === 0 ? [160, 30, 25] : [210, 50, 40], 8, rnd);
  });
  tile('tnt_top', (x, y, rnd) => (x >= 6 && x <= 9 && y >= 6 && y <= 9) ? [60, 60, 60] : jit([200, 50, 40], 8, rnd));
  tile('bonus', pix8([
    'OOOOOOOO',
    'OYYWWYYO',
    'OYWYYWYO',
    'OYYYYWYO',
    'OYYYWYYO',
    'OYYYYYYO',
    'OYYYWYYO',
    'OOOOOOOO'], { O: '#e07a10', Y: '#ffd23a', W: '#ffffff' }, 8));
  tile('flower_r', (x, y, rnd) => {
    if (y > 6 && x === 7) return [50, 130, 40];
    if (y >= 2 && y <= 6 && x >= 5 && x <= 9) return (x === 7 && y === 4) ? [250, 220, 60] : jit([220, 40, 40], 10, rnd);
    if (y === 10 && (x === 6 || x === 8)) return [60, 150, 45];
    return [0, 0, 0, 0];
  });
  tile('flower_y', (x, y, rnd) => {
    if (y > 6 && x === 8) return [50, 130, 40];
    if (y >= 3 && y <= 6 && x >= 6 && x <= 10) return jit([250, 220, 50], 10, rnd);
    return [0, 0, 0, 0];
  });
  tile('tallgrass', (x, y, rnd) => {
    const h = [9, 5, 11, 3, 8, 6, 2, 10, 4, 7, 12, 5, 9, 3, 8, 11][x];
    return (y > h && x % 2 === (y % 3 === 0 ? 1 : 0) || y > h + 2) ? jit([70, 150, 50], 18, rnd) : [0, 0, 0, 0];
  });
  tile('deadbush', (x, y) => {
    const on = (x === 7 && y > 6) || (y === 9 && x >= 4 && x <= 7) || (y === 6 && x >= 7 && x <= 11) ||
      (x === 4 && y >= 5 && y <= 9) || (x === 11 && y >= 3 && y <= 6) || (y === 11 && x >= 7 && x <= 10) || (x === 10 && y >= 8 && y <= 11);
    return on ? [120, 82, 40] : [0, 0, 0, 0];
  });
  tile('planks', (x, y, rnd) => jit(y % 4 === 3 ? [130, 92, 50] : ((x + (y >> 2) * 5) % 8 === 0 ? [140, 100, 56] : [184, 137, 79]), 8, rnd));
  tile('paint', (x, y, rnd) => (x === 0 || y === 0 || x === 15 || y === 15) ? jit([175, 175, 175], 4, rnd) : jit([240, 240, 240], 5, rnd));
  tile('tire', (x, y, rnd) => jit(y % 4 === 0 ? [55, 55, 55] : [30, 30, 30], 4, rnd));
  tile('wheel', (x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    return d < 2.5 ? [200, 200, 205] : d < 4.5 ? [120, 120, 128] : [30, 30, 30];
  });
  tile('seat', noisy('#303034', 6));
  tile('metal', noisy('#b4b4bc', 6));
  tile('glow', (x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5) / 7.5;
    return [255, 255, 255, d >= 1 ? 0 : Math.round(255 * (1 - d) * (1 - d))];
  });
  tile('puff', (x, y) => {
    const d = Math.hypot(x - 7.5, y - 7.5) / 7.5;
    return [255, 255, 255, d >= 1 ? 0 : Math.round(230 * Math.min(1, (1 - d) * 2.2))];
  });
  tile('white', () => [255, 255, 255]);

  // ---------- postacie (styl Minetest: głowa 8×8, tułów, ręce, nogi) ----------
  const CHARS = [
    { name: 'Bartek', skin: '#e0ac7e', hair: '#5a3a1a', eyes: '#2f63c4', shirt: '#2f9ad8', pants: '#2a3b8f', kart: '#d83a2a', style: 'short' },
    { name: 'Ola', skin: '#f1c7a1', hair: '#e8b830', eyes: '#2f8f5b', shirt: '#e0508f', pants: '#6a44a8', kart: '#ff8fc8', style: 'long' },
    { name: 'Robot', skin: '#a9b1b9', hair: '#7a828a', eyes: '#ff3030', shirt: '#5c6670', pants: '#3e444a', kart: '#b8c4d0', style: 'robot' },
    { name: 'Wiking', skin: '#e8b890', hair: '#c45e1e', eyes: '#3a5fa0', shirt: '#7a5230', pants: '#4a3a2a', kart: '#f0a020', style: 'beard' },
    { name: 'Ninja', skin: '#d8a070', hair: '#1c1c20', eyes: '#3a2a1a', shirt: '#24282e', pants: '#24282e', kart: '#303840', style: 'ninja' },
    { name: 'Kosmita', skin: '#7ccf5a', hair: '#5aa83e', eyes: '#101010', shirt: '#8a3ac8', pants: '#4a2a7a', kart: '#40e0d0', style: 'alien' },
    { name: 'Zosia', skin: '#8d5a3a', hair: '#1e1410', eyes: '#3a2414', shirt: '#f2c230', pants: '#2a7a4a', kart: '#30b050', style: 'buns' },
    { name: 'Górnik', skin: '#e3b088', hair: '#3a2a1a', eyes: '#305080', shirt: '#d86a20', pants: '#3a4a6a', kart: '#a07040', style: 'miner' }
  ];
  const FACES = {
    short: ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSNNSSS', 'SSSMMSSS', 'SSSSSSSS'],
    long: ['HHHHHHHH', 'HHHHHHHH', 'HHSSSSHH', 'HSSSSSSH', 'HWESSEWH', 'HSSNNSSH', 'HSSMMSSH', 'HSSSSSSH'],
    robot: ['HHHHHHHH', 'HSSSSSSH', 'SKKKKKKS', 'SKEKKEKS', 'SKKKKKKS', 'SSSSSSSS', 'SMMMMMMS', 'SSSSSSSS'],
    beard: ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSNNSSS', 'HHHMMHHH', 'HHHHHHHH'],
    ninja: ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'SSSSSSSS', 'SWESSEWS', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH'],
    alien: ['SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SEESSEES', 'SEESSEES', 'SSSSSSSS', 'SSSMMSSS', 'SSSSSSSS'],
    buns: ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSNNSSS', 'SSSMMSSS', 'SSSSSSSS'],
    miner: ['YYYLLYYY', 'YYYYYYYY', 'HSSSSSSH', 'SSSSSSSS', 'SWESSEWS', 'SSSNNSSS', 'SSSMMSSS', 'SSSSSSSS']
  };
  function shade(h, k) { const c = hex(h); return '#' + c.map(v => clamp255(v * k).toString(16).padStart(2, '0')).join(''); }
  CHARS.forEach((c, i) => {
    const pal = { H: c.hair, S: c.skin, W: '#ffffff', E: c.eyes, N: shade(c.skin, 0.85), M: shade(c.skin, 0.62), K: '#30343a', Y: '#f0c020', L: '#fff6a0' };
    if (c.style === 'robot') { pal.M = '#40464c'; pal.N = c.skin; }
    if (c.style === 'alien') { pal.N = c.skin; }
    c.tiles = {};
    c.tiles.face = tile('c' + i + 'face', pix8(FACES[c.style], pal));
    const sideRows = c.style === 'long' ? ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH']
      : c.style === 'miner' ? ['YYYYYYYY', 'YYYYYYYY', 'HHHHHSSS', 'HHHHSSSS', 'HHHSSSSS', 'HHSSSSSS', 'HSSSSSSS', 'SSSSSSSS']
        : c.style === 'ninja' ? ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHSSSS', 'HHHHHSSS', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH']
          : c.style === 'alien' || c.style === 'robot' ? ['HSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS']
            : c.style === 'beard' ? ['HHHHHHHH', 'HHHHHHHH', 'HHHHHSSS', 'HHHHSSSS', 'HHHHSSSS', 'HHHHSSSS', 'HHHHHHHH', 'HHHHHHHH']
              : ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHSS', 'HHHHHSSS', 'HHHHSSSS', 'HHHSSSSS', 'HHSSSSSS', 'SSSSSSSS'];
    c.tiles.side = tile('c' + i + 'side', pix8(sideRows, pal));
    const back = c.style === 'robot' || c.style === 'alien' ? ['SSSSSSSS', 'SSSSSSSS', 'SKKKKKKS', 'SKKKKKKS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS', 'SSSSSSSS']
      : c.style === 'miner' ? ['YYYYYYYY', 'YYYYYYYY', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH']
        : c.style === 'buns' ? ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'SSSSSSSS']
          : ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', c.style === 'long' ? 'HHHHHHHH' : 'SSSSSSSS'];
    c.tiles.back = tile('c' + i + 'back', pix8(back, pal));
    c.tiles.top = tile('c' + i + 'top', pix8(c.style === 'miner' ? ['YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY', 'YYYYYYYY']
      : c.style === 'robot' ? ['SSSSSSSS', 'SSSSSSSS', 'SSSKKSSS', 'SSKEEKSS', 'SSKEEKSS', 'SSSKKSSS', 'SSSSSSSS', 'SSSSSSSS']
        : ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH', 'HHHHHHHH'], pal));
    const sh = hex(c.shirt), pn = hex(c.pants);
    c.tiles.shirt = tile('c' + i + 'shirt', (x, y, rnd) => {
      if (c.style === 'ninja' && y >= 12 && y <= 13) return [180, 30, 30];
      if (c.style === 'miner' && (y === 6 || y === 7)) return [240, 240, 120];
      if (c.style === 'robot' && x >= 5 && x <= 10 && y >= 3 && y <= 7) return (x + y) % 2 ? [80, 220, 120] : [40, 50, 60];
      if (c.style === 'buns' && x >= 6 && x <= 9 && y >= 4 && y <= 7) return [255, 255, 255];
      return jit(y < 2 ? sh.map(v => v * 0.85) : sh, 8, rnd);
    });
    c.tiles.pants = tile('c' + i + 'pants', (x, y, rnd) => jit(y >= 13 ? [50, 40, 34] : pn, 7, rnd));
    c.tiles.skin = tile('c' + i + 'skin', noisy(c.skin, 6));
  });
  // Ikony bonusów (do kostek i interfejsu)
  actx.putImageData(img, 0, 0);

  // ---------- definicje bloków ----------
  // draw: 'cube' | 'cross' (rośliny) | 'liquid'
  const B = {};
  const BLOCKS = [null];
  function block(name, def) {
    def.id = BLOCKS.length; def.name = name;
    const top = def.top || def.all, side = def.side || def.all, bottom = def.bottom || def.all || top;
    def.top = T[top]; def.side = T[side]; def.bottom = T[bottom];
    def.draw = def.draw || 'cube';
    BLOCKS.push(def); B[name] = def.id;
  }
  block('grass', { top: 'grass', side: 'grass_side', bottom: 'dirt' });
  block('dirt', { all: 'dirt' });
  block('stone', { all: 'stone' });
  block('cobble', { all: 'cobble' });
  block('asphalt', { all: 'asphalt' });
  block('sand', { all: 'sand' });
  block('sandstone', { all: 'sandstone' });
  block('road_desert', { all: 'road_desert' });
  block('snow', { top: 'snow', side: 'snow_side', bottom: 'dirt' });
  block('snowblock', { all: 'snow' });
  block('ice', { all: 'ice' });
  block('log', { top: 'log_top', side: 'log', bottom: 'log_top' });
  block('leaves', { all: 'leaves', transparent: true });
  block('pine', { all: 'pine', transparent: true });
  block('cactus', { top: 'cactus_top', side: 'cactus', bottom: 'cactus_top' });
  block('water', { all: 'water', draw: 'liquid', transparent: true });
  block('curb_red', { all: 'curb_red' });
  block('curb_white', { all: 'curb_white' });
  block('finish', { all: 'finish' });
  block('mud', { all: 'mud' });
  block('oil', { all: 'oil' });
  block('slime', { all: 'slime' });
  block('hay', { top: 'hay_top', side: 'hay', bottom: 'hay_top' });
  block('planks', { all: 'planks' });
  block('flower_r', { all: 'flower_r', draw: 'cross', transparent: true });
  block('flower_y', { all: 'flower_y', draw: 'cross', transparent: true });
  block('tallgrass', { all: 'tallgrass', draw: 'cross', transparent: true });
  block('deadbush', { all: 'deadbush', draw: 'cross', transparent: true });

  // ---------- budowanie siatek ----------
  const EPS = 0.02 / ATLAS;
  function uvOf(t) {
    const u = (t % PER_ROW) * TILE / ATLAS, v = Math.floor(t / PER_ROW) * TILE / ATLAS, s = TILE / ATLAS;
    return [u + EPS, v + EPS, u + s - EPS, v + s - EPS];
  }
  const SHADE = { top: 1, bottom: 0.55, x: 0.8, z: 0.66 };

  class MeshBuilder {
    constructor() { this.v = []; this.i = []; this.n = 0; }
    // c: 4 rogi [x,y,z] od lewego górnego, zgodnie z ruchem wskazówek zegara (patrząc na ścianę)
    quad(c, t, col, a) {
      const mir = t < 0; // ujemny numer = tekstura odbita w poziomie
      const [u0, v0, u1, v1] = uvOf(mir ? -t - 1 : t);
      const uv = mir ? [u1, v0, u0, v0, u0, v1, u1, v1] : [u0, v0, u1, v0, u1, v1, u0, v1];
      const al = a === undefined ? 1 : a;
      for (let k = 0; k < 4; k++) this.v.push(c[k][0], c[k][1], c[k][2], uv[k * 2], uv[k * 2 + 1], col[0], col[1], col[2], al);
      const n = this.n;
      this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
      this.n += 4;
    }
    // tiles: liczba albo {top,bottom,px,nx,pz,nz}; faces: które ściany rysować (domyślnie wszystkie)
    box(x0, y0, z0, x1, y1, z1, tiles, col, faces) {
      const t = typeof tiles === 'number' ? { top: tiles, bottom: tiles, px: tiles, nx: tiles, pz: tiles, nz: tiles } : tiles;
      const c = col || [1, 1, 1];
      const f = faces || 63;
      const m = k => [c[0] * k, c[1] * k, c[2] * k];
      if (f & 1) this.quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], t.top, m(SHADE.top));
      if (f & 2) this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], t.bottom, m(SHADE.bottom));
      if (f & 4) this.quad([[x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0]], t.px, m(SHADE.x));
      if (f & 8) this.quad([[x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [x0, y0, z1]], t.nx, m(SHADE.x));
      if (f & 16) this.quad([[x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [x1, y0, z1]], t.pz, m(SHADE.z));
      if (f & 32) this.quad([[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], t.nz, m(SHADE.z));
    }
    cross(x, y, z, t, col) {
      const a = 0.15, b = 0.85, c = col || [1, 1, 1];
      this.quad([[x + a, y + 1, z + a], [x + b, y + 1, z + b], [x + b, y, z + b], [x + a, y, z + a]], t, c);
      this.quad([[x + a, y + 1, z + b], [x + b, y + 1, z + a], [x + b, y, z + a], [x + a, y, z + b]], t, c);
    }
  }

  // Świat: world.W, world.D, world.H, world.Y0 (indeks y odpowiadający wysokości 0), world.vox (Uint8Array)
  function buildWorldChunks(world, CH) {
    const { W, D, H, vox } = world;
    const Y0 = world.Y0;
    const get = (x, y, z) => (x < 0 || z < 0 || x >= W || z >= D) ? 255 : (y < 0 || y >= H) ? 0 : vox[(y * D + z) * W + x];
    const chunks = [];
    for (let cz = 0; cz < D; cz += CH) for (let cx = 0; cx < W; cx += CH) {
      const mb = new MeshBuilder();
      for (let z = cz; z < Math.min(D, cz + CH); z++) for (let x = cx; x < Math.min(W, cx + CH); x++) {
        for (let y = 0; y < H; y++) {
          const id = vox[(y * D + z) * W + x];
          if (!id) continue;
          const def = BLOCKS[id];
          const wy = y - Y0;
          if (def.draw === 'cross') { mb.cross(x, wy, z, def.top); continue; }
          if (def.draw === 'liquid') {
            if (get(x, y + 1, z) !== id) mb.quad([[x, wy + 0.85, z], [x + 1, wy + 0.85, z], [x + 1, wy + 0.85, z + 1], [x, wy + 0.85, z + 1]], def.top, [0.95, 0.95, 1]);
            continue;
          }
          let faces = 0;
          const vis = n => {
            if (n === 255) return false;
            if (n === 0) return true;
            const nd = BLOCKS[n];
            return nd.transparent && n !== id;
          };
          if (vis(get(x, y + 1, z))) faces |= 1;
          if (y > 0 && vis(get(x, y - 1, z))) faces |= 2;
          if (vis(get(x + 1, y, z))) faces |= 4;
          if (vis(get(x - 1, y, z))) faces |= 8;
          if (vis(get(x, y, z + 1))) faces |= 16;
          if (vis(get(x, y, z - 1))) faces |= 32;
          if (!faces) continue;
          mb.box(x, wy, z, x + 1, wy + 1, z + 1, { top: def.top, bottom: def.bottom, px: def.side, nx: def.side, pz: def.side, nz: def.side }, null, faces);
        }
      }
      if (mb.n) chunks.push({ mb, cx: cx + CH / 2, cz: cz + CH / 2 });
    }
    return chunks;
  }

  // ---------- macierze (kolumnowe, jak w WebGL) ----------
  const M = {
    ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
    mul(a, b) {
      const o = new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    persp(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
      m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f);
      return m;
    },
    lookAt(e, c, up) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
      let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      const m = new Float32Array(16);
      m[0] = xx; m[4] = xy; m[8] = xz; m[12] = -(xx * e[0] + xy * e[1] + xz * e[2]);
      m[1] = yx; m[5] = yy; m[9] = yz; m[13] = -(yx * e[0] + yy * e[1] + yz * e[2]);
      m[2] = zx; m[6] = zy; m[10] = zz; m[14] = -(zx * e[0] + zy * e[1] + zz * e[2]);
      m[15] = 1;
      return m;
    },
    trans(x, y, z) { const m = M.ident(); m[12] = x; m[13] = y; m[14] = z; return m; },
    rotY(a) { const m = M.ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
    rotX(a) { const m = M.ident(), c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
    rotZ(a) { const m = M.ident(), c = Math.cos(a), s = Math.sin(a); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
    scale(s) { const m = M.ident(); m[0] = m[5] = m[10] = s; return m; },
    chain(...ms) { return ms.reduce((a, b) => M.mul(a, b)); }
  };

  // ---------- WebGL ----------
  const VS = `
attribute vec3 aPos; attribute vec2 aUV; attribute vec4 aCol;
uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uCam;
varying vec2 vUV; varying vec4 vCol; varying float vDist;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  gl_Position = uVP * w;
  vUV = aUV; vCol = aCol; vDist = distance(w.xyz, uCam);
}`;
  const FS = `
precision mediump float;
uniform sampler2D uTex; uniform vec3 uFog; uniform vec2 uFogR; uniform vec4 uTint; uniform float uCut;
varying vec2 vUV; varying vec4 vCol; varying float vDist;
void main() {
  vec4 t = texture2D(uTex, vUV);
  float a = t.a * vCol.a * uTint.a;
  if (t.a < uCut || a < 0.01) discard;
  vec3 c = t.rgb * vCol.rgb * uTint.rgb;
  float f = clamp((vDist - uFogR.x) / (uFogR.y - uFogR.x), 0.0, 1.0);
  gl_FragColor = vec4(mix(c, uFog, f), uCut > 0.4 ? 1.0 : a);
}`;

  function createRenderer(canvas) {
    const opts = { antialias: false, alpha: false, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) return null;
    const uintExt = gl.getExtension('OES_element_index_uint');
    function sh(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const A = { pos: gl.getAttribLocation(prog, 'aPos'), uv: gl.getAttribLocation(prog, 'aUV'), col: gl.getAttribLocation(prog, 'aCol') };
    const U = {};
    ['uVP', 'uModel', 'uCam', 'uTex', 'uFog', 'uFogR', 'uTint', 'uCut'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
    gl.enableVertexAttribArray(A.pos); gl.enableVertexAttribArray(A.uv); gl.enableVertexAttribArray(A.col);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U.uTex, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const ID = M.ident();
    const STRIDE = 9 * 4;

    function upload(mb, mesh) {
      const m = mesh || { vb: gl.createBuffer(), ib: gl.createBuffer() };
      const big = mb.n > 65535;
      if (big && !uintExt) { mb.v.length = mb.i.length = 0; mb.n = 0; }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mb.v), mesh ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? new Uint32Array(mb.i) : new Uint16Array(mb.i), mesh ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      m.count = mb.i.length; m.type = big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      return m;
    }
    function free(m) { if (m) { gl.deleteBuffer(m.vb); gl.deleteBuffer(m.ib); } }
    let curModel = null, curTint = null;
    function draw(m, model, tint) {
      if (!m || !m.count) return;
      const mm = model || ID;
      if (mm !== curModel) { gl.uniformMatrix4fv(U.uModel, false, mm); curModel = mm; }
      const t = tint || WHITE;
      if (t !== curTint) { gl.uniform4fv(U.uTint, t); curTint = t; }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
      gl.vertexAttribPointer(A.pos, 3, gl.FLOAT, false, STRIDE, 0);
      gl.vertexAttribPointer(A.uv, 2, gl.FLOAT, false, STRIDE, 12);
      gl.vertexAttribPointer(A.col, 4, gl.FLOAT, false, STRIDE, 20);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      gl.drawElements(gl.TRIANGLES, m.count, m.type, 0);
    }
    const WHITE = new Float32Array([1, 1, 1, 1]);
    return {
      gl, upload, free, draw,
      view(x, y, w, h, vp, cam, fog, fogNear, fogFar) {
        gl.viewport(x, y, w, h);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, w, h);
        gl.clearColor(fog[0], fog[1], fog[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.uniformMatrix4fv(U.uVP, false, vp);
        gl.uniform3fv(U.uCam, cam);
        gl.uniform3fv(U.uFog, fog);
        gl.uniform2f(U.uFogR, fogNear, fogFar);
        gl.uniform1f(U.uCut, 0.5);
        gl.disable(gl.BLEND); gl.depthMask(true);
        curModel = null; curTint = null;
      },
      blend(on) {
        if (on) { gl.enable(gl.BLEND); gl.depthMask(false); gl.uniform1f(U.uCut, 0.0); }
        else { gl.disable(gl.BLEND); gl.depthMask(true); gl.uniform1f(U.uCut, 0.5); }
      }
    };
  }

  window.BlockGL = { T, B, BLOCKS, CHARS, atlas, TILE, PER_ROW, uvOf, MeshBuilder, buildWorldChunks, M, createRenderer, rng, hex };
})();
