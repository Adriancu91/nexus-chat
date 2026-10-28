/**
 * Verifică din exterior configurarea de securitate a serverului publicat.
 *
 *   npm run check:external -- --backend https://laptop.tailnet.ts.net --origin https://cont.github.io
 *
 * Nu are nevoie de parole sau tokenuri: verifică doar ce vede oricine din internet.
 * Atenție: rulat de pe laptop, traficul poate ocoli Funnel (rețeaua Tailscale e locală);
 * testul decisiv este de pe telefon, pe date mobile.
 */
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const { values } = parseArgs({ options: { backend: { type: 'string' }, origin: { type: 'string' } } });
if (!values.backend || !values.origin) {
  console.error('Folosire: npm run check:external -- --backend https://… --origin https://…');
  process.exit(2);
}
const backend = values.backend.replace(/\/+$/, '');
const origin = new URL(values.origin).origin;
const EVIL = 'https://evil.example';

let failures = 0;
function report(ok: boolean, label: string, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '  OK ' : 'EȘEC'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function get(path: string, headers: Record<string, string> = {}, method = 'GET') {
  return fetch(backend + path, { method, headers, redirect: 'manual' });
}

function wsAttempt(o: string, token?: string): Promise<{ opened: boolean; closeCode?: number; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(backend.replace(/^http/, 'ws') + '/ws', { origin: o });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ opened: false });
    }, 10_000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ opened: false, status: res.statusCode });
    });
    ws.on('open', () => {
      if (token !== undefined) ws.send(JSON.stringify({ type: 'auth', token }));
      else {
        clearTimeout(timer);
        ws.close();
        resolve({ opened: true });
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ opened: true, closeCode: code });
    });
    ws.on('error', () => undefined);
  });
}

console.log(`Verific ${backend} pentru originea ${origin}\n`);

report(backend.startsWith('https://'), 'Adresa folosește HTTPS');
try {
  const health = await get('/api/health');
  const body = (await health.json()) as { name?: string };
  report(health.ok && body.name === 'nexus-chat', 'Serverul răspunde prin HTTPS cu certificat valid');
} catch (err) {
  report(false, 'Serverul răspunde prin HTTPS cu certificat valid', err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const good = await get('/api/health', { Origin: origin });
report(good.headers.get('access-control-allow-origin') === origin, 'CORS permite pagina aprobată');
const pre = await get('/api/rooms/join', { Origin: origin, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
report(pre.status === 204, 'Cererea preliminară CORS (OPTIONS) trece prin tunel');
const bad = await get('/api/health', { Origin: EVIL });
report(bad.status === 403 && !bad.headers.get('access-control-allow-origin'), 'CORS refuză o origine străină');

report((await get('/api/admin/rooms')).status === 401, 'API-ul de administrare cere autentificare');
report((await get('/api/admin/rooms', { Authorization: `Bearer ${'x'.repeat(43)}` })).status === 401, 'Un token inventat este refuzat');
report((await get('/api/nu-exista')).status === 404, 'Rutele necunoscute dau 404');
const headers = await get('/api/health');
report(headers.headers.get('x-content-type-options') === 'nosniff', 'Antete de securitate prezente');

const wsGood = await wsAttempt(origin);
report(wsGood.opened, 'WebSocket (WSS) funcționează prin tunel pentru pagina aprobată');
const wsAuth = await wsAttempt(origin, 'x'.repeat(43));
report(wsAuth.closeCode === 4401, 'WebSocket închide conexiunea fără sesiune validă', `cod ${wsAuth.closeCode}`);
const wsBad = await wsAttempt(EVIL);
report(!wsBad.opened && wsBad.status === 403, 'WebSocket refuză o origine străină', `status ${wsBad.status}`);

console.log(failures === 0 ? '\nToate verificările au trecut.' : `\n${failures} verificări au eșuat.`);
process.exit(failures === 0 ? 0 : 1);
