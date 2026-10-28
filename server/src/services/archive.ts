import fs from 'node:fs';
import { allRows, getRow, transaction } from '../db/database.ts';
import { audit } from './audit.ts';
import { hashFile, removeStoredFiles, storedFilePath } from './files.ts';
import { getArchiveSettings } from './settings.ts';
import type { Ctx } from '../context.ts';

const DAY_MS = 24 * 60 * 60_000;

export interface RetentionImpact {
  messages: number;
  files: number;
  fileBytes: number;
}

export function retentionPreview(ctx: Ctx, days: number): RetentionImpact {
  const cutoff = ctx.now() - days * DAY_MS;
  const m = getRow<{ n: number }>(ctx.db, 'SELECT COUNT(*) AS n FROM messages WHERE created_at < ?', cutoff)!;
  const f = getRow<{ n: number; bytes: number | null }>(
    ctx.db,
    'SELECT COUNT(*) AS n, SUM(f.size) AS bytes FROM messages m JOIN files f ON f.id = m.file_id WHERE m.created_at < ?',
    cutoff,
  )!;
  return { messages: m.n, files: f.n, fileBytes: f.bytes ?? 0 };
}

/**
 * Aplică politica de retenție: șterge mesajele mai vechi decât limita și fișierele lor.
 * Rândurile dispar într-o tranzacție; fișierele de pe disc sunt șterse după confirmare.
 */
export async function applyRetention(ctx: Ctx, actor = 'system'): Promise<RetentionImpact> {
  const { retentionDays } = getArchiveSettings(ctx);
  if (retentionDays === null) return { messages: 0, files: 0, fileBytes: 0 };
  const cutoff = ctx.now() - retentionDays * DAY_MS;
  const { impact, keys } = transaction(ctx.db, () => {
    const impact = retentionPreview(ctx, retentionDays);
    const keys = allRows<{ storage_key: string }>(
      ctx.db,
      'SELECT f.storage_key FROM messages m JOIN files f ON f.id = m.file_id WHERE m.created_at < ?',
      cutoff,
    ).map((r) => r.storage_key);
    ctx.db.prepare('DELETE FROM files WHERE id IN (SELECT file_id FROM messages WHERE created_at < ? AND file_id IS NOT NULL)').run(cutoff);
    ctx.db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
    if (impact.messages > 0) audit(ctx, actor, 'archive.retention_applied', undefined, { retentionDays, ...impact });
    return { impact, keys };
  });
  await removeStoredFiles(ctx.config, keys);
  return impact;
}

export interface IntegrityReport {
  database: { ok: boolean; details: string[] };
  files: { checked: number; missing: string[]; corrupted: string[] };
  ok: boolean;
}

/** Verifică baza de date (PRAGMA integrity_check, chei străine) și amprenta SHA-256 a fiecărui fișier. */
export async function verifyArchive(ctx: Ctx): Promise<IntegrityReport> {
  const integrity = allRows<{ integrity_check: string }>(ctx.db, 'PRAGMA integrity_check').map((r) => r.integrity_check);
  const fk = allRows<Record<string, unknown>>(ctx.db, 'PRAGMA foreign_key_check');
  const dbOk = integrity.length === 1 && integrity[0] === 'ok' && fk.length === 0;
  const details = dbOk ? [] : [...integrity.filter((x) => x !== 'ok'), ...(fk.length ? [`${fk.length} referințe invalide`] : [])];

  const missing: string[] = [];
  const corrupted: string[] = [];
  const files = allRows<{ id: string; storage_key: string; size: number; sha256: string; original_name: string }>(
    ctx.db,
    'SELECT id, storage_key, size, sha256, original_name FROM files',
  );
  for (const f of files) {
    const file = storedFilePath(ctx.config, f.storage_key);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) {
      missing.push(f.original_name);
      continue;
    }
    if (stat.size !== f.size || (await hashFile(file)) !== f.sha256) corrupted.push(f.original_name);
  }
  const ok = dbOk && missing.length === 0 && corrupted.length === 0;
  audit(ctx, 'system', 'archive.verified', undefined, { ok, files: files.length, missing: missing.length, corrupted: corrupted.length });
  return { database: { ok: dbOk, details }, files: { checked: files.length, missing, corrupted }, ok };
}
