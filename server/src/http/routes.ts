import fs from 'node:fs';
import path from 'node:path';
import { getRow } from '../db/database.ts';
import { badRequest, HttpError, tooManyRequests, unauthorized } from '../errors.ts';
import { actorOf, requireAdmin, requirePrincipal, requireRoomAccess } from '../services/access.ts';
import { AdminAuth, enrollDevice, issueEnrollmentCode, listDevices, revokeDevice } from '../services/admin.ts';
import { applyRetention, retentionPreview, verifyArchive } from '../services/archive.ts';
import { audit, listAudit } from '../services/audit.ts';
import {
  backupRoot,
  createBackup,
  defaultBackupRoot,
  isValidBackupName,
  listBackups,
  verifyBackup,
} from '../services/backup.ts';
import {
  commitUpload,
  contentDisposition,
  freeDiskBytes,
  getFile,
  listRoomFiles,
  receiveUpload,
  removeStoredFiles,
  storedFilePath,
} from '../services/files.ts';
import { listMessages, searchMessages } from '../services/messages.ts';
import { getArchiveSettings, getBackupStatus, setArchiveSettings, type ArchiveSettings } from '../services/settings.ts';
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
import { authenticateHash, publicPrincipal, revokeSessions } from '../services/sessions.ts';
import { asObject, cleanLabel, cleanMessageBody, isUuid, optionalBool, optionalInt, password, token } from '../validation.ts';
import { created, noContent, ok } from './http.ts';
import { Router, type RequestContext } from './router.ts';
import type { CallService } from '../calls/calls.ts';
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

