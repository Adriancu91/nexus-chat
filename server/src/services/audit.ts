import { allRows } from '../db/database.ts';
import type { Ctx } from '../context.ts';

export interface AuditEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** Jurnal al operațiunilor administrative. Nu primește niciodată parole, tokenuri sau conținutul mesajelor. */
export function audit(ctx: Ctx, actor: string, action: string, target?: string, detail?: Record<string, unknown>): void {
  ctx.db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.now(), actor, action, target ?? null, detail ? JSON.stringify(detail) : null);
}

export function listAudit(ctx: Ctx, limit: number, beforeId?: number): AuditEntry[] {
  return beforeId
    ? allRows<AuditEntry>(ctx.db, 'SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?', beforeId, limit)
    : allRows<AuditEntry>(ctx.db, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', limit);
}
