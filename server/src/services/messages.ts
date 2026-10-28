import { randomUUID } from 'node:crypto';
import { allRows, getRow, transaction } from '../db/database.ts';
import { senderOf, type Principal } from './sessions.ts';
import type { Ctx } from '../context.ts';

export interface Message {
  id: string;
  seq: number;
  roomId: string;
  senderKind: 'admin' | 'participant';
  senderId: string;
  senderName: string;
  body: string;
  createdAt: number;
}

interface MessageRow {
  seq: number;
  id: string;
  room_id: string;
  sender_kind: 'admin' | 'participant';
  sender_id: string;
  sender_name: string;
  body: string;
  created_at: number;
}

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  seq: r.seq,
  roomId: r.room_id,
  senderKind: r.sender_kind,
  senderId: r.sender_id,
  senderName: r.sender_name,
  body: r.body,
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
        'SELECT * FROM messages WHERE sender_id = ? AND client_msg_id = ?',
        sender.senderId,
        clientMsgId,
      );
      if (existing) return { message: toMessage(existing), duplicate: true };
    }
    const id = randomUUID();
    ctx.db
      .prepare(
        `INSERT INTO messages (id, room_id, sender_kind, sender_id, sender_name, body, client_msg_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, roomId, sender.senderKind, sender.senderId, sender.senderName, body, clientMsgId, ctx.now());
    return { message: toMessage(getRow<MessageRow>(ctx.db, 'SELECT * FROM messages WHERE id = ?', id)!), duplicate: false };
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
  let rows: MessageRow[];
  if (opts.afterSeq !== undefined) {
    rows = allRows<MessageRow>(
      ctx.db,
      'SELECT * FROM messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      roomId,
      opts.afterSeq,
      take,
    );
    const hasMore = rows.length > opts.limit;
    return { messages: rows.slice(0, opts.limit).map(toMessage), hasMore };
  }
  rows = allRows<MessageRow>(
    ctx.db,
    'SELECT * FROM messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
    roomId,
    opts.beforeSeq ?? Number.MAX_SAFE_INTEGER,
    take,
  );
  const hasMore = rows.length > opts.limit;
  return { messages: rows.slice(0, opts.limit).reverse().map(toMessage), hasMore };
}
