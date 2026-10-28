import fs from 'node:fs';
import path from 'node:path';
import { getRow } from '../db/database.ts';
import { badRequest, HttpError, tooManyRequests, unauthorized } from '../errors.ts';
import { actorOf, requireAdmin, requirePrincipal, requireRoomAccess } from '../services/access.ts';
import { AdminAuth, enrollDevice, issueEnrollmentCode, listDevices, revokeDevice } from '../services/admin.ts';
import { listAudit } from '../services/audit.ts';
import { listMessages } from '../services/messages.ts';
import { RateLimiter } from '../services/rateLimiter.ts';
import {
  createRoom,
  deleteRoom,
  getRoom,
  joinRoom,
  listParticipants,
  listRooms,
  revokeParticipant,
  updateRoom,
} from '../services/rooms.ts';
import { publicPrincipal, revokeSessions } from '../services/sessions.ts';
import { asObject, cleanLabel, isUuid, optionalBool, optionalInt, password, token } from '../validation.ts';
import { created, noContent, ok } from './http.ts';
import { Router, type RequestContext } from './router.ts';
import type { Hub } from '../ws/hub.ts';
import type { Ctx } from '../context.ts';

export const VERSION = '0.1.0';

function intParam(q: URLSearchParams, key: string, min: number, max: number): number | undefined {
  const raw = q.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest('invalid_query', `Parametrul „${key}” este invalid.`);
  return n;
}

function uuidParam(rc: RequestContext, key: string): string {
  const v = rc.params[key];
  if (!isUuid(v)) throw new HttpError(404, 'not_found', 'Resursa nu există.');
  return v;
}

