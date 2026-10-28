// Pornește backend-ul real pe o arhivă temporară, curată la fiecare rulare a testelor.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dataDir = fileURLToPath(new URL('../.e2e-data', import.meta.url));
rmSync(dataDir, { recursive: true, force: true });
process.argv.push('--data-dir', dataDir, '--port', process.env.E2E_BACKEND_PORT ?? '18788');
await import('../../server/src/main.ts');
