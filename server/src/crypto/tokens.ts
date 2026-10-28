import { createHash, randomBytes, randomInt } from 'node:crypto';

/** Token de sesiune: 256 biți aleatori. Doar hash-ul SHA-256 ajunge în baza de date. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 simplu este potrivit aici: tokenurile și codurile de înrolare au
 * entropie mare (≥100 biți), deci nu pot fi ghicite prin forță brută.
 * Parolele camerelor, alese de oameni, folosesc scrypt (passwords.ts).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function randomString(alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// Fără caractere ușor de confundat (0/o, 1/l/i).
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** Cod public de cameră (~50 biți). Nu este secret: accesul e protejat de parola camerei. */
export function newRoomCode(): string {
  return randomString(ROOM_ALPHABET, 10);
}

const ENROLL_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32
/** Cod de înrolare administrator: 20 caractere base32 = 100 biți, afișat în grupuri de câte 5. */
export function newEnrollmentCode(): string {
  return randomString(ENROLL_ALPHABET, 20).match(/.{5}/g)!.join('-');
}

export function normalizeEnrollmentCode(input: string): string {
  const compact = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return compact.length === 20 ? compact.match(/.{5}/g)!.join('-') : compact;
}