export function buildRouter(ctx: Ctx, hub: Hub): Router {
  const { limits } = ctx.config;
  const adminAuth = new AdminAuth(ctx);
  const joinIpLimiter = new RateLimiter(limits.joinFailuresPerIp, limits.joinWindowMs, ctx.now);
  const joinRoomLimiter = new RateLimiter(limits.joinFailuresPerRoom, limits.joinWindowMs, ctx.now);
  const adminFailLimiter = new RateLimiter(limits.adminFailuresPerIp, limits.adminWindowMs, ctx.now);
  const adminChallengeLimiter = new RateLimiter(limits.adminChallengesPerIp, limits.adminWindowMs, ctx.now);
  const startedAt = ctx.now();

  const guardAdminFailures = (ip: string) => {
    const wait = adminFailLimiter.blockedFor(ip);
    if (wait > 0) throw tooManyRequests(wait);
  };

  const router = new Router();

  // ---- public ----
  router.add('GET', '/api/health', () => ok({ ok: true, name: 'nexus-chat', version: VERSION }));

  router.add('GET', '/api/session', (rc) => ok({ principal: publicPrincipal(requirePrincipal(rc.principal)) }));

  router.add('POST', '/api/session/logout', (rc) => {
    const p = requirePrincipal(rc.principal);
    revokeSessions(ctx, { sessionId: p.sessionId });
    hub.disconnectInvalid();
    return noContent();
  });

  router.add('POST', '/api/rooms/join', async (rc) => {
    const body = asObject(await rc.body());
    const code = token(body, 'code', 32).toLowerCase();
    const roomKey = `room:${code}`;
    const wait = Math.max(joinIpLimiter.blockedFor(rc.ip), joinRoomLimiter.blockedFor(roomKey));
    if (wait > 0) throw tooManyRequests(wait);
    const pw = password(body, 'password', 1, limits.roomPasswordMaxChars);
    const displayName = cleanLabel(body, 'displayName', limits.displayNameMaxChars);
    const result = await joinRoom(ctx, code, pw, displayName);
    if (!result) {
      joinIpLimiter.hit(rc.ip);
      joinRoomLimiter.hit(roomKey);
      throw new HttpError(401, 'invalid_credentials', 'Codul camerei sau parola nu sunt corecte.');
    }
    return created(result);
  });

  router.add('GET', '/api/rooms/:roomId/messages', (rc) => {
    const room = requireRoomAccess(ctx, rc.principal, rc.params.roomId, { write: false });
    const limit = intParam(rc.query, 'limit', 1, 200) ?? 50;
    const afterSeq = intParam(rc.query, 'afterSeq', 0, Number.MAX_SAFE_INTEGER);
    const beforeSeq = intParam(rc.query, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER);
    return ok({ roomId: room.id, ...listMessages(ctx, room.id, { afterSeq, beforeSeq, limit }) });
  });

  // ---- autentificare administrator ----
  router.add('POST', '/api/admin/enroll', async (rc) => {
    guardAdminFailures(rc.ip);
    const body = asObject(await rc.body());
    const label = cleanLabel(body, 'label', 60);
    try {
      return created({ device: enrollDevice(ctx, token(body, 'code', 64), body.publicKey, label) });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) adminFailLimiter.hit(rc.ip);
      throw err;
    }
  });

  router.add('POST', '/api/admin/challenge', async (rc) => {
    if (!adminChallengeLimiter.hit(rc.ip)) throw tooManyRequests(adminChallengeLimiter.blockedFor(rc.ip));
    const body = asObject(await rc.body());
    const deviceId = token(body, 'deviceId', 64);
    return ok(adminAuth.createChallenge(deviceId));
  });

  router.add('POST', '/api/admin/login', async (rc) => {
    guardAdminFailures(rc.ip);
    const body = asObject(await rc.body());
    const session = adminAuth.login(token(body, 'deviceId', 64), token(body, 'challengeId', 64), token(body, 'signature', 128));
    if (!session) {
      adminFailLimiter.hit(rc.ip);
      throw unauthorized('Autentificarea dispozitivului a eșuat.');
    }
    return ok(session);
  });

  // ---- administrare (doar administratorul) ----
  router.add('GET', '/api/admin/devices', (rc) => {
    requireAdmin(rc.principal);
    return ok({ devices: listDevices(ctx) });
  });

  router.add('POST', '/api/admin/devices/:deviceId/revoke', (rc) => {
    const admin = requireAdmin(rc.principal);
    revokeDevice(ctx, uuidParam(rc, 'deviceId'), actorOf(admin));
    hub.disconnectInvalid();
    return noContent();
  });

  router.add('POST', '/api/admin/enrollment-codes', (rc) => {
    const admin = requireAdmin(rc.principal);
    return created(issueEnrollmentCode(ctx, 'enroll', actorOf(admin)));
  });

  router.add('GET', '/api/admin/rooms', (rc) => {
    requireAdmin(rc.principal);
    return ok({ rooms: listRooms(ctx) });
  });

  router.add('POST', '/api/admin/rooms', async (rc) => {
    const admin = requireAdmin(rc.principal);
    const body = asObject(await rc.body());
    const room = await createRoom(
      ctx,
      {
        name: cleanLabel(body, 'name', limits.roomNameMaxChars),
        password: password(body, 'password', limits.roomPasswordMinChars, limits.roomPasswordMaxChars),
        maxParticipants: optionalInt(body, 'maxParticipants', 2, 500),
      },
      actorOf(admin),
    );
    return created({ room });
  });

  router.add('PATCH', '/api/admin/rooms/:roomId', async (rc) => {
    const admin = requireAdmin(rc.principal);
    const roomId = uuidParam(rc, 'roomId');
    const body = asObject(await rc.body());
    const { room, sessionsRevoked } = await updateRoom(
      ctx,
      roomId,
      {
        name: body.name === undefined ? undefined : cleanLabel(body, 'name', limits.roomNameMaxChars),
        password:
          body.password === undefined
            ? undefined
            : password(body, 'password', limits.roomPasswordMinChars, limits.roomPasswordMaxChars),
        maxParticipants: optionalInt(body, 'maxParticipants', 2, 500),
        closed: optionalBool(body, 'closed'),
        revokeSessions: optionalBool(body, 'revokeSessions'),
      },
      actorOf(admin),
    );
    if (sessionsRevoked) hub.disconnectInvalid();
    return ok({ room });
  });

  router.add('DELETE', '/api/admin/rooms/:roomId', async (rc) => {
    const admin = requireAdmin(rc.principal);
    const body = asObject(await rc.body());
    deleteRoom(ctx, uuidParam(rc, 'roomId'), token(body, 'confirmCode', 32), actorOf(admin));
    hub.disconnectInvalid();
    return noContent();
  });

  router.add('GET', '/api/admin/rooms/:roomId/participants', (rc) => {
    requireAdmin(rc.principal);
    const roomId = uuidParam(rc, 'roomId');
    if (!getRoom(ctx, roomId)) throw new HttpError(404, 'not_found', 'Camera nu există.');
    return ok({ participants: listParticipants(ctx, roomId) });
  });

  router.add('POST', '/api/admin/participants/:participantId/revoke', (rc) => {
    const admin = requireAdmin(rc.principal);
    revokeParticipant(ctx, uuidParam(rc, 'participantId'), actorOf(admin));
    hub.disconnectInvalid();
    return noContent();
  });

  router.add('GET', '/api/admin/audit', (rc) => {
    requireAdmin(rc.principal);
    const limit = intParam(rc.query, 'limit', 1, 500) ?? 100;
    return ok({ entries: listAudit(ctx, limit, intParam(rc.query, 'beforeId', 1, Number.MAX_SAFE_INTEGER)) });
  });

  router.add('GET', '/api/admin/status', async (rc) => {
    requireAdmin(rc.principal);
    const count = (table: string) => getRow<{ n: number }>(ctx.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;
    const dbFile = path.join(ctx.config.dataDir, 'nexus.db');
    const dbSizeBytes = fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0;
    let diskFreeBytes: number | null = null;
    try {
      const s = await fs.promises.statfs(ctx.config.dataDir);
      diskFreeBytes = s.bavail * s.bsize;
    } catch {
      diskFreeBytes = null;
    }
    return ok({
      version: VERSION,
      uptimeSec: Math.round((ctx.now() - startedAt) / 1000),
      dataDir: ctx.config.dataDir,
      dbSizeBytes,
      diskFreeBytes,
      rooms: count('rooms'),
      messages: count('messages'),
      wsConnections: hub.connectionCount,
    });
  });

  return router;
}