export function buildRouter(ctx: Ctx, hub: Hub, calls: CallService): Router {
  const { limits } = ctx.config;
  const adminAuth = new AdminAuth(ctx);
  const joinIpLimiter = new RateLimiter(limits.joinFailuresPerIp, limits.joinWindowMs, ctx.now);
  const joinRoomLimiter = new RateLimiter(limits.joinFailuresPerRoom, limits.joinWindowMs, ctx.now);
  const adminFailLimiter = new RateLimiter(limits.adminFailuresPerIp, limits.adminWindowMs, ctx.now);
  const adminChallengeLimiter = new RateLimiter(limits.adminChallengesPerIp, limits.adminWindowMs, ctx.now);
  const uploadLimiter = new RateLimiter(limits.uploadsPerWindow, limits.uploadWindowMs, ctx.now);
  const callTokenLimiter = new RateLimiter(30, 10 * 60_000, ctx.now);
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
    const keys = deleteRoom(ctx, uuidParam(rc, 'roomId'), token(body, 'confirmCode', 32), actorOf(admin));
    hub.disconnectInvalid();
    await removeStoredFiles(ctx.config, keys);
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
      files: count('files'),
      filesBytes: getRow<{ b: number | null }>(ctx.db, 'SELECT SUM(size) AS b FROM files')!.b ?? 0,
      wsConnections: hub.connectionCount,
    });
  });

  // ---- fișiere ----
  router.add('POST', '/api/rooms/:roomId/files', async (rc) => {
    const principal = requirePrincipal(rc.principal);
    const room = requireRoomAccess(ctx, principal, rc.params.roomId, { write: true });
    if (!(rc.req.headers['content-type'] ?? '').toLowerCase().startsWith('application/octet-stream')) {
      throw new HttpError(415, 'unsupported_media_type', 'Fișierul trebuie trimis ca application/octet-stream.');
    }
    const rawName = decodeHeader(rc.req.headers['x-file-name']);
    if (!rawName) throw badRequest('missing_file_name', 'Numele fișierului lipsește.');
    const captionRaw = decodeHeader(rc.req.headers['x-caption'])?.trim();
    const caption = captionRaw ? cleanMessageBody(captionRaw, limits.messageMaxChars) : '';
    if (!uploadLimiter.hit(principal.sessionId)) throw tooManyRequests(uploadLimiter.blockedFor(principal.sessionId));

    const upload = await receiveUpload(ctx, rc.req);
    // Transferul poate dura: accesul este re-verificat înainte de salvare.
    const fresh = authenticateHash(ctx, principal.tokenHash);
    try {
      requireRoomAccess(ctx, fresh, room.id, { write: true });
    } catch (err) {
      await fs.promises.rm(upload.tmpPath, { force: true });
      throw err;
    }
    const message = await commitUpload(ctx, fresh!, room.id, upload, rawName, caption);
    hub.broadcast(room.id, { type: 'message', message });
    return created({ message });
  });

  router.add('GET', '/api/files/:fileId', (rc) => {
    const file = getFile(ctx, uuidParam(rc, 'fileId'));
    if (!file) throw new HttpError(404, 'not_found', 'Fișierul nu există.');
    requireRoomAccess(ctx, rc.principal, file.roomId, { write: false });
    const inline = file.inlineSafe && rc.query.get('download') !== '1';
    return {
      status: 200,
      file: {
        path: storedFilePath(ctx.config, file.storageKey),
        size: file.size,
        headers: {
          // Doar imaginile verificate primesc tipul real; restul nu pot fi interpretate de browser.
          'Content-Type': inline ? file.mime : 'application/octet-stream',
          'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Cache-Control': 'private, no-store',
          'Access-Control-Expose-Headers': 'Content-Disposition',
        },
      },
    };
  });

  router.add('GET', '/api/rooms/:roomId/files', (rc) => {
    const room = requireRoomAccess(ctx, rc.principal, rc.params.roomId, { write: false });
    const limit = intParam(rc.query, 'limit', 1, 200) ?? 100;
    return ok({ roomId: room.id, ...listRoomFiles(ctx, room.id, limit, intParam(rc.query, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER)) });
  });

  // ---- apeluri ----
  router.add('POST', '/api/rooms/:roomId/call/token', async (rc) => {
    const principal = requirePrincipal(rc.principal);
    const room = requireRoomAccess(ctx, principal, rc.params.roomId, { write: true });
    if (!callTokenLimiter.hit(principal.sessionId)) throw tooManyRequests(callTokenLimiter.blockedFor(principal.sessionId));
    return created(await calls.issueToken(principal, room.id));
  });

  router.add('GET', '/api/rooms/:roomId/call', async (rc) => {
    const room = requireRoomAccess(ctx, rc.principal, rc.params.roomId, { write: false });
    return ok(await calls.state(room.id));
  });

  router.add('GET', '/api/rooms/:roomId/search', (rc) => {
    const room = requireRoomAccess(ctx, rc.principal, rc.params.roomId, { write: false });
    const q = rc.query.get('q') ?? '';
    if (q.trim().length === 0 || q.length > 200) throw badRequest('invalid_query', 'Introdu un text de căutat (maxim 200 de caractere).');
    const limit = intParam(rc.query, 'limit', 1, 100) ?? 50;
    return ok({ roomId: room.id, results: searchMessages(ctx, room.id, q, limit) });
  });

  // ---- arhivă, retenție, backup (doar administratorul) ----
  router.add('GET', '/api/admin/archive', async (rc) => {
    requireAdmin(rc.principal);
    const root = backupRoot(ctx);
    return ok({
      settings: getArchiveSettings(ctx),
      backupDir: root,
      defaultBackupDir: defaultBackupRoot(ctx.config.dataDir),
      backups: await listBackups(root),
      backupStatus: getBackupStatus(ctx),
      dataFreeBytes: await freeDiskBytes(ctx.config.dataDir),
      backupFreeBytes: await freeDiskBytes(fs.existsSync(root) ? root : path.dirname(root)),
      maxFileBytes: limits.maxFileBytes,
    });
  });

  router.add('PUT', '/api/admin/archive/settings', async (rc) => {
    const admin = requireAdmin(rc.principal);
    const body = asObject(await rc.body());
    const current = getArchiveSettings(ctx);
    const next: ArchiveSettings = { retentionDays: current.retentionDays, backup: { ...current.backup } };
    if ('retentionDays' in body) {
      next.retentionDays = body.retentionDays === null ? null : optionalInt(body, 'retentionDays', 1, 36_500)!;
    }
    if (body.backup !== undefined) {
      const b = asObject(body.backup);
      next.backup.enabled = optionalBool(b, 'enabled') ?? next.backup.enabled;
      next.backup.intervalHours = optionalInt(b, 'intervalHours', 1, 720) ?? next.backup.intervalHours;
      next.backup.keep = optionalInt(b, 'keep', 1, 100) ?? next.backup.keep;
      if ('dir' in b) next.backup.dir = b.dir === null || b.dir === '' ? null : await validateBackupDir(ctx, b.dir);
    }
    setArchiveSettings(ctx, next);
    audit(ctx, actorOf(admin), 'archive.settings_updated', undefined, { retentionDays: next.retentionDays, backup: next.backup });
    const retention = await applyRetention(ctx, actorOf(admin));
    return ok({ settings: next, retentionApplied: retention });
  });

  router.add('GET', '/api/admin/archive/retention-preview', (rc) => {
    requireAdmin(rc.principal);
    const days = intParam(rc.query, 'days', 1, 36_500);
    if (days === undefined) throw badRequest('invalid_query', 'Parametrul „days” lipsește.');
    return ok(retentionPreview(ctx, days));
  });

  router.add('POST', '/api/admin/archive/backups', async (rc) => {
    const admin = requireAdmin(rc.principal);
    return created({ backup: await createBackup(ctx, actorOf(admin)) });
  });

  router.add('POST', '/api/admin/archive/backups/:name/verify', async (rc) => {
    const admin = requireAdmin(rc.principal);
    const name = rc.params.name ?? '';
    if (!isValidBackupName(name)) throw new HttpError(404, 'not_found', 'Backup inexistent.');
    const result = await verifyBackup(backupRoot(ctx), name);
    audit(ctx, actorOf(admin), 'backup.verified', name, { ok: result.ok, problems: result.problems.length });
    return ok(result);
  });

  // Diagnostic pentru configurarea accesului extern: ce vede serverul despre cererea curentă.
  // Nu conține tokenuri (antetul Authorization nu este inclus).
  router.add('GET', '/api/admin/diagnostics/request', (rc) => {
    requireAdmin(rc.principal);
    const pick = ['host', 'origin', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'tailscale-funnel-request', 'user-agent'];
    const headers: Record<string, string> = {};
    for (const name of pick) {
      const v = rc.req.headers[name];
      if (v !== undefined) headers[name] = Array.isArray(v) ? v.join(', ') : v;
    }
    return ok({
      socketAddress: rc.req.socket.remoteAddress ?? null,
      clientIp: rc.ip,
      trustProxyHeader: ctx.config.trustProxyHeader,
      allowedOrigins: ctx.config.allowedOrigins,
      headers,
    });
  });

  router.add('POST', '/api/admin/archive/verify', async (rc) => {
    requireAdmin(rc.principal);
    return ok(await verifyArchive(ctx));
  });

  return router;
}

function decodeHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length > 2048) throw badRequest('invalid_header', 'Antet prea lung.');
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest('invalid_header', 'Antet codificat greșit.');
  }
}

/** Folderul de backup: cale absolută, în afara arhivei (altfel backup-ul s-ar copia pe sine). */
async function validateBackupDir(ctx: Ctx, value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.length > 500 || !path.isAbsolute(value)) {
    throw badRequest('invalid_backup_dir', 'Folderul de backup trebuie să fie o cale completă, de ex. D:\\NexusBackup.');
  }
  const dir = path.resolve(value);
  const data = path.resolve(ctx.config.dataDir);
  const inside = (a: string, b: string) => {
    const rel = path.relative(b, a);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(dir, data) || inside(data, dir)) {
    throw badRequest('invalid_backup_dir', 'Folderul de backup nu poate fi în interiorul arhivei (sau invers).');
  }
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.access(dir, fs.constants.W_OK);
  } catch {
    throw badRequest('invalid_backup_dir', 'Folderul de backup nu poate fi creat sau nu permite scrierea.');
  }
  return dir;
}
