import { applyRetention } from './archive.ts';
import { createBackup } from './backup.ts';
import { getArchiveSettings, getBackupStatus } from './settings.ts';
import type { Ctx } from '../context.ts';

const CHECK_EVERY_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * Sarcini periodice: backup automat (dacă e activat și a trecut intervalul) și
 * aplicarea politicii de retenție. Verificarea rulează la pornire și apoi la 10 minute.
 */
export class Maintenance {
  private readonly ctx: Ctx;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const removed = await applyRetention(this.ctx);
      if (removed.messages > 0) console.log(`[retenție] ${removed.messages} mesaje și ${removed.files} fișiere vechi șterse.`);
      const { backup } = getArchiveSettings(this.ctx);
      const status = getBackupStatus(this.ctx);
      const due = !status.lastSuccessAt || this.ctx.now() - status.lastSuccessAt >= backup.intervalHours * HOUR_MS;
      // După un eșec se reîncearcă cel mult o dată pe oră.
      const recentFailure = status.lastAttemptAt !== null && status.lastAttemptAt !== status.lastSuccessAt && this.ctx.now() - status.lastAttemptAt < HOUR_MS;
      if (backup.enabled && due && !recentFailure) {
        const info = await createBackup(this.ctx, 'system');
        console.log(`[backup] copie de siguranță creată: ${info.name}`);
      }
    } catch (err) {
      console.error('[mentenanță]', err instanceof Error ? err.message : err);
    } finally {
      this.busy = false;
    }
  }
}
