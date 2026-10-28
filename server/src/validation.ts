import { badRequest } from './errors.ts';

// Caractere de control (în afară de tab/linie nouă) și caractere de suprascriere bidirecțională,
// folosite pentru a falsifica afișarea numelor sau a textului.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const BIDI = /[‪-‮⁦-⁩‎‏]/g;

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('invalid_body', 'Corpul cererii trebuie să fie un obiect JSON.');
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') throw badRequest('invalid_field', `Câmpul „${key}” lipsește sau nu este text.`);
  return v;
}

/** Nume afișat sau nume de cameră: o singură linie, fără caractere de control, spații comprimate. */
export function cleanLabel(obj: Record<string, unknown>, key: string, maxChars: number): string {
  const value = requireString(obj, key)
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length === 0) throw badRequest('invalid_field', `Câmpul „${key}” nu poate fi gol.`);
  if ([...value].length > maxChars) throw badRequest('invalid_field', `Câmpul „${key}” depășește ${maxChars} caractere.`);
  return value;
}

export function cleanMessageBody(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') throw badRequest('invalid_field', 'Mesajul trebuie să fie text.');
  const body = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(BIDI, '').trim();
  if (body.length === 0) throw badRequest('empty_message', 'Mesajul este gol.');
  if ([...body].length > maxChars) throw badRequest('message_too_long', `Mesajul depășește ${maxChars} caractere.`);
  return body;
}

export function password(obj: Record<string, unknown>, key: string, min: number, max: number): string {
  const v = requireString(obj, key);
  if ([...v].length < min) throw badRequest('weak_password', `Parola trebuie să aibă cel puțin ${min} caractere.`);
  if ([...v].length > max) throw badRequest('invalid_field', `Parola depășește ${max} caractere.`);
  return v;
}

/** Text simplu, mărginit, fără normalizare — pentru coduri, identificatori, semnături. */
export function token(obj: Record<string, unknown>, key: string, maxLen = 200): string {
  const v = requireString(obj, key);
  if (v.length === 0 || v.length > maxLen) throw badRequest('invalid_field', `Câmpul „${key}” este invalid.`);
  return v;
}

export function optionalInt(obj: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw badRequest('invalid_field', `Câmpul „${key}” trebuie să fie un număr întreg între ${min} și ${max}.`);
  }
  return v;
}

export function optionalBool(obj: Record<string, unknown>, key: string): boolean | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw badRequest('invalid_field', `Câmpul „${key}” trebuie să fie true sau false.`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** Identificator generat de client pentru deduplicarea mesajelor retrimise după reconectare. */
export function optionalClientMsgId(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    throw badRequest('invalid_field', 'clientMsgId invalid.');
  }
  return v;
}
