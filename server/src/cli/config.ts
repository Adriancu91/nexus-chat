/**
 * Editează fișierul de configurare de pe laptop (fără secrete).
 *
 *   npm run config                                    afișează configurarea
 *   npm run config -- --allow-origin https://x.github.io
 *   npm run config -- --remove-origin https://x.github.io
 *   npm run config -- --trust-proxy x-forwarded-for   (doar în spatele Tailscale Funnel)
 *   npm run config -- --no-trust-proxy
 *
 * Modificările au efect la următoarea pornire a serverului.
 */
import { parseArgs } from 'node:util';
import { configFilePath, loadConfig, normalizeOrigin, readConfigFile, writeConfigFile } from '../config.ts';

const { values } = parseArgs({
  options: {
    'allow-origin': { type: 'string', multiple: true },
    'remove-origin': { type: 'string', multiple: true },
    'trust-proxy': { type: 'string' },
    'no-trust-proxy': { type: 'boolean' },
    port: { type: 'string' },
    'port-mapping': { type: 'string' },
    'relay-domain': { type: 'string' },
    'no-relay': { type: 'boolean' },
  },
});

const file = configFilePath();
const current = readConfigFile(file);
const next = { ...current };
let changed = false;

for (const o of values['allow-origin'] ?? []) {
  const origin = normalizeOrigin(o);
  if (origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    throw new Error(`Originile din internet trebuie să fie https:// (${origin}).`);
  }
  next.allowedOrigins = [...new Set([...(next.allowedOrigins ?? []), origin])];
  changed = true;
}
for (const o of values['remove-origin'] ?? []) {
  const origin = normalizeOrigin(o);
  next.allowedOrigins = (next.allowedOrigins ?? []).filter((x) => x !== origin);
  changed = true;
}
if (values['trust-proxy']) {
  if (!/^[a-z0-9-]{1,64}$/i.test(values['trust-proxy'])) throw new Error('Nume de antet invalid.');
  next.trustProxyHeader = values['trust-proxy'].toLowerCase();
  changed = true;
}
if (values['no-trust-proxy']) {
  next.trustProxyHeader = null;
  changed = true;
}
if (values.port) {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port invalid (1024–65535).');
  next.port = port;
  changed = true;
}
if (values['port-mapping']) {
  const mode = values['port-mapping'];
  if (mode !== 'natpmp' && mode !== 'none') throw new Error('--port-mapping acceptă natpmp sau none.');
  next.calls = { ...next.calls, portMapping: mode };
  changed = true;
}
if (values['relay-domain']) {
  const domain = values['relay-domain'].toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(domain)) throw new Error('Domeniu invalid pentru releu.');
  next.calls = { ...next.calls, turn: { tlsPort: 8443, udpPort: null, ...next.calls?.turn, domain } };
  changed = true;
}
if (values['no-relay']) {
  next.calls = { ...next.calls, turn: { tlsPort: 8443, udpPort: null, ...next.calls?.turn, domain: null } };
  changed = true;
}

if (changed) {
  writeConfigFile(file, next);
  console.log(`Salvat în ${file}. Repornește serverul pentru a aplica.`);
}
const effective = loadConfig(process.env, {}, next);
console.log(`Fișier: ${file}`);
console.log(`Port: ${effective.port} (ascultă pe ${effective.host})`);
console.log(`Origini permise: ${effective.allowedOrigins.join(', ')}`);
console.log(`IP client din antet: ${effective.trustProxyHeader ?? 'nu (adresa conexiunii)'}`);
console.log(`Limită fișier: ${Math.round(effective.limits.maxFileBytes / 1048576)} MB`);
console.log(
  `Apeluri: ${effective.calls.livekitBinary ? `LiveKit ${effective.calls.livekitBinary}` : 'dezactivate (livekit-server lipsește)'}; ` +
    `porturi media UDP ${effective.calls.rtcUdpPort} / TCP ${effective.calls.rtcTcpPort}; deschidere automată în router: ${effective.calls.portMapping}; ` +
    `releu TURN: ${effective.calls.turn.domain ? `${effective.calls.turn.domain}:${effective.calls.turn.tlsPort} (TLS prin Tailscale Funnel)` : 'nu'}`,
);
