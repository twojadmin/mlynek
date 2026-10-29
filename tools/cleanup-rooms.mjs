// Usuwa z bazy Firebase pokoje gry online bez ruchu od ponad ROOM_TTL_DAYS dni
// (domyślnie 7). Uruchamiane codziennie przez .github/workflows/sprzatanie-pokojow.yml.
//
// Zmienne środowiskowe:
//   FIREBASE_DB_URL           adres bazy, np. https://xxx-default-rtdb.europe-west1.firebasedatabase.app
//   FIREBASE_SERVICE_ACCOUNT  zawartość pliku JSON klucza konta usługi (sekret w GitHubie)
//   ROOM_TTL_DAYS             opcjonalnie: po ilu dniach usuwać pokój (domyślnie 7)
//   Do testów z emulatorem:   FIREBASE_EMULATOR_TOKEN=owner, FIREBASE_NS=<namespace>
//
// Bez zależności – wymaga Node.js 18+.
import crypto from 'node:crypto';

const DB = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const TTL_DAYS = Number(process.env.ROOM_TTL_DAYS || 7);
const NS = process.env.FIREBASE_NS;
const PAGE = 500;

function fail(msg) {
  console.error('BŁĄD: ' + msg);
  process.exit(1);
}

if (!/^https?:\/\//.test(DB)) fail('Brak poprawnego FIREBASE_DB_URL.');
if (!(TTL_DAYS >= 1)) fail('ROOM_TTL_DAYS musi być liczbą >= 1.');

// Token dostępu OAuth2 z klucza konta usługi (JWT podpisany RS256).
async function accessToken() {
  if (process.env.FIREBASE_EMULATOR_TOKEN) return process.env.FIREBASE_EMULATOR_TOKEN;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) fail('Brak sekretu FIREBASE_SERVICE_ACCOUNT – zobacz README, sekcja „Automatyczne sprzątanie pokojów”.');
  let sa;
  try { sa = JSON.parse(raw); } catch { fail('FIREBASE_SERVICE_ACCOUNT nie jest poprawnym JSON-em.'); }
  if (!sa.client_email || !sa.private_key) fail('W kluczu brakuje client_email lub private_key.');
  const aud = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud, iat: now, exp: now + 3600,
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + sig }),
  });
  if (!res.ok) fail('Nie udało się uzyskać tokenu: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return (await res.json()).access_token;
}

function url(path, params = {}) {
  const q = new URLSearchParams(params);
  if (NS) q.set('ns', NS);
  const qs = q.toString();
  return DB + path + (qs ? '?' + qs : '');
}

async function call(token, method, path, params, body) {
  const res = await fetch(url(path, params), {
    method,
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const token = await accessToken();
const cutoff = Date.now() - TTL_DAYS * 24 * 3600 * 1000;
let removed = 0;

// Pokoje bez pola „t” (resztki) sortują się na początku, więc też zostaną usunięte.
for (;;) {
  const rooms = await call(token, 'GET', '/rooms.json', { orderBy: '"t"', endAt: String(cutoff), limitToFirst: String(PAGE) });
  const keys = Object.keys(rooms || {}).filter(k => {
    const t = rooms[k] && rooms[k].t;
    return typeof t !== 'number' || t <= cutoff; // podwójne sprawdzenie
  });
  if (!keys.length) break;
  const patch = Object.fromEntries(keys.map(k => [k, null]));
  await call(token, 'PATCH', '/rooms.json', {}, patch);
  removed += keys.length;
  if (keys.length < PAGE) break;
}

console.log(`Usunięto pokojów nieaktywnych dłużej niż ${TTL_DAYS} dni: ${removed}.`);
