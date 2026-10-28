import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = 'server.lock';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockedBy(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** PID-ul serverului care folosește acum folderul de date, sau null. */
export function runningServerPid(dataDir: string): number | null {
  return lockedBy(dataDir);
}

/**
 * Un singur server poate folosi o arhivă: două procese care scriu în aceeași
 * bază de date și în același folder de fișiere ar putea strica arhiva.
 * Un fișier de blocare rămas după o oprire bruscă (proces inexistent) este ignorat.
 */
export function acquireServerLock(dataDir: string): () => void {
  const other = lockedBy(dataDir);
  if (other !== null) {
    throw new Error(`Serverul NEXUS CHAT rulează deja pentru această arhivă (proces ${other}). Oprește-l înainte.`);
  }
  const file = path.join(dataDir, LOCK_FILE);
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
    } catch {
      // deja șters
    }
  };
}
