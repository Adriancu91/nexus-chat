import type { Message } from './api.ts';
import { wsUrl } from './config.ts';

export type ConnectionState =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'online' }
  | { kind: 'offline'; retryInMs: number; attempt: number }
  | { kind: 'ended'; reason: 'revoked' | 'unauthorized' | 'closed' };

export interface PresenceEntry {
  senderId: string;
  senderKind: 'admin' | 'participant';
  displayName: string;
}

export interface CallState {
  available: boolean;
  participants: { name: string; kind: 'admin' | 'participant' }[];
}

export interface PendingMessage {
  clientMsgId: string;
  body: string;
  createdAt: number;
}

export interface RoomEvents {
  state(s: ConnectionState): void;
  room(info: { id: string; name: string; closedAt: number | null }): void;
  /** Mesaje noi sau istorice; `older` = pagină de dinaintea celor afișate. */
  messages(list: Message[], opts: { older: boolean; hasMore: boolean }): void;
  confirmed(clientMsgId: string, message: Message): void;
  presence(online: PresenceEntry[]): void;
  error(message: string, code: string): void;
  /** Cine este acum în apelul camerei (și dacă serverul are apelurile configurate). */
  call(state: CallState): void;
}

type Outgoing = Record<string, unknown>;
type Incoming = { type: string; ref?: string; [k: string]: unknown };

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REVOKED = 4403;
const MAX_BACKOFF_MS = 30_000;

/**
 * Conexiunea la o cameră, cu reconectare automată.
 * - După reconectare cere doar mesajele de după ultimul `seq` primit.
 * - Mesajele trimise cât timp conexiunea e căzută stau într-o coadă și sunt retrimise
 *   cu același clientMsgId, deci serverul nu le dublează.
 * - Revocarea sesiunii oprește definitiv reconectarea.
 */
