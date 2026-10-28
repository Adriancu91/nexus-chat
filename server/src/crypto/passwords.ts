import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Parametri scrypt (OWASP: N=2^15, r=8, p=1 ≈ 32 MiB și ~50–100 ms per verificare).
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, opts: ScryptOptions, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLen, { ...opts, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Format stocat: scrypt$N$r$p$<sare base64url>$<cheie base64url> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { N, r: R, p: P }, KEY_LEN);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await derive(password, Buffer.from(saltB64, 'base64url'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  }, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Hash folosit când camera nu există, ca durata răspunsului să nu dezvăluie
 * dacă un cod de cameră este valid.
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
