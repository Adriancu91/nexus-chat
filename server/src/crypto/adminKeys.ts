import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface AdminPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const B64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/**
 * Acceptă doar chei publice ECDSA P-256 în format JWK, așa cum le exportă
 * WebCrypto din browser. Orice cheie privată („d”) este refuzată.
 */
export function parseAdminPublicKey(input: unknown): AdminPublicJwk | null {
  if (typeof input !== 'object' || input === null) return null;
  const jwk = input as Record<string, unknown>;
  if ('d' in jwk) return null;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  if (!B64URL_32_BYTES.test(jwk.x) || !B64URL_32_BYTES.test(jwk.y)) return null;
  const clean: AdminPublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  try {
    createPublicKey({ key: clean as JsonWebKey, format: 'jwk' }); // validează că punctul e pe curbă
  } catch {
    return null;
  }
  return clean;
}

/** Mesajul semnat la autentificare. Prefixul separă domeniul, ca semnătura să nu poată fi refolosită altundeva. */
export function adminLoginMessage(challengeId: string, nonce: string): Buffer {
  return Buffer.from(`nexus-chat/admin-login/v1\n${challengeId}\n${nonce}`, 'utf8');
}

/** Verifică o semnătură ECDSA P-256/SHA-256 în format IEEE P1363 (r‖s, 64 octeți) — formatul WebCrypto. */
export function verifyAdminSignature(jwk: AdminPublicJwk, message: Buffer, signatureB64url: string): boolean {
  if (typeof signatureB64url !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signatureB64url)) return false;
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
    return verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64url, 'base64url'));
  } catch {
    return false;
  }
}
