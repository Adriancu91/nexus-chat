import { getRow } from '../db/database.ts';
import type { Ctx } from '../context.ts';

export interface ArchiveSettings {
  /** Mesajele (și fișierele lor) mai vechi de atâtea zile sunt șterse. null = păstrate pentru totdeauna. */
  retentionDays: number | null;
  backup: {
    enabled: boolean;
    intervalHours: number;
    /** Câte copii de siguranță se păstrează (cele mai vechi sunt șterse). */
    keep: number;
    /** Folderul copiilor de siguranță. null = folderul implicit, lângă arhivă. */
    dir: string | null;
  };
}

export const DEFAULT_ARCHIVE_SETTINGS: ArchiveSettings = {
  retentionDays: null,
  backup: { enabled: true, intervalHours: 24, keep: 7, dir: null },
};

export interface BackupStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastSuccessName: string | null;
  lastError: string | null;
}

const EMPTY_STATUS: BackupStatus = { lastAttemptAt: null, lastSuccessAt: null, lastSuccessName: null, lastError: null };

function read<T>(ctx: Ctx, key: string): T | undefined {
  const row = getRow<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : undefined;
}

function write(ctx: Ctx, key: string, value: unknown): void {
  ctx.db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .run(key, JSON.stringify(value), ctx.now());
}

export function getArchiveSettings(ctx: Ctx): ArchiveSettings {
  const stored = read<Partial<ArchiveSettings>>(ctx, 'archive') ?? {};
  return {
    retentionDays: stored.retentionDays ?? DEFAULT_ARCHIVE_SETTINGS.retentionDays,
    backup: { ...DEFAULT_ARCHIVE_SETTINGS.backup, ...stored.backup },
  };
}

export function setArchiveSettings(ctx: Ctx, settings: ArchiveSettings): void {
  write(ctx, 'archive', settings);
}

export function getBackupStatus(ctx: Ctx): BackupStatus {
  return { ...EMPTY_STATUS, ...read<Partial<BackupStatus>>(ctx, 'backupStatus') };
}

export function setBackupStatus(ctx: Ctx, status: BackupStatus): void {
  write(ctx, 'backupStatus', status);
}
