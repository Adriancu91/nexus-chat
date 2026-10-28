import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import { configFilePath, loadConfig, readConfigFile } from './config.ts';
import { ensureBootstrapCode } from './services/admin.ts';
import { sweepStorage } from './services/files.ts';
import { acquireServerLock } from './services/lock.ts';
import { Maintenance } from './services/maintenance.ts';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
  },
});

const env = { ...process.env };
if (values['data-dir']) env.NEXUS_DATA_DIR = values['data-dir'];
if (values.port) env.NEXUS_PORT = values.port;
if (values.host) env.NEXUS_HOST = values.host;

const configFile = configFilePath(env);
const config = loadConfig(env, {}, readConfigFile(configFile));
fs.mkdirSync(config.dataDir, { recursive: true });
let releaseLock: () => void;
try {
  releaseLock = acquireServerLock(config.dataDir);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const app = createApp(config);
const swept = await sweepStorage(app.ctx);
if (swept.tmpRemoved + swept.orphansRemoved > 0) {
  console.log(`Curățenie la pornire: ${swept.tmpRemoved} transferuri neterminate, ${swept.orphansRemoved} fișiere fără înregistrare.`);
}
const addr = await app.listen();
if (config.calls.livekitBinary) {
  const ready = await app.startCalls();
  console.log(
    ready
      ? `Apeluri: server media LiveKit pornit (semnalizare 127.0.0.1:${config.calls.httpPort}, media UDP ${config.calls.rtcUdpPort} / TCP ${config.calls.rtcTcpPort}).`
      : 'Apeluri: LiveKit nu a pornit; vezi jurnalul logs\\livekit.log. Chatul funcționează normal.',
  );
  const net = app.callsNetwork();
  if (net.portMapping === 'natpmp') {
    console.log(
      net.active
        ? `Apeluri din internet: porturile media sunt deschise în router (IP public ${net.externalIp}).`
        : `Apeluri din internet: INDISPONIBILE (${net.error}).`,
    );
  }
} else {
  console.log('Apeluri: dezactivate (livekit-server nu este instalat).');
}
const maintenance = new Maintenance(app.ctx);
maintenance.start();

console.log(`NEXUS CHAT server pornit pe http://${addr.address}:${addr.port}`);
console.log(`Arhiva locală: ${config.dataDir}`);
console.log(`Origini permise: ${config.allowedOrigins.join(', ')}`);
console.log(`Configurare: ${configFile}${config.trustProxyHeader ? ` (IP client din antetul ${config.trustProxyHeader})` : ''}`);

const bootstrap = ensureBootstrapCode(app.ctx);
if (bootstrap) {
  const until = new Date(bootstrap.expiresAt).toLocaleTimeString('ro-RO');
  console.log('');
  console.log('==============================================================');
  console.log(' Nu există încă niciun dispozitiv de administrator.');
  console.log(' Cod de inițializare (unică folosință, valabil până la ' + until + '):');
  console.log('');
  console.log('     ' + bootstrap.code);
  console.log('');
  console.log(' Introdu-l în pagina „Administrator” de pe acest laptop.');
  console.log(' Nu trimite acest cod nimănui.');
  console.log('==============================================================');
}

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} primit — opresc serverul și închid arhiva în siguranță...`);
  maintenance.stop();
  await app.close();
  releaseLock();
  console.log('Server oprit.');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
