import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, schemaVersion } from '../db/database.ts';
import { HttpError } from '../errors.ts';
import { audit } from './audit.ts';
import { FILES_DIR, freeDiskBytes, hashFile, storedFilePath } from './files.ts';
import { runningServerPid } from './lock.ts';
import { getArchiveSettings, getBackupStatus, setBackupStatus } from './settings.ts';
import type { Ctx } from '../context.ts';

/**
 * Structura folderului de backup:
 *
 *   <backups>/store/<aa>/<id>          conținutul fișierelor, copiat o singură dată
 *   <backups>/snapshots/<nume>/        o copie completă a bazei de date + manifest
 *       nexus.db
 *       manifest.json                  amprente SHA-256 pentru baza de date și pentru fiecare fișier
 *
 * Fișierele din arhivă nu se modifică niciodată după upload, deci un fișier deja copiat
 * în `store` este refolosit de copiile următoare (backup incremental).
 * Un instantaneu apare în `snapshots` doar după ce a fost scris și verificat complet.
 */
export const BACKUP_FORMAT = 'nexus-backup/v1';
const NAME_RE = /^nexus-\d{8}-\d{6}-\d{3}$/;

export interface ManifestFile {
  id: string;
  storageKey: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  name: string;
  createdAt: number;
  schemaVersion: number;
  db: { size: number; sha256: string };
  files: ManifestFile[];
}

export interface BackupInfo {
  name: string;
  createdAt: number;
  dbSize: number;
  fileCount: number;
  fileBytes: number;
}

export function defaultBackupRoot(dataDir: string): string {
  return path.join(path.dirname(dataDir), 'backups');
}

export function backupRoot(ctx: Ctx): string {
  return getArchiveSettings(ctx).backup.dir ?? defaultBackupRoot(ctx.config.dataDir);
}

export function isValidBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

