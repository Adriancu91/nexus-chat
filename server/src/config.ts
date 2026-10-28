import os from 'node:os';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface Limits {
  httpBodyBytes: number;
  wsMaxPayloadBytes: number;
  maxWsConnections: number;
  messageMaxChars: number;
  displayNameMaxChars: number;
  roomNameMaxChars: number;
  roomPasswordMinChars: number;
  roomPasswordMaxChars: number;
  /** Încercări eșuate de intrare în cameră per IP, per fereastră. */
  joinFailuresPerIp: number;
  /** Încercări eșuate de intrare per cameră (toate IP-urile), per fereastră. */
  joinFailuresPerRoom: number;
  joinWindowMs: number;
  adminFailuresPerIp: number;
  adminChallengesPerIp: number;
  adminWindowMs: number;
  messagesPerWindow: number;
  messageWindowMs: number;
  maxFileBytes: number;
  /** Upload-urile sunt refuzate dacă pe disc ar rămâne mai puțin de atât. */
  minFreeDiskBytes: number;
  uploadsPerWindow: number;
  uploadWindowMs: number;
}

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** Originile (schema://gazdă[:port]) care pot apela API-ul din browser. */
  allowedOrigins: string[];
  /** Antet de proxy de încredere pentru IP-ul clientului (ex. „x-forwarded-for”). Null = adresa socket-ului. */
  trustProxyHeader: string | null;
  adminSessionTtlMs: number;
  participantSessionTtlMs: number;
  bootstrapCodeTtlMs: number;
  enrollmentCodeTtlMs: number;
  limits: Limits;
}

export type ConfigOverrides = Partial<Omit<Config, 'limits'>> & { limits?: Partial<Limits> };

export const DEFAULT_PORT = 8787;
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'NexusChat', 'data');
  }
  return path.join(os.homedir(), '.nexus-chat', 'data');
}

export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin === 'null') {
    throw new Error(`Origine invalidă: ${value}`);
  }
  return url.origin;
}

function intEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`Valoare numerică invalidă: ${value}`);
  return n;
}

function mbEnv(value: string | undefined, fallbackMb: number): number {
  if (value === undefined || value === '') return fallbackMb * 1024 * 1024;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 4096) throw new Error(`Dimensiune invalidă (MB): ${value}`);
  return Math.round(n * 1024 * 1024);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}): Config {
  const base: Config = {
    host: env.NEXUS_HOST ?? '127.0.0.1',
    port: intEnv(env.NEXUS_PORT, DEFAULT_PORT),
    dataDir: env.NEXUS_DATA_DIR ? path.resolve(env.NEXUS_DATA_DIR) : defaultDataDir(),
    allowedOrigins: env.NEXUS_ALLOWED_ORIGINS
      ? env.NEXUS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : DEV_ORIGINS,
    trustProxyHeader: env.NEXUS_TRUST_PROXY_HEADER ? env.NEXUS_TRUST_PROXY_HEADER.toLowerCase() : null,
    adminSessionTtlMs: 12 * HOUR,
    participantSessionTtlMs: 30 * DAY,
    bootstrapCodeTtlMs: 30 * MIN,
    enrollmentCodeTtlMs: 10 * MIN,
    limits: {
      httpBodyBytes: 16 * 1024,
      wsMaxPayloadBytes: 64 * 1024,
      maxWsConnections: 200,
      messageMaxChars: 4000,
      displayNameMaxChars: 40,
      roomNameMaxChars: 60,
      roomPasswordMinChars: 8,
      roomPasswordMaxChars: 128,
      joinFailuresPerIp: 10,
      joinFailuresPerRoom: 30,
      joinWindowMs: 15 * MIN,
      adminFailuresPerIp: 10,
      adminChallengesPerIp: 30,
      adminWindowMs: 15 * MIN,
      messagesPerWindow: 20,
      messageWindowMs: 10_000,
      maxFileBytes: mbEnv(env.NEXUS_MAX_FILE_MB, 100),
      minFreeDiskBytes: 1024 * 1024 * 1024,
      uploadsPerWindow: 30,
      uploadWindowMs: 10 * MIN,
    },
  };
  const config: Config = { ...base, ...overrides, limits: { ...base.limits, ...overrides.limits } };
  config.allowedOrigins = config.allowedOrigins.map(normalizeOrigin);
  return config;
}
