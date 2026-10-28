import { randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from '../db/database.ts';
import { senderOf, type Principal } from './sessions.ts';
import type { Ctx } from '../context.ts';

export interface MessageFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** Imagine verificată, care poate fi previzualizată în chat. */
  previewable: boolean;
  sha256: string;
}

export interface Message {
  id: string;
  seq: number;
  roomId: string;
  senderKind: 'admin' | 'participant';
  senderId: string;
  senderName: string;
  body: string;
  file: MessageFile | null;
  createdAt: number;
}

export interface MessageRow {
  seq: number;
  id: string;
  room_id: string;
  sender_kind: 'admin' | 'participant';
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: number;
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  file_inline: number | null;
  file_sha256: string | null;
}

const MESSAGE_COLUMNS = `m.seq, m.id, m.room_id, m.sender_kind, m.sender_id, m.sender_name, m.body, m.created_at,
  m.file_id, f.original_name AS file_name, f.size AS file_size, f.mime AS file_mime, f.inline_safe AS file_inline, f.sha256 AS file_sha256`;

export const MESSAGE_SELECT = `SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN files f ON f.id = m.file_id`;

export const messageFromRow = (r: MessageRow): Message => ({
  id: r.id,
  seq: r.seq,
  roomId: r.room_id,
  senderKind: r.sender_kind,
  senderId: r.sender_id,
  senderName: r.sender_name,
  body: r.body,
  file: r.file_id
    ? {
        id: r.file_id,
        name: r.file_name ?? '',
        size: r.file_size ?? 0,
        mime: r.file_mime ?? 'application/octet-stream',
        previewable: r.file_inline === 1,
        sha256: r.file_sha256 ?? '',
      }
    : null,
  createdAt: r.created_at,
});

/**
 * Salvează mesajul în arhivă înainte de a fi distribuit. Dacă un client retrimite
 * același clientMsgId (ex. după reconectare), se întoarce mesajul existent.
 */
export function storeMessage(
  ctx: Ctx,
  principal: Principal,
  roomId: string,
  body: string,
  clientMsgId: string | null,
): { message: Message; duplicate: boolean } {
  const sender = senderOf(principal);
  return transaction(ctx.db, () => {
    if (clientMsgId) {
      const existing = getRow<MessageRow>(
        ctx.db,
        `${MESSAGE_SELECT} WHERE m.sender_id = ? AND m.client_msg_id = ?`,
        sender.senderId,
        clientMsgId,
      );
      if (existing) return { message: messageFromRow(existing), duplicate: true };
    }
    const id = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO messages (id, room_id, sender_kind, sender_id, sender_name, body, client_msg_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, roomId, sender.senderKind, sender.senderId, sender.senderName, body, clientMsgId, ctx.now());
    return { message: messageFromRow(getRow<MessageRow>(ctx.db, `${MESSAGE_SELECT} WHERE m.id = ?`, id)!), duplicate: false };
  });
}

export interface HistoryPage {
  messages: Message[];
  hasMore: boolean;
}

/**
 * Istoric paginat după numărul de secvență:
 * - afterSeq: mesajele noi de după o reconectare (ordine crescătoare);
 * - altfel: ultimele mesaje dinainte de beforeSeq (pentru derulare în trecut).
 */
export function listMessages(
  ctx: Ctx,
  roomId: string,
  opts: { afterSeq?: number | undefined; beforeSeq?: number | undefined; limit: number },
): HistoryPage {
  const take = opts.limit + 1;
  if (opts.afterSeq !== undefined) {
    const rows = allRows<MessageRow>(
      ctx.db,
      `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`,
      roomId,
      opts.afterSeq,
      take,
    );
    return { messages: rows.slice(0, opts.limit).map(messageFromRow), hasMore: rows.length > opts.limit };
  }
  const rows = allRows<MessageRow>(
    ctx.db,
    `${MESSAGE_SELECT} WHERE m.room_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
    roomId,
    opts.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    take,
  );
  return { messages: rows.slice(0, opts.limit).reverse().map(messageFromRow), hasMore: rows.length > opts.limit };
}

export interface SearchHit {
  message: Message;
  /** Fragment cu termenii găsiți încadrați de \u0001 … \u0002 (clientul îi evidențiază ca text). */
  snippet: string;
}

/**
 * Căutare full-text în istoricul unei camere. Textul utilizatorului este redus la cuvinte
 * și fiecare cuvânt este pus între ghilimele, deci sintaxa FTS5 nu poate fi injectată.
 */
export function searchMessages(ctx: Ctx, roomId: string, query: string, limit: number): SearchHit[] {
  const words = (query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8).map((w) => w.slice(0, 40));
  if (words.length === 0) return [];
  const match = words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
  const rows = allRows<MessageRow & { snip: string }>(
    ctx.db,
    `SELECT ${MESSAGE_COLUMNS}, snippet(messages_fts, -1, char(1), char(2), '…', 12) AS snip
       FROM messages_fts
       JOIN messages m ON m.seq = messages_fts.rowid
       LEFT JOIN files f ON f.id = m.file_id
      WHERE messages_fts MATCH ? AND m.room_id = ?
      ORDER BY m.seq DESC LIMIT ?`,
    match,
    roomId,
    limit,
  );
  return rows.map((r) => ({ message: messageFromRow(r), snippet: r.snip }));
}
