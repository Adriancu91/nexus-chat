import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { allRows, getRow, transaction } from '../db/database.ts';
import { HttpError } from '../errors.ts';
import { audit } from './audit.ts';
import { messageFromRow, MESSAGE_SELECT, type Message, type MessageRow } from './messages.ts';
import { senderOf, type Principal } from './sessions.ts';
import type { Config } from '../config.ts';
import type { Ctx } from '../context.ts';

export const FILES_DIR = 'files';
export const TMP_DIR = 'tmp';

export interface StoredFile {
  id: string;
  roomId: string;
  storageKey: string;
  name: string;
  mime: string;
  inlineSafe: boolean;
  size: number;
  sha256: string;
}

/** Calea pe disc. `storageKey` provine exclusiv din baza de date (generat de server). */
export function storedFilePath(config: Config, storageKey: string): string {
  return path.join(config.dataDir, FILES_DIR, ...storageKey.split('/'));
}

export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

// ---- nume și tipuri ----

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Nume afișat și propus la descărcare. Nu este folosit niciodată ca nume de fișier pe disc. */
export function sanitizeFileName(raw: string): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if ([...name].length > 150) {
    const ext = path.extname(name).slice(0, 16);
    name = [...name.slice(0, name.length - ext.length)].slice(0, 150 - ext.length).join('') + ext;
  }
  return name || 'fisier';
}

/** Extensii refuzate: programe și scripturi care se pot executa cu un dublu-clic pe Windows. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'msix', 'appx', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'cpl', 'dll', 'sys', 'lnk', 'reg', 'jar', 'scf', 'inf', 'gadget', 'application', 'iso', 'img', 'vhd', 'vhdx',
]);

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
};

/** Semnăturile binare ale imaginilor care pot fi afișate direct în chat. */
function isRasterImage(mime: string, head: Buffer): boolean {
  switch (mime) {
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif':
      return head.subarray(0, 4).toString('latin1') === 'GIF8';
    case 'image/webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    default:
      return false;
  }
}

export function classifyFile(name: string, head: Buffer): { mime: string; inlineSafe: boolean } {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new HttpError(415, 'file_type_blocked', `Fișierele .${ext} nu sunt permise (pot conține programe).`);
  }
  // Executabil Windows deghizat sub alt nume (ex. „poza.jpg” care e de fapt .exe).
  if (head[0] === 0x4d && head[1] === 0x5a) {
    throw new HttpError(415, 'file_type_blocked', 'Fișierul conține un program executabil și nu este permis.');
  }
  const declared = MIME_BY_EXT[ext];
  if (declared?.startsWith('image/') && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(declared)) {
    // Conținutul trebuie să corespundă extensiei; altfel e tratat ca fișier generic.
    return isRasterImage(declared, head) ? { mime: declared, inlineSafe: true } : { mime: 'application/octet-stream', inlineSafe: false };
  }
  return { mime: declared ?? 'application/octet-stream', inlineSafe: false };
}

// ---- primire upload ----

export interface ReceivedUpload {
  tmpPath: string;
  size: number;
  sha256: string;
  head: Buffer;
}

/**
 * Scrie corpul cererii într-un fișier temporar, calculând SHA-256 în timpul transferului.
 * Dacă transferul e întrerupt sau depășește limitele, fișierul temporar este șters.
 */
export async function receiveUpload(ctx: Ctx, req: IncomingMessage): Promise<ReceivedUpload> {
  const { limits } = ctx.config;
  const lengthHeader = req.headers['content-length'];
  const expected = Number(lengthHeader);
  if (lengthHeader === undefined || !Number.isInteger(expected) || expected < 0) {
    throw new HttpError(411, 'length_required', 'Dimensiunea fișierului lipsește din cerere.');
  }
  if (expected === 0) throw new HttpError(400, 'empty_file', 'Fișierul este gol.');
  if (expected > limits.maxFileBytes) {
    throw new HttpError(413, 'file_too_large', `Fișierul depășește limita de ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB.`);
  }
  const free = await freeDiskBytes(ctx.config.dataDir);
  if (free !== null && free - expected < limits.minFreeDiskBytes) {
    throw new HttpError(507, 'insufficient_storage', 'Nu mai este suficient spațiu pe discul laptopului gazdă.');
  }

  const tmpDir = path.join(ctx.config.dataDir, TMP_DIR);
  await fs.promises.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `${randomUUID()}.part`);
  const out = fs.createWriteStream(tmpPath, { flags: 'wx' });
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headLen = 0;
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > expected) throw new HttpError(400, 'size_mismatch', 'Fișierul primit nu corespunde dimensiunii anunțate.');
      hash.update(chunk);
      if (headLen < 16) {
        headChunks.push(chunk.subarray(0, 16 - headLen));
        headLen += Math.min(chunk.length, 16 - headLen);
      }
      if (!out.write(chunk)) await once(out, 'drain');
    }
    if (size !== expected) throw new HttpError(400, 'upload_incomplete', 'Transferul fișierului a fost întrerupt.');
    out.end();
    await once(out, 'finish');
    // Datele ajung fizic pe disc înainte ca fișierul să fie înregistrat în arhivă.
    const fh = await fs.promises.open(tmpPath, 'r+');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { tmpPath, size, sha256: hash.digest('hex'), head: Buffer.concat(headChunks) };
  } catch (err) {
    out.destroy();
    await fs.promises.rm(tmpPath, { force: true });
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'upload_incomplete', 'Transferul fișierului a fost întrerupt.');
  }
}

