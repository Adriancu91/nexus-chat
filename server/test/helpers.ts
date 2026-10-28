import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type ConfigOverrides } from '../src/config.ts';
import { ensureBootstrapCode } from '../src/services/admin.ts';

export const TEST_ORIGIN = 'https://nexus.test';

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-'));
}

export interface TestServer {
  app: App;
  base: string;
  wsUrl: string;
  dataDir: string;
  bootstrapCode: string | null;
  stop(): Promise<void>;
}

export async function startServer(opts: { dataDir?: string; overrides?: ConfigOverrides } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? tempDir();
  const config = loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', allowedOrigins: [TEST_ORIGIN], ...opts.overrides });
  const app = createApp(config);
  const addr = await app.listen();
  const bootstrap = ensureBootstrapCode(app.ctx);
  return {
    app,
    base: `http://127.0.0.1:${addr.port}`,
    wsUrl: `ws://127.0.0.1:${addr.port}/ws`,
    dataDir,
    bootstrapCode: bootstrap?.code ?? null,
    stop: () => app.close(),
  };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function api<T = any>(
  base: string,
  method: string,
  pathname: string,
  opts: { token?: string; body?: unknown; origin?: string } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.origin) headers.Origin = opts.origin;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

/** Simulează exact ce face browserul: cheie ECDSA P-256 generată cu WebCrypto. */
export async function newDeviceKey() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    publicJwk,
    async sign(message: string): Promise<string> {
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message));
      return Buffer.from(sig).toString('base64url');
    },
  };
}

export type DeviceKey = Awaited<ReturnType<typeof newDeviceKey>>;

export async function adminLogin(base: string, deviceId: string, key: DeviceKey): Promise<ApiResult> {
  const ch = await api(base, 'POST', '/api/admin/challenge', { body: { deviceId } });
  const signature = await key.sign(`nexus-chat/admin-login/v1\n${ch.body.challengeId}\n${ch.body.nonce}`);
  return api(base, 'POST', '/api/admin/login', { body: { deviceId, challengeId: ch.body.challengeId, signature } });
}

/** Înrolează un dispozitiv cu codul de inițializare și întoarce un token de administrator. */
export async function setupAdmin(srv: TestServer) {
  const key = await newDeviceKey();
  const enroll = await api(srv.base, 'POST', '/api/admin/enroll', {
    body: { code: srv.bootstrapCode, publicKey: key.publicJwk, label: 'Laptop' },
  });
  if (enroll.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(enroll.body)}`);
  const deviceId: string = enroll.body.device.id;
  const login = await adminLogin(srv.base, deviceId, key);
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return { deviceId, key, token: login.body.token as string };
}

export async function createRoom(srv: TestServer, adminToken: string, name = 'Familia', password = 'parola-sigura-123') {
  const res = await api(srv.base, 'POST', '/api/admin/rooms', { token: adminToken, body: { name, password } });
  if (res.status !== 201) throw new Error(`createRoom failed: ${JSON.stringify(res.body)}`);
  return { room: res.body.room as { id: string; code: string; name: string }, password };
}

export async function joinRoom(srv: TestServer, code: string, password: string, displayName: string) {
  return api(srv.base, 'POST', '/api/rooms/join', { body: { code, password, displayName } });
}

export class WsClient {
  readonly ws: WebSocket;
  private readonly buffer: any[] = [];
  private readonly waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.buffer.push(msg);
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  }

  static connect(url: string, origin: string | undefined = TEST_ORIGIN): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin ? { origin } : {});
      const client = new WsClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  static async authed(url: string, token: string): Promise<WsClient> {
    const c = await WsClient.connect(url);
    c.send({ type: 'auth', token });
    await c.next((m) => m.type === 'ready');
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const i = this.buffer.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.buffer.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve: (m: any) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error('timeout waiting for ws message; buffered: ' + JSON.stringify(this.buffer)));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Verifică că niciun mesaj potrivit nu sosește într-un interval scurt. */
  async expectNone(pred: (m: any) => boolean, ms = 300): Promise<void> {
    try {
      const m = await this.next(pred, ms);
      throw new Error('unexpected ws message: ' + JSON.stringify(m));
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('timeout')) throw err;
    }
  }

  close(): void {
    this.ws.close();
  }
}
