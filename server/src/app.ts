import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { CallService } from './calls/calls.ts';
import { ensureLiveKitKeys, LiveKitProcess, liveKitYaml, RoomServiceClient } from './calls/livekit.ts';
import { defaultGateway, PortMapper } from './calls/natpmp.ts';
import { isRtcPath, proxyRtcHttp, proxyRtcUpgrade } from './calls/proxy.ts';
import { openDatabase } from './db/database.ts';
import { HttpError } from './errors.ts';
import { bearerToken, clientIp, corsHeaders, isOriginAllowed, readJson, sendReply } from './http/http.ts';
import { buildRouter } from './http/routes.ts';
import { authenticateToken } from './services/sessions.ts';
import { Hub } from './ws/hub.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';

export interface App {
  ctx: Ctx;
  hub: Hub;
  calls: CallService;
  server: http.Server;
  listen(): Promise<AddressInfo>;
  /** Pornește serverul media LiveKit (dacă e configurat). Se apelează după listen(). */
  startCalls(): Promise<boolean>;
  /** Starea drumului media din internet (porturi deschise în router). */
  callsNetwork(): { portMapping: string; active: boolean; externalIp: string | null; error: string | null };
  close(): Promise<void>;
}

export function openDataDir(config: Config): DatabaseSync {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return openDatabase(path.join(config.dataDir, 'nexus.db'));
}

const WEBHOOK_PATH = '/internal/livekit/webhook';

