import { backendUrl } from './config.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export const NETWORK_ERROR_MESSAGE =
  'Serverul nu poate fi contactat. Verifică conexiunea la internet și dacă laptopul gazdă este pornit.';

export async function request<T>(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(backendUrl() + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(res.status, 'bad_response', 'Răspuns neașteptat de la server.');
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    const retry = Number(res.headers.get('retry-after')) || undefined;
    let message = err?.message ?? `Eroare ${res.status}.`;
    if (retry) message += ` Poți încerca din nou peste ${formatWait(retry)}.`;
    throw new ApiError(res.status, err?.code ?? 'http_error', message, retry);
  }
  return data as T;
}

function formatWait(sec: number): string {
  return sec < 90 ? `${sec} secunde` : `${Math.ceil(sec / 60)} minute`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'A apărut o eroare neașteptată.';
}

// ---- tipuri comune ----

export interface Room {
  id: string;
  code: string;
  name: string;
  maxParticipants: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

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

export interface JoinResponse {
  token: string;
  expiresAt: number;
  room: { id: string; code: string; name: string };
  participant: { id: string; displayName: string };
}
