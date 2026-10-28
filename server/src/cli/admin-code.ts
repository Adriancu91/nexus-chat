/**
 * Emite un cod de înrolare de administrator direct din arhiva locală.
 * Este calea de recuperare când nu mai ai niciun dispozitiv autorizat: necesită
 * acces la fișierele de pe laptop, deci nu poate fi folosită de la distanță.
 *
 *   npm run admin:code               (folderul de date implicit)
 *   npm run admin:code -- --data-dir C:\cale\catre\date
 */
import { parseArgs } from 'node:util';
import { openDataDir } from '../app.ts';
import { loadConfig } from '../config.ts';
import { issueEnrollmentCode } from '../services/admin.ts';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const env = { ...process.env };
if (values['data-dir']) env.NEXUS_DATA_DIR = values['data-dir'];
const config = loadConfig(env);
const db = openDataDir(config);
try {
  const { code, expiresAt } = issueEnrollmentCode({ db, config, now: Date.now }, 'enroll', 'local-cli');
  console.log(`Cod de înrolare administrator: ${code}`);
  console.log(`Valabil până la ${new Date(expiresAt).toLocaleTimeString('ro-RO')}. Unică folosință.`);
} finally {
  db.close();
}
