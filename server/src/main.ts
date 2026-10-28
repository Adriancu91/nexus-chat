import { parseArgs } from 'node:util';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { ensureBootstrapCode } from './services/admin.ts';

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

const config = loadConfig(env);
const app = createApp(config);
const addr = await app.listen();

console.log(`NEXUS CHAT server pornit pe http://${addr.address}:${addr.port}`);
console.log(`Arhiva locală: ${config.dataDir}`);
console.log(`Origini permise: ${config.allowedOrigins.join(', ')}`);

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
  await app.close();
  console.log('Server oprit.');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
