import { randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from '../db/database.ts';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../crypto/passwords.ts';
import { newRoomCode } from '../crypto/tokens.ts';
import { HttpError, notFound } from '../errors.ts';
import { audit } from './audit.ts';
import { createSession, revokeSessions, type IssuedSession } from './sessions.ts';
import type { Ctx } from '../context.ts';

export const DEFAULT_MAX_PARTICIPANTS = 50;

export interface Room {
  id: string;
  code: string;
  name: string;
  maxParticipants: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

interface RoomRow {
  id: string;
  code: string;
  name: string;
  password_hash: string;
  max_participants: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

const toRoom = (r: RoomRow): Room => ({
  id: r.id,
  code: r.code,
  name: r.name,
  maxParticipants: r.max_participants,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  closedAt: r.closed_at,
});

export function getRoom(ctx: Ctx, roomId: string): Room | undefined {
  const row = getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', roomId);
  return row && toRoom(row);
}

export function listRooms(ctx: Ctx): Room[] {
  return allRows<RoomRow>(ctx.db, 'SELECT * FROM rooms ORDER BY created_at DESC').map(toRoom);
}

export async function createRoom(
  ctx: Ctx,
  input: { name: string; password: string; maxParticipants?: number | undefined },
  actor: string,
): Promise<Room> {
  const passwordHash = await hashPassword(input.password);
  return transaction(ctx.db, () => {
    const now = ctx.now();
    const id = randomUUID();
    let code = newRoomCode();
    while (getRow(ctx.db, 'SELECT 1 FROM rooms WHERE code = ?', code)) code = newRoomCode();
    ctx.db
      .prepare(
        `INSERT INTO rooms (id, code, name, password_hash, max_participants, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, code, input.name, passwordHash, input.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS, now, now);
    audit(ctx, actor, 'room.created', id, { name: input.name });
    return toRoom(getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', id)!);
  });
}

export interface RoomUpdate {
  name?: string | undefined;
  password?: string | undefined;
  maxParticipants?: number | undefined;
  closed?: boolean | undefined;
  /** La schimbarea parolei: deconectează participanții existenți. */
  revokeSessions?: boolean | undefined;
}

/** Întoarce camera actualizată și dacă sesiunile participanților au fost revocate. */
export async function updateRoom(
  ctx: Ctx,
  roomId: string,
  update: RoomUpdate,
  actor: string,
): Promise<{ room: Room; sessionsRevoked: boolean }> {
  const passwordHash = update.password !== undefined ? await hashPassword(update.password) : undefined;
  return transaction(ctx.db, () => {
    const row = getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', roomId);
    if (!row) throw notFound('Camera nu există.');
    const now = ctx.now();
    const changes: string[] = [];
    if (update.name !== undefined && update.name !== row.name) {
      ctx.db.prepare('UPDATE rooms SET name = ? WHERE id = ?').run(update.name, roomId);
      changes.push('name');
    }
    if (passwordHash !== undefined) {
      ctx.db.prepare('UPDATE rooms SET password_hash = ? WHERE id = ?').run(passwordHash, roomId);
      changes.push('password');
    }
    if (update.maxParticipants !== undefined && update.maxParticipants !== row.max_participants) {
      ctx.db.prepare('UPDATE rooms SET max_participants = ? WHERE id = ?').run(update.maxParticipants, roomId);
      changes.push('maxParticipants');
    }
    let sessionsRevoked = false;
    if (update.closed === true && row.closed_at === null) {
      ctx.db.prepare('UPDATE rooms SET closed_at = ? WHERE id = ?').run(now, roomId);
      revokeSessions(ctx, { roomId });
      sessionsRevoked = true;
      changes.push('closed');
    } else if (update.closed === false && row.closed_at !== null) {
      ctx.db.prepare('UPDATE rooms SET closed_at = NULL WHERE id = ?').run(roomId);
      changes.push('reopened');
    }
    if (passwordHash !== undefined && update.revokeSessions) {
      revokeSessions(ctx, { roomId });
      sessionsRevoked = true;
    }
    if (changes.length > 0) {
      ctx.db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(now, roomId);
      audit(ctx, actor, 'room.updated', roomId, { changes, sessionsRevoked });
    }
    return { room: toRoom(getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', roomId)!), sessionsRevoked };
  });
}

/** Ștergere definitivă: camera, participanții, sesiunile și mesajele ei. */
export function deleteRoom(ctx: Ctx, roomId: string, confirmCode: string, actor: string): void {
  transaction(ctx.db, () => {
    const row = getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', roomId);
    if (!row) throw notFound('Camera nu există.');
    if (confirmCode !== row.code) {
      throw new HttpError(400, 'confirmation_mismatch', 'Pentru ștergere, confirmă introducând codul camerei.');
    }
    ctx.db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    audit(ctx, actor, 'room.deleted', roomId, { name: row.name });
  });
}

export interface JoinResult extends IssuedSession {
  room: { id: string; code: string; name: string };
  participant: { id: string; displayName: string };
}

/**
 * Intrare în cameră cu cod + parolă + nume. Același mesaj de eroare pentru cod
 * inexistent și parolă greșită, și același cost de calcul, ca să nu se poată
 * enumera camerele.
 */
export async function joinRoom(ctx: Ctx, code: string, password: string, displayName: string): Promise<JoinResult | null> {
  const row = getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE code = ?', code);
  const ok = await verifyPassword(password, row?.password_hash ?? (await dummyPasswordHash()));
  if (!row || !ok) return null;
  return transaction(ctx.db, () => {
    const current = getRow<RoomRow>(ctx.db, 'SELECT * FROM rooms WHERE id = ?', row.id);
    // Parola sau starea camerei se pot schimba în timpul verificării scrypt.
    if (!current || current.password_hash !== row.password_hash) return null;
    if (current.closed_at !== null) throw new HttpError(403, 'room_closed', 'Camera este închisă.');
    const now = ctx.now();
    const active = getRow<{ n: number }>(
      ctx.db,
      `SELECT COUNT(DISTINCT s.participant_id) AS n FROM sessions s
         JOIN participants p ON p.id = s.participant_id
        WHERE s.room_id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND p.revoked_at IS NULL`,
      current.id,
      now,
    )!.n;
    if (active >= current.max_participants) {
      throw new HttpError(403, 'room_full', 'Camera a atins numărul maxim de participanți.');
    }
    const participantId = randomUUID();
    ctx.db
      .prepare('INSERT INTO participants (id, room_id, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(participantId, current.id, displayName, now, now);
    const session = createSession(ctx, { kind: 'participant', participantId, roomId: current.id });
    return {
      ...session,
      room: { id: current.id, code: current.code, name: current.name },
      participant: { id: participantId, displayName },
    };
  });
}

export interface ParticipantInfo {
  id: string;
  displayName: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export function listParticipants(ctx: Ctx, roomId: string): ParticipantInfo[] {
  return allRows<{ id: string; display_name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null }>(
    ctx.db,
    'SELECT id, display_name, created_at, last_seen_at, revoked_at FROM participants WHERE room_id = ? ORDER BY created_at',
    roomId,
  ).map((r) => ({
    id: r.id,
    displayName: r.display_name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at,
  }));
}

export function revokeParticipant(ctx: Ctx, participantId: string, actor: string): { roomId: string } {
  return transaction(ctx.db, () => {
    const p = getRow<{ room_id: string; revoked_at: number | null }>(
      ctx.db,
      'SELECT room_id, revoked_at FROM participants WHERE id = ?',
      participantId,
    );
    if (!p || p.revoked_at !== null) throw notFound('Participantul nu există sau este deja revocat.');
    ctx.db.prepare('UPDATE participants SET revoked_at = ? WHERE id = ?').run(ctx.now(), participantId);
    revokeSessions(ctx, { participantId });
    audit(ctx, actor, 'participant.revoked', participantId, { roomId: p.room_id });
    return { roomId: p.room_id };
  });
}

export function touchParticipant(ctx: Ctx, participantId: string): void {
  ctx.db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').run(ctx.now(), participantId);
}
