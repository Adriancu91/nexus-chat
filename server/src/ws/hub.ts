import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { HttpError } from '../errors.ts';
import { isOriginAllowed } from '../http/http.ts';
import { requireRoomAccess } from '../services/access.ts';
import { listMessages, storeMessage } from '../services/messages.ts';
import { RateLimiter } from '../services/rateLimiter.ts';
import { touchParticipant } from '../services/rooms.ts';
import {
  authenticateHash,
  authenticateToken,
  publicPrincipal,
  senderOf,
  type Principal,
} from '../services/sessions.ts';
import { cleanMessageBody, optionalClientMsgId } from '../validation.ts';
import type { Ctx } from '../context.ts';

/** Coduri de închidere WebSocket specifice aplicației (interval 4000–4999). */
export const CloseCode = {
  Unauthorized: 4401,
  Revoked: 4403,
  AuthTimeout: 4408,
  ServerShutdown: 1001,
} as const;

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const HISTORY_LIMIT = 100;

interface Client {
  ws: WebSocket;
  principal: Principal | null;
  rooms: Set<string>;
  alive: boolean;
  authTimer: NodeJS.Timeout | undefined;
}

type Incoming = Record<string, unknown> & { type?: unknown };

/**
 * Canalul în timp real. Protocol JSON:
 *   client → server: auth, subscribe, unsubscribe, send, history, ping
 *   server → client: ready, history, message, ack, presence, error, pong
 * Tokenul se trimite în primul mesaj (nu în URL), ca să nu apară în jurnalele proxy-urilor.
 */
