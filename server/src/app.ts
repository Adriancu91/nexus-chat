import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db/database.ts';
import { HttpError } from './errors.ts';
import { bearerToken, clientIp, corsHeaders, readJson, sendReply } from './http/http.ts';
import { buildRouter } from './http/routes.ts';
import { authenticateToken } from './services/sessions.ts';
import { Hub } from './ws/hub.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';

export interface App {
  ctx: Ctx;
  hub: Hub;
  server: http.Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function openDataDir(config: Config): DatabaseSync {
  fs.mkdirSync(config.dataDir, { recursive: true });
  return openDatabase(path.join(config.dataDir, 'nexus.db'));
}

export function createApp(config: Config, now: () => number = Date.now): App {
  const db = openDataDir(config);
  const ctx: Ctx = { db, config, now };
  const hub = new Hub(ctx);
  const router = buildRouter(ctx, hub);

  const server = http.createServer(async (req, res) => {
    const cors = corsHeaders(config, req.headers.origin);
    try {
      if (cors === null) throw new HttpError(403, 'origin_not_allowed', 'Originea nu este permisă.');
      if (req.method === 'OPTIONS') return sendReply(res, { status: 204 }, cors);
      const url = new URL(req.url ?? '/', 'http://localhost');
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
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  return {
    ctx,
    hub,
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve(server.address() as AddressInfo));
      }),
    close: async () => {
      hub.close();
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
