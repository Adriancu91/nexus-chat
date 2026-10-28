/**
 * Backup și restaurare din linia de comandă (pe laptopul gazdă).
 *
 *   npm run backup                         creează un backup acum (serverul trebuie să fie oprit;
 *                                          cu serverul pornit folosește butonul din Administrare)
 *   npm run backup -- --list               listează backup-urile
 *   npm run backup -- --verify <nume>      verifică amprentele unui backup
 *   npm run restore -- <nume>              restaurează (serverul trebuie să fie oprit)
 *
 * Opțiuni: --data-dir <folder arhivă>   --backup-dir <folder backup-uri>
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openDataDir } from '../app.ts';
import { loadConfig } from '../config.ts';
import { backupRoot, createBackup, defaultBackupRoot, listBackups, restoreBackup, verifyBackup } from '../services/backup.ts';
import { runningServerPid } from '../services/lock.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'data-dir': { type: 'string' },
    'backup-dir': { type: 'string' },
    list: { type: 'boolean' },
    verify: { type: 'string' },
    restore: { type: 'boolean' },
  },
});

const env = { ...process.env };
if (values['data-dir']) env.NEXUS_DATA_DIR = values['data-dir'];
const config = loadConfig(env);

/** Folderul de backup: opțiunea explicită, apoi setarea din arhivă, apoi cel implicit. */
function resolveRoot(): string {
  if (values['backup-dir']) return values['backup-dir'];
  if (!fs.existsSync(path.join(config.dataDir, 'nexus.db'))) return defaultBackupRoot(config.dataDir);
  try {
    const db = openDataDir(config);
    try {
      return backupRoot({ db, config, now: Date.now });
    } finally {
      db.close();
    }
  } catch {
    // Arhiva curentă poate fi chiar cea deteriorată pe care vrem s-o înlocuim.
    return defaultBackupRoot(config.dataDir);
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function main(): Promise<number> {
  if (values.restore) {
    const name = positionals[0];
    if (!name) {
      console.error('Specifică numele backup-ului. Vezi lista cu: npm run backup -- --list');
      return 2;
    }
    const root = resolveRoot();
    console.log(`Restaurez ${name} din ${root} în ${config.dataDir} ...`);
    const { movedAside } = await restoreBackup({ root, name, dataDir: config.dataDir });
    console.log('Restaurare reușită. Toate amprentele SHA-256 au fost verificate.');
    if (movedAside) console.log(`Arhiva anterioară a fost păstrată în: ${movedAside}`);
    console.log('Poți porni serverul.');
    return 0;
  }
  const root = resolveRoot();
  if (values.list) {
    const list = await listBackups(root);
    if (list.length === 0) console.log(`Nu există backup-uri în ${root}.`);
    for (const b of list) {
      console.log(`${b.name}  ${new Date(b.createdAt).toLocaleString('ro-RO')}  baza ${mb(b.dbSize)}, ${b.fileCount} fișiere (${mb(b.fileBytes)})`);
    }
    return 0;
  }
  if (values.verify) {
    const r = await verifyBackup(root, values.verify);
    console.log(r.ok ? `${r.name}: în regulă.` : `${r.name}: PROBLEME\n- ${r.problems.join('\n- ')}`);
    return r.ok ? 0 : 1;
  }
  const pid = runningServerPid(config.dataDir);
  if (pid !== null) {
    console.error(`Serverul rulează (proces ${pid}). Folosește Administrare → Stare și arhivă → „Fă backup acum”.`);
    return 1;
  }
  const db = openDataDir(config);
  try {
    const info = await createBackup({ db, config, now: Date.now }, 'local-cli');
    console.log(`Backup creat: ${info.name} în ${root} (${info.fileCount} fișiere).`);
  } finally {
    db.close();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