export class Hub {
  private readonly ctx: Ctx;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly sendLimiter: RateLimiter;
  private readonly heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: ctx.config.limits.wsMaxPayloadBytes });
    this.sendLimiter = new RateLimiter(ctx.config.limits.messagesPerWindow, ctx.config.limits.messageWindowMs, ctx.now);
    this.heartbeat = setInterval(() => this.checkAlive(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== '/ws') return reject(404, 'Not Found');
    // Browserele trimit mereu Origin la WebSocket; o pagină străină nu se poate conecta.
    if (!isOriginAllowed(this.ctx.config, req.headers.origin)) return reject(403, 'Forbidden');
    if (this.clients.size >= this.ctx.config.limits.maxWsConnections) return reject(503, 'Service Unavailable');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, principal: null, rooms: new Set(), alive: true, authTimer: undefined };
    this.clients.add(client);
    client.authTimer = setTimeout(() => ws.close(CloseCode.AuthTimeout, 'auth timeout'), AUTH_TIMEOUT_MS);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      client.alive = true;
      if (isBinary) return this.error(client, 'unsupported', 'Se acceptă doar mesaje text JSON.');
      this.onMessage(client, data);
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', () => ws.terminate());
  }

  private onMessage(client: Client, data: RawData): void {
    let msg: Incoming;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      msg = parsed as Incoming;
    } catch {
      return this.error(client, 'invalid_json', 'Mesaj JSON invalid.');
    }
    const ref = typeof msg.ref === 'string' ? msg.ref.slice(0, 64) : undefined;
    try {
      if (msg.type === 'ping') return this.send(client, { type: 'pong', ref });
      if (msg.type === 'auth') return this.onAuth(client, msg);
      const principal = this.revalidate(client);
      if (!principal) return;
      switch (msg.type) {
        case 'subscribe':
          return this.onSubscribe(client, principal, msg, ref);
        case 'unsubscribe':
          if (typeof msg.roomId === 'string' && client.rooms.delete(msg.roomId)) this.broadcastPresence(msg.roomId);
          return;
        case 'history':
          return this.onHistory(client, principal, msg, ref);
        case 'send':
          return this.onSend(client, principal, msg, ref);
        default:
          return this.error(client, 'unknown_type', 'Tip de mesaj necunoscut.', ref);
      }
    } catch (err) {
      if (err instanceof HttpError) return this.error(client, err.code, err.message, ref);
      console.error('[ws] eroare internă:', err);
      return this.error(client, 'internal_error', 'Eroare internă.', ref);
    }
  }

  private onAuth(client: Client, msg: Incoming): void {
    if (client.principal) return this.error(client, 'already_authenticated', 'Conexiunea este deja autentificată.');
    const principal = authenticateToken(this.ctx, msg.token);
    if (!principal) {
      this.error(client, 'unauthorized', 'Sesiune invalidă sau expirată.');
      client.ws.close(CloseCode.Unauthorized, 'unauthorized');
      return;
    }
    clearTimeout(client.authTimer);
    client.principal = principal;
    if (principal.kind === 'participant') touchParticipant(this.ctx, principal.participantId);
    this.send(client, { type: 'ready', principal: publicPrincipal(principal) });
  }

  /** Re-verifică sesiunea la fiecare operațiune: revocarea are efect imediat, nu doar la reconectare. */
  private revalidate(client: Client): Principal | null {
    if (!client.principal) {
      this.error(client, 'unauthorized', 'Trimite mai întâi mesajul de autentificare.');
      return null;
    }
    const fresh = authenticateHash(this.ctx, client.principal.tokenHash);
    if (!fresh) {
      this.error(client, 'session_revoked', 'Sesiunea a expirat sau a fost revocată.');
      client.ws.close(CloseCode.Revoked, 'session revoked');
      return null;
    }
    client.principal = fresh;
    return fresh;
  }

  private onSubscribe(client: Client, principal: Principal, msg: Incoming, ref: string | undefined): void {
    const room = requireRoomAccess(this.ctx, principal, msg.roomId, { write: false });
    const afterSeq = typeof msg.afterSeq === 'number' && Number.isInteger(msg.afterSeq) && msg.afterSeq >= 0 ? msg.afterSeq : undefined;
    const page = listMessages(this.ctx, room.id, { afterSeq, limit: HISTORY_LIMIT });
    client.rooms.add(room.id);
    this.send(client, { type: 'history', ref, roomId: room.id, room: { id: room.id, name: room.name, closedAt: room.closedAt }, ...page });
    this.broadcastPresence(room.id);
  }

  private onHistory(client: Client, principal: Principal, msg: Incoming, ref: string | undefined): void {
    const room = requireRoomAccess(this.ctx, principal, msg.roomId, { write: false });
    const beforeSeq = typeof msg.beforeSeq === 'number' && Number.isInteger(msg.beforeSeq) ? msg.beforeSeq : undefined;
    const page = listMessages(this.ctx, room.id, { beforeSeq, limit: HISTORY_LIMIT });
    this.send(client, { type: 'history', ref, roomId: room.id, ...page });
  }

  private onSend(client: Client, principal: Principal, msg: Incoming, ref: string | undefined): void {
    const room = requireRoomAccess(this.ctx, principal, msg.roomId, { write: true });
    const body = cleanMessageBody(msg.body, this.ctx.config.limits.messageMaxChars);
    const clientMsgId = optionalClientMsgId(msg.clientMsgId);
    if (!this.sendLimiter.hit(principal.sessionId)) {
      throw new HttpError(429, 'rate_limited', 'Trimiți mesaje prea repede. Așteaptă câteva secunde.');
    }
    const { message, duplicate } = storeMessage(this.ctx, principal, room.id, body, clientMsgId);
    this.send(client, { type: 'ack', ref, clientMsgId, message });
    if (!duplicate) this.broadcast(room.id, { type: 'message', message });
  }

  broadcast(roomId: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const c of this.clients) {
      if (c.principal && c.rooms.has(roomId) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private broadcastPresence(roomId: string): void {
    const online = new Map<string, { senderId: string; senderKind: string; displayName: string }>();
    for (const c of this.clients) {
      if (!c.principal || !c.rooms.has(roomId)) continue;
      const s = senderOf(c.principal);
      online.set(s.senderId, { senderId: s.senderId, senderKind: s.senderKind, displayName: s.senderName });
    }
    this.broadcast(roomId, { type: 'presence', roomId, online: [...online.values()] });
  }

  /** Închide imediat conexiunile ale căror sesiuni nu mai sunt valide (după revocare, închiderea camerei etc.). */
  disconnectInvalid(): void {
    for (const c of this.clients) {
      if (c.principal && !authenticateHash(this.ctx, c.principal.tokenHash)) {
        this.send(c, { type: 'error', code: 'session_revoked', message: 'Accesul a fost revocat.' });
        c.ws.close(CloseCode.Revoked, 'session revoked');
      }
    }
  }

  private onClose(client: Client): void {
    clearTimeout(client.authTimer);
    this.clients.delete(client);
    if (this.closed) return; // baza de date poate fi deja închisă la oprirea serverului
    if (client.principal?.kind === 'participant') touchParticipant(this.ctx, client.principal.participantId);
    for (const roomId of client.rooms) this.broadcastPresence(roomId);
  }

  private checkAlive(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }

  private send(client: Client, payload: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
  }

  private error(client: Client, code: string, message: string, ref?: string): void {
    this.send(client, { type: 'error', ref, code, message });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.close(CloseCode.ServerShutdown, 'server shutdown');
    this.wss.close();
  }
}
