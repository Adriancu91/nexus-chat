import { ApiError, request } from './api.ts';
import { backendUrl } from './config.ts';

/**
 * Identitatea administratorului pe acest dispozitiv: o cheie privată ECDSA P-256
 * generată de browser cu extractable=false. Cheia nu poate fi citită sau exportată,
 * nici de codul paginii; se poate doar semna cu ea. Se păstrează în IndexedDB.
 */
interface StoredDevice {
  backend: string;
  deviceId: string;
  label: string;
  privateKey: CryptoKey;
  createdAt: number;
}

const DB_NAME = 'nexus-admin';
const STORE = 'devices';
const TOKEN_KEY = 'nexus.adminSession';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'backend' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getLocalDevice(): Promise<StoredDevice | undefined> {
  if (!('indexedDB' in window)) return undefined;
  return tx<StoredDevice | undefined>('readonly', (s) => s.get(backendUrl()) as IDBRequest<StoredDevice | undefined>);
}

/**
 * Mută înregistrarea dispozitivului de la o adresă veche a serverului la cea curentă.
 * Cheia privată (CryptoKey ne-exportabil) se copiază ca obiect, nu ca date: rămâne
 * la fel de ne-exportabilă.
 */
export async function migrateAdminDevice(previous: string[]): Promise<boolean> {
  if (!('indexedDB' in window) || (await getLocalDevice())) return false;
  for (const old of previous) {
    const device = await tx<StoredDevice | undefined>('readonly', (s) => s.get(old) as IDBRequest<StoredDevice | undefined>);
    if (!device) continue;
    await tx('readwrite', (s) => s.put({ ...device, backend: backendUrl() }));
    await tx('readwrite', (s) => s.delete(old));
    return true;
  }
  return false;
}

export async function forgetLocalDevice(): Promise<void> {
  clearAdminSession();
  await tx('readwrite', (s) => s.delete(backendUrl()));
}

export function cryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && window.isSecureContext;
}

/** Înrolează acest dispozitiv folosind un cod de unică folosință afișat pe laptop. */
export async function enrollThisDevice(code: string, label: string): Promise<void> {
  if (!cryptoAvailable()) {
    throw new Error('Browserul nu permite criptografie aici. Deschide pagina prin https:// sau de pe localhost.');
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const res = await request<{ device: { id: string; label: string } }>('POST', '/api/admin/enroll', {
    body: { code, label, publicKey: { kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y } },
  });
  const device: StoredDevice = {
    backend: backendUrl(),
    deviceId: res.device.id,
    label: res.device.label,
    privateKey: pair.privateKey,
    createdAt: Date.now(),
  };
  await tx('readwrite', (s) => s.put(device));
}

interface AdminSession {
  backend: string;
  token: string;
  expiresAt: number;
}

function readSession(): AdminSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as AdminSession | null;
    return s && s.backend === backendUrl() && s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

export function clearAdminSession(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class NotEnrolledError extends Error {}

/**
 * Token de administrator. Dacă lipsește sau a expirat, dispozitivul se autentifică
 * automat semnând o provocare nouă de la server. Tokenul stă doar în sessionStorage
 * (dispare la închiderea filei).
 */
export async function adminToken(): Promise<string> {
  const existing = readSession();
  if (existing) return existing.token;
  const device = await getLocalDevice();
  if (!device) throw new NotEnrolledError('Acest dispozitiv nu este înregistrat ca administrator.');
  const ch = await request<{ challengeId: string; nonce: string }>('POST', '/api/admin/challenge', {
    body: { deviceId: device.deviceId },
  });
  const message = new TextEncoder().encode(`nexus-chat/admin-login/v1\n${ch.challengeId}\n${ch.nonce}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey, message);
  const signature = base64url(new Uint8Array(sig));
  const session = await request<{ token: string; expiresAt: number }>('POST', '/api/admin/login', {
    body: { deviceId: device.deviceId, challengeId: ch.challengeId, signature },
  });
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ backend: backendUrl(), ...session }));
  return session.token;
}

/** Apel API ca administrator; la 401 (sesiune expirată) se re-autentifică o singură dată. */
export async function adminRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await request<T>(method, path, { token: await adminToken(), body });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && path !== '/api/admin/login') {
      clearAdminSession();
      return request<T>(method, path, { token: await adminToken(), body });
    }
    throw err;
  }
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
