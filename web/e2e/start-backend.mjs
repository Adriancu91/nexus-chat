// Pornește backend-ul real pe o arhivă temporară, curată la fiecare rulare a testelor.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Backup-urile implicite ajung lângă arhivă, deci tot în .e2e-data.
const root = fileURLToPath(new URL('../.e2e-data', import.meta.url));
rmSync(root, { recursive: true, force: true });
const dataDir = root + '/data';
process.argv.push('--data-dir', dataDir, '--port', process.env.E2E_BACKEND_PORT ?? '18788');
await import('../../server/src/main.ts');