/** Mută fișierul în arhivă și creează mesajul care îl conține, într-o singură tranzacție. */
export async function commitUpload(
  ctx: Ctx,
  principal: Principal,
  roomId: string,
  upload: ReceivedUpload,
  rawName: string,
  caption: string,
): Promise<Message> {
  const name = sanitizeFileName(rawName);
  let type: { mime: string; inlineSafe: boolean };
  try {
    type = classifyFile(name, upload.head);
  } catch (err) {
    await fs.promises.rm(upload.tmpPath, { force: true });
    throw err;
  }
  const id = randomUUID();
  const storageKey = `${id.slice(0, 2)}/${id}`;
  const finalPath = storedFilePath(ctx.config, storageKey);
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.promises.rename(upload.tmpPath, finalPath);
  const sender = senderOf(principal);
  try {
    return transaction(ctx.db, () => {
      const now = ctx.now();
      ctx.db
        .prepare(
          `INSERT INTO files (id, room_id, storage_key, original_name, mime, inline_safe, size, sha256, uploader_kind, uploader_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, roomId, storageKey, name, type.mime, type.inlineSafe ? 1 : 0, upload.size, upload.sha256, sender.senderKind, sender.senderId, now);
      const messageId = randomUUID();
      ctx.db
        .prepare(
          `INSERT INTO messages (id, room_id, sender_kind, sender_id, sender_name, body, file_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(messageId, roomId, sender.senderKind, sender.senderId, sender.senderName, caption, id, now);
      return messageFromRow(getRow<MessageRow>(ctx.db, `${MESSAGE_SELECT} WHERE m.id = ?`, messageId)!);
    });
  } catch (err) {
    await fs.promises.rm(finalPath, { force: true });
    throw err;
  }
}

// ---- citire ----

interface FileRow {
  id: string;
  room_id: string;
  storage_key: string;
  original_name: string;
  mime: string;
  inline_safe: number;
  size: number;
  sha256: string;
}

const toStored = (r: FileRow): StoredFile => ({
  id: r.id,
  roomId: r.room_id,
  storageKey: r.storage_key,
  name: r.original_name,
  mime: r.mime,
  inlineSafe: r.inline_safe === 1,
  size: r.size,
  sha256: r.sha256,
});

export function getFile(ctx: Ctx, fileId: string): StoredFile | undefined {
  const row = getRow<FileRow>(ctx.db, 'SELECT * FROM files WHERE id = ?', fileId);
  return row && toStored(row);
}

/** Mesajele cu fișiere dintr-o cameră, cele mai noi primele. */
export function listRoomFiles(ctx: Ctx, roomId: string, limit: number, beforeSeq?: number): { messages: Message[]; hasMore: boolean } {
  const rows = allRows<MessageRow>(
    ctx.db,
    `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.file_id IS NOT NULL AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
    roomId,
    beforeSeq ?? Number.MAX_SAFE_INTEGER,
    limit + 1,
  );
  return { messages: rows.slice(0, limit).map(messageFromRow), hasMore: rows.length > limit };
}

export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---- ștergere și curățenie ----

/** Șterge de pe disc fișiere deja eliminate din baza de date. Erorile sunt doar raportate. */
export async function removeStoredFiles(config: Config, storageKeys: string[]): Promise<void> {
  for (const key of storageKeys) {
    try {
      await fs.promises.rm(storedFilePath(config, key), { force: true });
    } catch (err) {
      console.error(`[fișiere] nu am putut șterge ${key}:`, err);
    }
  }
}

export function storageKeysForRoom(ctx: Ctx, roomId: string): string[] {
  return allRows<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM files WHERE room_id = ?', roomId).map((r) => r.storage_key);
}

/**
 * La pornire: șterge transferurile neterminate (tmp/) și fișierele rămase pe disc fără
 * înregistrare în baza de date (ex. cădere de curent între mutare și tranzacție).
 */
export async function sweepStorage(ctx: Ctx, minAgeMs = 60 * 60_000): Promise<{ tmpRemoved: number; orphansRemoved: number }> {
  let tmpRemoved = 0;
  let orphansRemoved = 0;
  const tmpDir = path.join(ctx.config.dataDir, TMP_DIR);
  for (const entry of await fs.promises.readdir(tmpDir).catch(() => [] as string[])) {
    await fs.promises.rm(path.join(tmpDir, entry), { force: true, recursive: true });
    tmpRemoved++;
  }
  const known = new Set(allRows<{ storage_key: string }>(ctx.db, 'SELECT storage_key FROM files').map((r) => r.storage_key));
  const root = path.join(ctx.config.dataDir, FILES_DIR);
  const now = Date.now();
  for (const prefix of await fs.promises.readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, prefix);
    for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (known.has(`${prefix}/${name}`)) continue;
      const full = path.join(dir, name);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (stat && now - stat.mtimeMs >= minAgeMs) {
        await fs.promises.rm(full, { force: true });
        orphansRemoved++;
      }
    }
  }
  if (orphansRemoved > 0) audit(ctx, 'system', 'archive.orphans_removed', undefined, { count: orphansRemoved });
  return { tmpRemoved, orphansRemoved };
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
