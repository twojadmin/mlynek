// Buduje vendor/firebase-db.min.js: tylko Realtime Database, bez zapisu "heartbeat" w IndexedDB.
const esbuild = require('esbuild'); const fs = require('fs');
const noHeartbeat = { name: 'no-heartbeat', setup(b) {
  b.onLoad({ filter: /@firebase[\/\\]app[\/\\]dist[\/\\]esm[\/\\]index\.esm2017\.js$/ }, a => {
    let src = fs.readFileSync(a.path, 'utf8');
    const from = ".getProvider('heartbeat')\n        .getImmediate({ optional: true });";
    if (!src.includes(from)) throw new Error('heartbeat patch: pattern not found');
    src = src.replace(from, ".getProvider('heartbeat-disabled')\n        .getImmediate({ optional: true });");
    return { contents: src, loader: 'js' };
  });
}};
esbuild.build({ entryPoints: [require("path").join(__dirname, "entry.js")], bundle: true, minify: true, format: 'iife', target: 'es2019',
  legalComments: 'eof', outfile: process.argv[2], plugins: [noHeartbeat] }).then(() => console.log('ok'));
