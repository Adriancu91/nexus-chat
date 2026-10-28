export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message);
export const unauthorized = (message = 'Autentificare necesară.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Acces interzis.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Resursa nu există.') => new HttpError(404, 'not_found', message);
export const tooManyRequests = (retryAfterMs: number) =>
  new HttpError(429, 'rate_limited', 'Prea multe încercări. Așteaptă puțin și încearcă din nou.', retryAfterMs);
