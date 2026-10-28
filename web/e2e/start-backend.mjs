// Pornește backend-ul real pe o arhivă temporară, curată la fiecare rulare a testelor.
// E2E_VARIANT=relay: al doilea backend, cu releul TURN activ (porturi LiveKit separate).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const variant = process.env.E2E_VARIANT ?? 'main';
// Backup-urile implicite ajung lângă arhivă, deci tot în .e2e-data.
const root = fileURLToPath(new URL(variant === 'main' ? '../.e2e-data' : `../.e2e-data-${variant}`, import.meta.url));
rmSync(root, { recursive: true, force: true });
const dataDir = root + '/data';

// Server media LiveKit (descărcat în .tools/livekit); fără el, testele de apel sunt sărite.
const livekit = fileURLToPath(new URL('../../.tools/livekit/' + (process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'), import.meta.url));
if (existsSync(livekit)) process.env.NEXUS_LIVEKIT_BIN = livekit;

if (variant === 'relay') {
  mkdirSync(root, { recursive: true });
  const config = root + '/config.json';
  // O adresă locală reală: motorul WebRTC al LiveKit ignoră candidații de loopback (127.0.0.1), iar
  // traficul spre propria adresă Tailscale (100.64.0.0/10) nu se întoarce la același calculator.
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address) && !i.address.startsWith('192.168.137.'))?.address;
  writeFileSync(
    config,
    JSON.stringify({ calls: { httpPort: 17880, rtcTcpPort: 17881, rtcUdpPort: 17882, nodeIp: lan ?? null, turn: { udpPort: 3479 } } }),
  );
  process.env.NEXUS_CONFIG = config;
}

process.argv.push('--data-dir', dataDir, '--port', process.env.E2E_BACKEND_PORT ?? '18788');
await import('../../server/src/main.ts');
