import { randomBytes, randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from '../db/database.ts';
import {
  adminLoginMessage,
  parseAdminPublicKey,
  verifyAdminSignature,
  type AdminPublicJwk,
} from '../crypto/adminKeys.ts';
import { hashToken, newEnrollmentCode, normalizeEnrollmentCode } from '../crypto/tokens.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { audit } from './audit.ts';
import { createSession, revokeSessions, type IssuedSession } from './sessions.ts';
import type { Ctx } from '../context.ts';

export interface AdminDevice {
  id: string;
  label: string;
  createdAt: number;
  lastLoginAt: number | null;
  revokedAt: number | null;
}

interface DeviceRow {
  id: string;
  label: string;
  public_key_jwk: string;
  created_at: number;
  last_login_at: number | null;
  revoked_at: number | null;
}

const toDevice = (r: DeviceRow): AdminDevice => ({
  id: r.id,
  label: r.label,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at,
  revokedAt: r.revoked_at,
});

export function hasActiveAdminDevice(ctx: Ctx): boolean {
  return !!getRow(ctx.db, 'SELECT 1 FROM admin_devices WHERE revoked_at IS NULL LIMIT 1');
}

/**
 * Cod de înrolare de unică folosință. Codul în clar este întors o singură dată
 * (pentru afișare pe laptop); în baza de date rămâne doar hash-ul.
 */
export function issueEnrollmentCode(
  ctx: Ctx,
  purpose: 'bootstrap' | 'enroll',
  createdBy: string,
): { code: string; expiresAt: number } {
  const code = newEnrollmentCode();
  const now = ctx.now();
  const ttl = purpose === 'bootstrap' ? ctx.config.bootstrapCodeTtlMs : ctx.config.enrollmentCodeTtlMs;
  transaction(ctx.db, () => {
    // Un singur cod valid la un moment dat: cele vechi, nefolosite, sunt anulate.
    ctx.db.prepare('UPDATE admin_enrollment_codes SET expires_at = ? WHERE used_at IS NULL AND expires_at > ?').run(now, now);
    ctx.db
      .prepare(
        'INSERT INTO admin_enrollment_codes (id, code_hash, purpose, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), hashToken(code), purpose, createdBy, now, now + ttl);
    audit(ctx, createdBy, 'admin.enrollment_code_issued', undefined, { purpose });
  });
  return { code, expiresAt: now + ttl };
}

/** La prima pornire (niciun dispozitiv de administrator) se emite un cod de inițializare. */
export function ensureBootstrapCode(ctx: Ctx): { code: string; expiresAt: number } | null {
  if (hasActiveAdminDevice(ctx)) return null;
  return issueEnrollmentCode(ctx, 'bootstrap', 'system');
}

/** Înregistrează cheia publică a unui dispozitiv nou, consumând un cod de înrolare valid. */
export function enrollDevice(ctx: Ctx, rawCode: string, publicKey: unknown, label: string): AdminDevice {
  const jwk = parseAdminPublicKey(publicKey);
  if (!jwk) throw badRequest('invalid_public_key', 'Cheia publică trebuie să fie ECDSA P-256 în format JWK.');
  const codeHash = hashToken(normalizeEnrollmentCode(rawCode));
  return transaction(ctx.db, () => {
    const now = ctx.now();
    const code = getRow<{ id: string }>(
      ctx.db,
      'SELECT id FROM admin_enrollment_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
      codeHash,
      now,
    );
    if (!code) throw new HttpError(401, 'invalid_enrollment_code', 'Cod de înrolare invalid sau expirat.');
    ctx.db.prepare('UPDATE admin_enrollment_codes SET used_at = ? WHERE id = ?').run(now, code.id);
    const id = randomUUID();
    ctx.db
      .prepare('INSERT INTO admin_devices (id, label, public_key_jwk, created_at) VALUES (?, ?, ?, ?)')
      .run(id, label, JSON.stringify(jwk), now);
    audit(ctx, `device:${id}`, 'admin.device_enrolled', id, { label });
    return { id, label, createdAt: now, lastLoginAt: null, revokedAt: null };
  });
}

interface Challenge {
  deviceId: string;
  nonce: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_CHALLENGES = 1000;

/**
 * Autentificare prin provocare-răspuns: serverul trimite un nonce, dispozitivul îl
 * semnează cu cheia privată ne-exportabilă (păstrată în browser), serverul verifică
 * semnătura cu cheia publică înregistrată. Nicio parolă de administrator nu există.
 */
export class AdminAuth {
  private readonly challenges = new Map<string, Challenge>();
  private readonly ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  createChallenge(deviceId: string): { challengeId: string; nonce: string; expiresAt: number } {
    const now = this.ctx.now();
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      for (const [k, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(k);
      if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
        throw new HttpError(503, 'busy', 'Prea multe autentificări în curs. Încearcă din nou.');
      }
    }
    const challengeId = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = now + CHALLENGE_TTL_MS;
    // Provocarea se emite și pentru dispozitive inexistente, ca răspunsul să nu le dezvăluie.
    this.challenges.set(challengeId, { deviceId, nonce, expiresAt });
    return { challengeId, nonce, expiresAt };
  }

  /** Întoarce sesiunea sau null dacă semnătura/provocarea nu este validă. Provocarea se consumă oricum. */
  login(deviceId: string, challengeId: string, signature: string): IssuedSession | null {
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    const now = this.ctx.now();
    if (!ch || ch.deviceId !== deviceId || ch.expiresAt <= now) return null;
    const device = getRow<DeviceRow>(this.ctx.db, 'SELECT * FROM admin_devices WHERE id = ?', deviceId);
    if (!device || device.revoked_at !== null) return null;
    const jwk = JSON.parse(device.public_key_jwk) as AdminPublicJwk;
    if (!verifyAdminSignature(jwk, adminLoginMessage(challengeId, ch.nonce), signature)) {
      audit(this.ctx, `device:${deviceId}`, 'admin.login_failed', deviceId);
      return null;
    }
    return transaction(this.ctx.db, () => {
      this.ctx.db.prepare('UPDATE admin_devices SET last_login_at = ? WHERE id = ?').run(now, deviceId);
      audit(this.ctx, `device:${deviceId}`, 'admin.login', deviceId);
      return createSession(this.ctx, { kind: 'admin', deviceId });
    });
  }
}

export function listDevices(ctx: Ctx): AdminDevice[] {
  return allRows<DeviceRow>(ctx.db, 'SELECT * FROM admin_devices ORDER BY created_at').map(toDevice);
}

export function revokeDevice(ctx: Ctx, deviceId: string, actor: string): void {
  transaction(ctx.db, () => {
    const res = ctx.db
      .prepare('UPDATE admin_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(ctx.now(), deviceId);
    if (res.changes === 0) throw notFound('Dispozitivul nu există sau este deja revocat.');
    revokeSessions(ctx, { deviceId });
    audit(ctx, actor, 'admin.device_revoked', deviceId);
  });
}