async function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', 'Cererea este prea mare.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createApp(config: Config, now: () => number = Date.now): App {
  const db = openDataDir(config);
  const ctx: Ctx = { db, config, now };
  const hub = new Hub(ctx);

  const livekitBin = config.calls.livekitBinary;
  const keys = livekitBin ? ensureLiveKitKeys(config.dataDir) : null;
  const calls = new CallService(
    ctx,
    keys ? { keys, rooms: new RoomServiceClient(`http://127.0.0.1:${config.calls.httpPort}`, keys) } : null,
  );
  calls.onState = (state) => hub.broadcast(state.roomId, { type: 'call', ...state });
  hub.callState = (roomId) => calls.state(roomId);
  hub.onInvalidated = () => void calls.kickInvalid();
  calls.network = () => ({
    portMapping: config.calls.portMapping,
    active: mapper?.status.active ?? false,
    externalIp: mapper?.status.externalIp ?? config.calls.nodeIp,
    error: mapper?.status.error ?? mapperError,
  });
  let livekit: LiveKitProcess | null = null;
  let mapper: PortMapper | null = null;
  let mapperError: string | null = null;

  const router = buildRouter(ctx, hub, calls);

  const server = http.createServer(async (req, res) => {
    const cors = corsHeaders(config, req.headers.origin);
    try {
      if (cors === null) throw new HttpError(403, 'origin_not_allowed', 'Originea nu este permisă.');
      if (req.method === 'OPTIONS') return sendReply(res, { status: 204 }, cors);
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === WEBHOOK_PATH && req.method === 'POST') {
        const ok = await calls.handleWebhook(await readRaw(req, 64 * 1024), req.headers.authorization);
        return sendReply(res, { status: ok ? 200 : 401, body: { ok } });
      }
      if (isRtcPath(url.pathname)) {
        if (!calls.available) throw new HttpError(404, 'calls_unavailable', 'Apelurile nu sunt configurate pe server.');
        return proxyRtcHttp(config.calls.httpPort, req, res, cors);
      }

      let match;
      try {
        match = router.match(req.method ?? 'GET', url.pathname);
      } catch {
        throw new HttpError(400, 'invalid_path', 'Cale invalidă.');
      }
      if (match.kind === 'not_found') throw new HttpError(404, 'not_found', 'Resursa nu există.');
      if (match.kind === 'method_not_allowed') throw new HttpError(405, 'method_not_allowed', 'Metodă nepermisă.');
      const token = bearerToken(req);
      const reply = await match.handler({
        req,
        params: match.params,
        query: url.searchParams,
        ip: clientIp(config, req),
        principal: token ? authenticateToken(ctx, token) : null,
        body: () => readJson(req, config.limits.httpBodyBytes),
      });
      sendReply(res, reply, cors);
    } catch (err) {
      const e =
        err instanceof HttpError ? err : new HttpError(500, 'internal_error', 'Eroare internă. Detaliile sunt în jurnalul serverului.');
      if (!(err instanceof HttpError)) console.error(`[http] ${req.method} ${req.url?.split('?')[0]}:`, err);
      const headers: Record<string, string> = { ...(cors ?? {}) };
      if (e.retryAfterMs) headers['Retry-After'] = String(Math.ceil(e.retryAfterMs / 1000));
      // Corpul cererii (ex. un upload refuzat) nu a fost citit: conexiunea nu poate fi refolosită.
      if (!req.readableEnded) headers.Connection = 'close';
      if (!res.headersSent) sendReply(res, { status: e.status, body: { error: { code: e.code, message: e.message } } }, headers);
      else res.destroy();
    }
  });
  server.headersTimeout = 15_000;
  // Generos pentru upload-uri mari pe date mobile; headersTimeout rămâne scurt (anti-slowloris).
  server.requestTimeout = 30 * 60_000;
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (isRtcPath(pathname)) {
      if (!calls.available || !isOriginAllowed(config, req.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      return proxyRtcUpgrade(config.calls.httpPort, req, socket, head);
    }
    hub.handleUpgrade(req, socket, head);
  });

  return {
    ctx,
    hub,
    calls,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve(server.address() as AddressInfo));
      }),
    startCalls: async () => {
      if (!livekitBin || !keys) return false;
      const addr = server.address() as AddressInfo;
      const configFile = path.join(config.dataDir, 'livekit.yaml');
      const webhookUrl = `http://127.0.0.1:${addr.port}${WEBHOOK_PATH}`;
      const writeYaml = (nodeIp: string | null) =>
        fs.writeFileSync(configFile, liveKitYaml({ ...config.calls, nodeIp }, keys, webhookUrl), { mode: 0o600 });

      let nodeIp = config.calls.nodeIp;
      if (config.calls.portMapping === 'natpmp') {
        const gateway = config.calls.gateway ?? (await defaultGateway());
        if (!gateway) {
          mapperError = 'nu am găsit routerul (gateway-ul implicit)';
        } else {
          const m = new PortMapper({
            gateway,
            ports: [
              { protocol: 'udp', port: config.calls.rtcUdpPort },
              { protocol: 'tcp', port: config.calls.rtcTcpPort },
            ],
            pmpPort: config.calls.natPmpPort,
          });
          try {
            const ip = await m.start();
            nodeIp ??= ip;
            mapper = m;
            // IP-ul public s-a schimbat (ex. routerul a repornit): serverul media trebuie să-l anunțe pe cel nou.
            m.onExternalIpChange = (newIp) => {
              if (config.calls.nodeIp) return;
              console.log(`[apeluri] IP public nou: ${newIp}; repornesc serverul media.`);
              writeYaml(newIp);
              livekit?.restart();
            };
          } catch (err) {
            mapperError = err instanceof Error ? err.message : String(err);
          }
        }
        if (mapperError) console.error(`[apeluri] porturile media NU au fost deschise în router: ${mapperError}. Apelurile vor merge doar în rețeaua locală.`);
      }
      writeYaml(nodeIp);
      livekit = new LiveKitProcess({
        binary: livekitBin,
        configFile,
        logFile: path.join(path.dirname(config.dataDir), 'logs', 'livekit.log'),
        httpPort: config.calls.httpPort,
      });
      livekit.start();
      return livekit.waitReady();
    },
    callsNetwork: () => calls.network(),
    close: async () => {
      hub.close();
      await livekit?.stop();
      await mapper?.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // Checkpoint WAL ca fișierul principal să conțină tot la oprire.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    },
  };
}
