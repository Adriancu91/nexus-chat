import { randomUUID } from 'node:crypto';
import { getRow } from '../db/database.ts';
import { hashToken, newToken } from '../crypto/tokens.ts';
import type { Ctx } from '../context.ts';

export const ADMIN_DISPLAY_NAME = 'Administrator';
/** Identificator de expeditor stabil pentru administrator, indiferent de dispozitiv. */
export const ADMIN_SENDER_ID = 'admin';

export type Principal =
  | { kind: 'admin'; sessionId: string; tokenHash: string; deviceId: string; displayName: string }
  | {
      kind: 'participant';
      sessionId: string;
      tokenHash: string;
      participantId: string;
      roomId: string;
      displayName: string;
    };

export type SessionTarget = { kind: 'admin'; deviceId: string } | { kind: 'participant'; participantId: string; roomId: string };

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: number;
}

export function createSession(ctx: Ctx, target: SessionTarget): IssuedSession {
  const token = newToken();
  const sessionId = randomUUID();
  const now = ctx.now();
  const ttl = target.kind === 'admin' ? ctx.config.adminSessionTtlMs : ctx.config.participantSessionTtlMs;
  const expiresAt = now + ttl;
  ctx.db
    .prepare(
      `INSERT INTO sessions (id, token_hash, kind, admin_device_id, participant_id, room_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      hashToken(token),
      target.kind,
      target.kind === 'admin' ? target.deviceId : null,
      target.kind === 'participant' ? target.participantId : null,
      target.kind === 'participant' ? target.roomId : null,
      now,
      expiresAt,
    );
  return { token, sessionId, expiresAt };
}

export function authenticateToken(ctx: Ctx, token: unknown): Principal | null {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  return authenticateHash(ctx, hashToken(token));
}

interface SessionRow {
  id: string;
  kind: 'admin' | 'participant';
  admin_device_id: string | null;
  participant_id: string | null;
  room_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  device_revoked: number | null;
  participant_revoked: number | null;
  display_name: string | null;
  room_closed: number | null;
}

/**
 * Verifică sesiunea la fiecare utilizare: expirare, revocare, dispozitiv revocat,
 * participant revocat și cameră închisă invalidează imediat accesul.
 */
export function authenticateHash(ctx: Ctx, tokenHash: string): Principal | null {
  const row = getRow<SessionRow>(
    ctx.db,
    `SELECT s.id, s.kind, s.admin_device_id, s.participant_id, s.room_id, s.expires_at, s.revoked_at,
            d.revoked_at AS device_revoked, p.revoked_at AS participant_revoked, p.display_name,
            r.closed_at AS room_closed
       FROM sessions s
       LEFT JOIN admin_devices d ON d.id = s.admin_device_id
       LEFT JOIN participants p ON p.id = s.participant_id
       LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.token_hash = ?`,
    tokenHash,
  );
  if (!row || row.revoked_at !== null || row.expires_at <= ctx.now()) return null;
  if (row.kind === 'admin') {
    if (!row.admin_device_id || row.device_revoked !== null) return null;
    return {
      kind: 'admin',
      sessionId: row.id,
      tokenHash,
      deviceId: row.admin_device_id,
      displayName: ADMIN_DISPLAY_NAME,
    };
  }
  if (!row.participant_id || !row.room_id || row.participant_revoked !== null || row.room_closed !== null) return null;
  return {
    kind: 'participant',
    sessionId: row.id,
    tokenHash,
    participantId: row.participant_id,
    roomId: row.room_id,
    displayName: row.display_name ?? '',
  };
}

export type RevokeScope = { sessionId: string } | { deviceId: string } | { participantId: string } | { roomId: string };

export function revokeSessions(ctx: Ctx, scope: RevokeScope): void {
  const [column, value] =
    'sessionId' in scope
      ? ['id', scope.sessionId]
      : 'deviceId' in scope
        ? ['admin_device_id', scope.deviceId]
        : 'participantId' in scope
          ? ['participant_id', scope.participantId]
          : ['room_id', scope.roomId];
  ctx.db.prepare(`UPDATE sessions SET revoked_at = ? WHERE ${column} = ? AND revoked_at IS NULL`).run(ctx.now(), value);
}

export function publicPrincipal(p: Principal) {
  return p.kind === 'admin'
    ? { kind: p.kind, deviceId: p.deviceId, displayName: p.displayName }
    : { kind: p.kind, participantId: p.participantId, roomId: p.roomId, displayName: p.displayName };
}

export function senderOf(p: Principal): { senderKind: 'admin' | 'participant'; senderId: string; senderName: string } {
  return p.kind === 'admin'
    ? { senderKind: 'admin', senderId: ADMIN_SENDER_ID, senderName: p.displayName }
    : { senderKind: 'participant', senderId: p.participantId, senderName: p.displayName };
}
