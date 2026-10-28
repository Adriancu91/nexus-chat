import { forbidden, HttpError, notFound, unauthorized } from '../errors.ts';
import { isUuid } from '../validation.ts';
import { getRoom, type Room } from './rooms.ts';
import type { Principal } from './sessions.ts';
import type { Ctx } from '../context.ts';

export function requireAdmin(p: Principal | null): Extract<Principal, { kind: 'admin' }> {
  if (!p) throw unauthorized();
  if (p.kind !== 'admin') throw forbidden('Doar administratorul poate efectua această operațiune.');
  return p;
}

export function requirePrincipal(p: Principal | null): Principal {
  if (!p) throw unauthorized();
  return p;
}

/**
 * Izolarea între camere: un participant are acces exclusiv la camera pentru care
 * a primit sesiunea. Administratorul are acces la toate camerele.
 */
export function requireRoomAccess(ctx: Ctx, p: Principal | null, roomId: unknown, opts: { write: boolean }): Room {
  const principal = requirePrincipal(p);
  if (!isUuid(roomId)) throw notFound('Camera nu există.');
  if (principal.kind === 'participant' && principal.roomId !== roomId) throw forbidden('Nu ai acces la această cameră.');
  const room = getRoom(ctx, roomId);
  if (!room) throw notFound('Camera nu există.');
  if (opts.write && room.closedAt !== null) throw new HttpError(403, 'room_closed', 'Camera este închisă.');
  return room;
}

export function actorOf(p: Principal): string {
  return p.kind === 'admin' ? `device:${p.deviceId}` : `participant:${p.participantId}`;
}