function backupName(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `nexus-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

const storePath = (root: string, key: string) => path.join(root, 'store', ...key.split('/'));
const snapshotsDir = (root: string) => path.join(root, 'snapshots');

async function fsyncFile(file: string): Promise<void> {
  const fh = await fs.promises.open(file, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Copiază un fișier verificând amprenta SHA-256 a ce s-a scris. Scrierea e atomică (tmp + redenumire). */
async function copyVerified(src: string, dest: string, sha256: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await fs.promises.copyFile(src, tmp);
  await fsyncFile(tmp);
  if ((await hashFile(tmp)) !== sha256) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(`Amprenta SHA-256 nu corespunde pentru ${path.basename(src)} (fișier corupt în sursă).`);
  }
  await fs.promises.rename(tmp, dest);
}

let running: Promise<BackupInfo> | null = null;

/** Creează o copie de siguranță completă și verificată. Poate rula cu serverul pornit. */
export function createBackup(ctx: Ctx, actor: string): Promise<BackupInfo> {
  if (running) throw new HttpError(409, 'backup_running', 'Un backup este deja în curs.');
  running = runBackup(ctx, actor).finally(() => {
    running = null;
  });
  return running;
}

async function runBackup(ctx: Ctx, actor: string): Promise<BackupInfo> {
  const root = backupRoot(ctx);
  const startedAt = ctx.now();
  const name = backupName(startedAt);
  const tmpDir = path.join(snapshotsDir(root), `.tmp-${name}`);
  const status = getBackupStatus(ctx);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const dbCopy = path.join(tmpDir, 'nexus.db');
    // VACUUM INTO produce o copie consistentă a bazei de date, chiar în timp ce serverul scrie.
    ctx.db.prepare('VACUUM INTO ?').run(dbCopy);

    const snap = new DatabaseSync(dbCopy, { readOnly: true });
    let files: ManifestFile[];
    let version: number;
    try {
      version = schemaVersion(snap);
      files = (snap.prepare('SELECT id, storage_key, size, sha256 FROM files').all() as {
        id: string;
        storage_key: string;
        size: number;
        sha256: string;
      }[]).map((f) => ({ id: f.id, storageKey: f.storage_key, size: f.size, sha256: f.sha256 }));
    } finally {
      snap.close();
    }

    const dbSize = (await fs.promises.stat(dbCopy)).size;
    let needed = dbSize;
    for (const f of files) if (!fs.existsSync(storePath(root, f.storageKey))) needed += f.size;
    const free = await freeDiskBytes(root);
    if (free !== null && free < needed + 64 * 1024 * 1024) {
      throw new Error(`Spațiu insuficient în folderul de backup (necesar ~${Math.ceil(needed / 1048576)} MB).`);
    }

    for (const f of files) {
      const dest = storePath(root, f.storageKey);
      const existing = await fs.promises.stat(dest).catch(() => null);
      if (existing?.size === f.size) continue;
      await copyVerified(storedFilePath(ctx.config, f.storageKey), dest, f.sha256);
    }

    await fsyncFile(dbCopy);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      name,
      createdAt: startedAt,
      schemaVersion: version,
      db: { size: dbSize, sha256: await hashFile(dbCopy) },
      files,
    };
    const manifestPath = path.join(tmpDir, 'manifest.json');
    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fsyncFile(manifestPath);
    // Instantaneul devine vizibil doar acum, complet.
    await fs.promises.rename(tmpDir, path.join(snapshotsDir(root), name));

    await pruneBackups(root, getArchiveSettings(ctx).backup.keep);
    const info = toInfo(manifest);
    setBackupStatus(ctx, { ...status, lastAttemptAt: startedAt, lastSuccessAt: startedAt, lastSuccessName: name, lastError: null });
    audit(ctx, actor, 'backup.created', name, { files: info.fileCount, bytes: info.fileBytes + info.dbSize });
    return info;
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    setBackupStatus(ctx, { ...status, lastAttemptAt: startedAt, lastError: message });
    audit(ctx, actor, 'backup.failed', name, { error: message });
    throw err instanceof HttpError ? err : new HttpError(500, 'backup_failed', `Backup-ul a eșuat: ${message}`);
  }
}

const toInfo = (m: BackupManifest): BackupInfo => ({
  name: m.name,
  createdAt: m.createdAt,
  dbSize: m.db.size,
  fileCount: m.files.length,
  fileBytes: m.files.reduce((s, f) => s + f.size, 0),
});

async function readManifest(root: string, name: string): Promise<BackupManifest> {
  if (!isValidBackupName(name)) throw new HttpError(404, 'not_found', 'Backup inexistent.');
  const raw = await fs.promises.readFile(path.join(snapshotsDir(root), name, 'manifest.json'), 'utf8').catch(() => null);
  if (raw === null) throw new HttpError(404, 'not_found', 'Backup inexistent.');
  const m = JSON.parse(raw) as BackupManifest;
  if (m.format !== BACKUP_FORMAT) throw new HttpError(422, 'unknown_format', 'Format de backup necunoscut.');
  return m;
}

export async function listBackups(root: string): Promise<BackupInfo[]> {
  const names = (await fs.promises.readdir(snapshotsDir(root)).catch(() => [] as string[])).filter(isValidBackupName);
  const out: BackupInfo[] = [];
  for (const name of names) {
    try {
      out.push(toInfo(await readManifest(root, name)));
    } catch {
      // instantaneu ilizibil: e raportat de verificare, nu blochează lista
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Păstrează doar ultimele `keep` copii și șterge din `store` fișierele nefolosite de ele. */
export async function pruneBackups(root: string, keep: number): Promise<void> {
  const all = await listBackups(root);
  for (const old of all.slice(keep)) {
    await fs.promises.rm(path.join(snapshotsDir(root), old.name), { recursive: true, force: true });
  }
  const referenced = new Set<string>();
  for (const b of all.slice(0, keep)) for (const f of (await readManifest(root, b.name)).files) referenced.add(f.storageKey);
  const store = path.join(root, 'store');
  for (const prefix of await fs.promises.readdir(store).catch(() => [] as string[])) {
    for (const file of await fs.promises.readdir(path.join(store, prefix)).catch(() => [] as string[])) {
      if (!referenced.has(`${prefix}/${file}`)) await fs.promises.rm(path.join(store, prefix, file), { force: true });
    }
  }
}

export interface BackupVerification {
  name: string;
  ok: boolean;
  problems: string[];
}

/** Recalculează amprentele SHA-256 ale bazei de date și ale fiecărui fișier din backup. */
export async function verifyBackup(root: string, name: string): Promise<BackupVerification> {
  const m = await readManifest(root, name);
  const problems: string[] = [];
  const dbFile = path.join(snapshotsDir(root), name, 'nexus.db');
  const dbHash = await hashFile(dbFile).catch(() => null);
  if (dbHash !== m.db.sha256) problems.push(dbHash === null ? 'Baza de date lipsește.' : 'Baza de date este coruptă.');
  for (const f of m.files) {
    const file = storePath(root, f.storageKey);
    const hash = await hashFile(file).catch(() => null);
    if (hash === null) problems.push(`Fișier lipsă: ${f.id}`);
    else if (hash !== f.sha256) problems.push(`Fișier corupt: ${f.id}`);
  }
  return { name, ok: problems.length === 0, problems };
}

/**
 * Restaurează un backup într-un folder de date. Serverul trebuie să fie oprit.
 * Arhiva existentă NU este ștearsă: este redenumită, ca să poată fi recuperată.
 */
export async function restoreBackup(opts: { root: string; name: string; dataDir: string; now?: number }): Promise<{ movedAside: string | null }> {
  const pid = runningServerPid(opts.dataDir);
  if (pid !== null) throw new Error(`Serverul rulează (proces ${pid}). Oprește-l înainte de restaurare.`);
  const check = await verifyBackup(opts.root, opts.name);
  if (!check.ok) throw new Error(`Backup-ul ${opts.name} nu trece verificarea:\n- ${check.problems.join('\n- ')}`);
  const m = await readManifest(opts.root, opts.name);

  const staging = `${opts.dataDir}.restaurare-in-curs`;
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(staging, FILES_DIR), { recursive: true });
  await copyVerified(path.join(snapshotsDir(opts.root), opts.name, 'nexus.db'), path.join(staging, 'nexus.db'), m.db.sha256);
  for (const f of m.files) {
    await copyVerified(storePath(opts.root, f.storageKey), path.join(staging, FILES_DIR, ...f.storageKey.split('/')), f.sha256);
  }
  // Deschiderea aplică migrațiile, dacă backup-ul provine dintr-o versiune mai veche.
  openDatabase(path.join(staging, 'nexus.db')).close();

  let movedAside: string | null = null;
  if (fs.existsSync(opts.dataDir)) {
    const stamp = backupName(opts.now ?? Date.now()).replace('nexus-', '');
    movedAside = `${opts.dataDir}.inainte-de-restaurare-${stamp}`;
    await fs.promises.rename(opts.dataDir, movedAside);
  }
  await fs.promises.rename(staging, opts.dataDir);
  return { movedAside };
}

