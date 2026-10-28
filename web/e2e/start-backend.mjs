// Pornește backend-ul real pe o arhivă temporară, curată la fiecare rulare a testelor.
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Backup-urile implicite ajung lângă arhivă, deci tot în .e2e-data.
const root = fileURLToPath(new URL('../.e2e-data', import.meta.url));
rmSync(root, { recursive: true, force: true });
const dataDir = root + '/data';
// Server media LiveKit (descărcat în .tools/livekit); fără el, testele de apel sunt sărite.
const livekit = fileURLToPath(new URL('../../.tools/livekit/' + (process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server'), import.meta.url));
if (existsSync(livekit)) process.env.NEXUS_LIVEKIT_BIN = livekit;
process.argv.push('--data-dir', dataDir, '--port', process.env.E2E_BACKEND_PORT ?? '18788');
await import('../../server/src/main.ts');