export class RoomConnection {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private attempt = 0;
  private timer: number | undefined;
  private stopped = false;
  private online = false;
  private readonly outbox = new Map<string, PendingMessage>();
  private readonly token: () => Promise<string>;
  private readonly roomId: string;
  private readonly events: RoomEvents;
  private readonly onNetwork = () => this.reconnectNow();
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.reconnectNow();
  };

  /** Apelat la 4401; dacă întoarce true (ex. tokenul de admin a fost reîmprospătat), se reîncearcă o dată. */
  private readonly onUnauthorized: (() => boolean) | undefined;
  private unauthorizedRetried = false;

  constructor(roomId: string, token: () => Promise<string>, events: RoomEvents, onUnauthorized?: () => boolean) {
    this.roomId = roomId;
    this.token = token;
    this.events = events;
    this.onUnauthorized = onUnauthorized;
  }

  start(): void {
    window.addEventListener('online', this.onNetwork);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    window.removeEventListener('online', this.onNetwork);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close(1000);
    this.ws = null;
  }

  pending(): PendingMessage[] {
    return [...this.outbox.values()];
  }

  send(body: string): PendingMessage {
    const msg: PendingMessage = { clientMsgId: newClientMsgId(), body, createdAt: Date.now() };
    this.outbox.set(msg.clientMsgId, msg);
    if (this.online) this.transmit(msg);
    return msg;
  }

  loadOlder(beforeSeq: number): void {
    this.raw({ type: 'history', roomId: this.roomId, beforeSeq, ref: 'older' });
  }

  private transmit(m: PendingMessage): void {
    this.raw({ type: 'send', roomId: this.roomId, body: m.body, clientMsgId: m.clientMsgId, ref: m.clientMsgId });
  }

  private raw(msg: Outgoing): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private reconnectNow(): void {
    if (this.stopped || this.ws) return;
    clearTimeout(this.timer);
    this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.attempt++;
    this.events.state({ kind: 'connecting', attempt: this.attempt });
    let token: string;
    try {
      token = await this.token();
    } catch {
      return this.scheduleRetry();
    }
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl());
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (ev) => {
      let msg: Incoming;
      try {
        msg = JSON.parse(String(ev.data)) as Incoming;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.online = false;
      if (this.stopped) return;
      if (ev.code === CLOSE_REVOKED) return this.end('revoked');
      if (ev.code === CLOSE_UNAUTHORIZED) {
        if (this.onUnauthorized && !this.unauthorizedRetried && this.onUnauthorized()) {
          this.unauthorizedRetried = true;
          return this.scheduleRetry();
        }
        return this.end('unauthorized');
      }
      this.scheduleRetry();
    };
  }

  private subscribe(): void {
    this.raw({ type: 'subscribe', roomId: this.roomId, afterSeq: this.lastSeq > 0 ? this.lastSeq : undefined, ref: 'sub' });
  }

  private handle(msg: Incoming): void {
    switch (msg.type) {
      case 'ready':
        return this.subscribe();
      case 'history': {
        const list = (msg.messages as Message[]) ?? [];
        const hasMore = Boolean(msg.hasMore);
        if (msg.room) this.events.room(msg.room as { id: string; name: string; closedAt: number | null });
        if (msg.ref === 'older') return this.events.messages(list, { older: true, hasMore });
        this.track(list);
        // Prima încărcare: ultimele mesaje (hasMore = există mai vechi).
        // După reconectare: mesajele lipsă (hasMore = mai urmează o pagină).
        const catchingUp = this.lastSeqBefore > 0;
        this.events.messages(list, { older: false, hasMore: catchingUp ? false : hasMore });
        if (catchingUp && hasMore) return this.subscribe();
        this.lastSeqBefore = this.lastSeq;
        if (!this.online) {
          this.online = true;
          this.attempt = 0;
          this.unauthorizedRetried = false;
          this.events.state({ kind: 'online' });
          for (const m of this.outbox.values()) this.transmit(m);
        }
        return;
      }
      case 'message': {
        const m = msg.message as Message;
        if (m.seq <= this.lastSeq) return;
        this.track([m]);
        this.lastSeqBefore = this.lastSeq;
        return this.events.messages([m], { older: false, hasMore: false });
      }
      case 'ack': {
        const m = msg.message as Message;
        const id = msg.clientMsgId as string | null;
        if (id && this.outbox.delete(id)) this.events.confirmed(id, m);
        return;
      }
      case 'call':
        return this.events.call({
          available: Boolean(msg.available),
          participants: (msg.participants as CallState['participants']) ?? [],
        });
      case 'presence':
        return this.events.presence((msg.online as PresenceEntry[]) ?? []);
      case 'error': {
        const code = String(msg.code ?? 'error');
        // Un mesaj respins definitiv (ex. prea lung) nu mai rămâne în coadă.
        if (msg.ref && this.outbox.has(msg.ref) && code !== 'rate_limited') this.outbox.delete(msg.ref);
        if (msg.ref && code === 'rate_limited' && this.outbox.has(msg.ref)) {
          const m = this.outbox.get(msg.ref)!;
          window.setTimeout(() => this.online && this.outbox.has(m.clientMsgId) && this.transmit(m), 3000);
        }
        return this.events.error(String(msg.message ?? 'Eroare.'), code);
      }
    }
  }

  /** seq-ul confirmat înainte de ultima reconectare; 0 = prima încărcare. */
  private lastSeqBefore = 0;

  private track(list: Message[]): void {
    for (const m of list) if (m.seq > this.lastSeq) this.lastSeq = m.seq;
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt - 1, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.events.state({ kind: 'offline', retryInMs: delay, attempt: this.attempt });
    this.timer = window.setTimeout(() => this.connect(), delay);
  }

  private end(reason: 'revoked' | 'unauthorized' | 'closed'): void {
    this.stopped = true;
    this.events.state({ kind: 'ended', reason });
  }
}

function newClientMsgId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
