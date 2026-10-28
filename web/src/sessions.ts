import { request, type JoinResponse } from './api.ts';
import { backendUrl } from './config.ts';

/** Sesiunea unui participant într-o cameră, păstrată pe dispozitiv până la ieșire sau expirare. */
export interface RoomSession {
  backend: string;
  token: string;
  expiresAt: number;
  roomId: string;
  roomCode: string;
  roomName: string;
  participantId: string;
  displayName: string;
}

const KEY = 'nexus.roomSessions';
const NAME_KEY = 'nexus.lastDisplayName';

function readAll(): RoomSession[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as RoomSession[]) : [];
  } catch {
    return [];
  }
}

function writeAll(list: RoomSession[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Sesiunile valide pentru serverul configurat acum. */
export function listRoomSessions(): RoomSession[] {
  const now = Date.now();
  const all = readAll();
  const valid = all.filter((s) => s.expiresAt > now);
  if (valid.length !== all.length) writeAll(valid);
  const backend = backendUrl();
  return valid.filter((s) => s.backend === backend);
}

export function getRoomSession(roomId: string): RoomSession | undefined {
  return listRoomSessions().find((s) => s.roomId === roomId);
}

export function saveRoomSession(join: JoinResponse): RoomSession {
  const session: RoomSession = {
    backend: backendUrl(),
    token: join.token,
    expiresAt: join.expiresAt,
    roomId: join.room.id,
    roomCode: join.room.code,
    roomName: join.room.name,
    participantId: join.participant.id,
    displayName: join.participant.displayName,
  };
  writeAll([...readAll().filter((s) => !(s.roomId === session.roomId && s.backend === session.backend)), session]);
  try {
    localStorage.setItem(NAME_KEY, session.displayName);
  } catch {
    // stocare indisponibilă (mod privat): numele nu va fi reținut
  }
  return session;
}

export function forgetRoomSession(roomId: string): void {
  const backend = backendUrl();
  writeAll(readAll().filter((s) => !(s.roomId === roomId && s.backend === backend)));
}

/** Ieșire din cameră: sesiunea este revocată și pe server, nu doar ștearsă local. */
export async function leaveRoom(session: RoomSession): Promise<void> {
  try {
    await request('POST', '/api/session/logout', { token: session.token });
  } finally {
    forgetRoomSession(session.roomId);
  }
}

export function lastDisplayName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
