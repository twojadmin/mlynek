// Buduje paczki Firebase do katalogu vendor/:
//   node build.js entry.js       ../../vendor/firebase-db.min.js     (gra: tylko baza)
//   node build.js entry-admin.js ../../vendor/firebase-admin.min.js  (panel admina: baza + logowanie)
// Wyłącza usługę „heartbeat” Firebase, która zapisuje statystyki w IndexedDB przeglądarki.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const [entry, out] = process.argv.slice(2);
if (!entry || !out) { console.error('Użycie: node build.js <entry.js> <plik-wyjściowy>'); process.exit(1); }

const patches = [
  { file: /@firebase[\/\\]app[\/\\]dist[\/\\]esm[\/\\]index\.esm2017\.js$/,
    from: ".getProvider('heartbeat')\n        .getImmediate({ optional: true });",
    to: ".getProvider('heartbeat-disabled')\n        .getImmediate({ optional: true });" },
  { file: /@firebase[\/\\]auth[\/\\]dist[\/\\]esm2017[\/\\]index-[^\/\\]+\.js$/,
    from: "container.getProvider('heartbeat')",
    to: "container.getProvider('heartbeat-disabled')" },
];

const noHeartbeat = { name: 'no-heartbeat', setup(b) {
  for (const p of patches) {
    b.onLoad({ filter: p.file }, a => {
      const src = fs.readFileSync(a.path, 'utf8');
      if (!src.includes(p.from)) throw new Error('heartbeat patch: pattern not found in ' + a.path);
      return { contents: src.split(p.from).join(p.to), loader: 'js' };
    });
  }
}};

esbuild.build({
  entryPoints: [path.join(__dirname, entry)], bundle: true, minify: true, format: 'iife', target: 'es2019',
  legalComments: 'eof', outfile: out, plugins: [noHeartbeat],
}).then(() => console.log('ok: ' + out));
