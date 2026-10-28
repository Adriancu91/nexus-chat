import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../errors.ts';
import type { Config } from '../config.ts';

export interface Reply {
  status: number;
  body?: unknown;
  /** Răspuns cu conținutul unui fișier de pe disc (descărcări). */
  file?: { path: string; size: number; headers: Record<string, string> };
}

export const ok = (body: unknown): Reply => ({ status: 200, body });
export const created = (body: unknown): Reply => ({ status: 201, body });
export const noContent = (): Reply => ({ status: 204 });

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Se acceptă doar application/json.');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large', 'Cererea este prea mare.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'payload_too_large', 'Cererea este prea mare.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON invalid.');
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export function sendReply(res: ServerResponse, reply: Reply, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = { ...SECURITY_HEADERS, ...extraHeaders };
  if (reply.file) {
    const { path: file, size, headers: fileHeaders } = reply.file;
    const stream = fs.createReadStream(file);
    stream.once('open', () => {
      res.writeHead(reply.status, { ...headers, ...fileHeaders, 'Content-Length': String(size) });
      stream.pipe(res);
    });
    stream.once('error', () => {
      if (!res.headersSent) sendReply(res, { status: 410, body: { error: { code: 'file_missing', message: 'Fișierul nu mai există pe server.' } } }, extraHeaders);
      else res.destroy();
    });
    res.once('close', () => stream.destroy());
    return;
  }
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers).end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  headers['Content-Length'] = String(Buffer.byteLength(payload));
  res.writeHead(reply.status, headers).end(payload);
}

/** CORS cu listă explicită de origini. Întoarce null dacă originea nu este permisă. */
export function corsHeaders(config: Config, origin: string | undefined): Record<string, string> | null {
  if (origin === undefined) return {};
  if (!config.allowedOrigins.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name, X-Caption',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

export function isOriginAllowed(config: Config, origin: string | undefined): boolean {
  return origin === undefined || config.allowedOrigins.includes(origin);
}

/**
 * IP-ul clientului. Antetele de proxy se folosesc doar dacă sunt configurate explicit,
 * altfel oricine le-ar putea falsifica pentru a ocoli limitarea încercărilor.
 */
export function clientIp(config: Config, req: IncomingMessage): string {
  if (config.trustProxyHeader) {
    const raw = req.headers[config.trustProxyHeader];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h);
  return m?.[1] ?? null;
}
