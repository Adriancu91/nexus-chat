import fs from 'node:fs';
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
  calls: CallsConfig;
}

/** Apeluri audio-video prin LiveKit (server media separat, rulat de NEXUS pe același calculator). */
export interface CallsConfig {
  /** Calea către livekit-server(.exe). null = apelurile sunt dezactivate. */
  livekitBinary: string | null;
  /** Portul local de semnalizare LiveKit (doar 127.0.0.1; din internet se ajunge prin NEXUS, /rtc). */
  httpPort: number;
  rtcTcpPort: number;
  rtcUdpPort: number;
  /** Adresa anunțată clienților pentru media. null = adresele locale (doar pentru teste/rețea locală). */
  nodeIp: string | null;
  maxParticipants: number;
  /** Deschiderea automată a porturilor media în routerul de acasă (NAT-PMP). */
  portMapping: 'none' | 'natpmp';
  /** Adresa routerului; null = gateway-ul implicit al sistemului. */
  gateway: string | null;
  natPmpPort: number;
  /**
   * Releu TURN (LiveKit încorporat) pentru rețele în care media nu poate ajunge direct:
   * domain = adresa publică (ex. Tailscale Funnel, care face TLS și trimite TCP simplu local
   * pe tlsPort). udpPort = TURN pe UDP, doar pentru teste locale.
   */
  turn: { domain: string | null; tlsPort: number; udpPort: number | null };
  /** Cât timp e valabil biletul de intrare în apel (conexiunea rămâne după aceea). */
  tokenTtlSec: number;
}

export type ConfigOverrides = Partial<Omit<Config, 'limits' | 'calls'>> & { limits?: Partial<Limits>; calls?: Partial<CallsConfig> };

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

/**
 * Fișierul de configurare de pe laptop (fără secrete), editat de `npm run config`.
 * Implicit: %LOCALAPPDATA%\NexusChat\config.json, lângă folderul arhivei.
 */
export interface FileConfig {
  port?: number;
  host?: string;
  allowedOrigins?: string[];
  trustProxyHeader?: string | null;
  maxFileMb?: number;
  calls?: Partial<CallsConfig>;
}

/** livekit-server lângă folderul arhivei (ex. %LOCALAPPDATA%\NexusChat\livekit\livekit-server.exe), dacă există. */
export function defaultLiveKitBinary(dataDir: string): string | null {
  const exe = path.join(path.dirname(dataDir), 'livekit', process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  return fs.existsSync(exe) ? exe : null;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEXUS_CONFIG) return path.resolve(env.NEXUS_CONFIG);
  const dataDir = env.NEXUS_DATA_DIR ? path.resolve(env.NEXUS_DATA_DIR) : defaultDataDir();
  return path.join(path.dirname(dataDir), 'config.json');
}

export function readConfigFile(file: string): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Doar lipsa fișierului înseamnă „valori implicite”; orice altă eroare trebuie văzută.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw new Error(`Nu pot citi fișierul de configurare ${file} (${code ?? String(err)}).`);
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as FileConfig;
  } catch {
    throw new Error(`Fișierul de configurare ${file} nu este JSON valid.`);
  }
}

export function writeConfigFile(file: string, config: FileConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Prioritate: valori explicite (teste) > variabile de mediu > fișierul de configurare > implicit. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: ConfigOverrides = {}, file: FileConfig = {}): Config {
  const fileOrigins = Array.isArray(file.allowedOrigins) ? file.allowedOrigins.map(String) : undefined;
  const dataDirResolved = env.NEXUS_DATA_DIR ? path.resolve(env.NEXUS_DATA_DIR) : defaultDataDir();
  const fc = file.calls ?? {};
  const base: Config = {
    host: env.NEXUS_HOST ?? (typeof file.host === 'string' ? file.host : '127.0.0.1'),
    port: intEnv(env.NEXUS_PORT, typeof file.port === 'number' ? file.port : DEFAULT_PORT),
    dataDir: env.NEXUS_DATA_DIR ? path.resolve(env.NEXUS_DATA_DIR) : defaultDataDir(),
    allowedOrigins: env.NEXUS_ALLOWED_ORIGINS
      ? env.NEXUS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : [...DEV_ORIGINS, ...(fileOrigins ?? [])],
    trustProxyHeader: env.NEXUS_TRUST_PROXY_HEADER
      ? env.NEXUS_TRUST_PROXY_HEADER.toLowerCase()
      : typeof file.trustProxyHeader === 'string' && file.trustProxyHeader
        ? file.trustProxyHeader.toLowerCase()
        : null,
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
      maxFileBytes: mbEnv(env.NEXUS_MAX_FILE_MB ?? (typeof file.maxFileMb === 'number' ? String(file.maxFileMb) : undefined), 100),
      minFreeDiskBytes: 1024 * 1024 * 1024,
      uploadsPerWindow: 30,
      uploadWindowMs: 10 * MIN,
    },
    calls: {
      livekitBinary: env.NEXUS_LIVEKIT_BIN
        ? path.resolve(env.NEXUS_LIVEKIT_BIN)
        : typeof fc.livekitBinary === 'string'
          ? fc.livekitBinary
          : defaultLiveKitBinary(dataDirResolved),
      httpPort: typeof fc.httpPort === 'number' ? fc.httpPort : 7880,
      rtcTcpPort: typeof fc.rtcTcpPort === 'number' ? fc.rtcTcpPort : 7881,
      rtcUdpPort: typeof fc.rtcUdpPort === 'number' ? fc.rtcUdpPort : 7882,
      nodeIp: typeof fc.nodeIp === 'string' && fc.nodeIp ? fc.nodeIp : null,
      maxParticipants: typeof fc.maxParticipants === 'number' ? fc.maxParticipants : 8,
      portMapping: fc.portMapping === 'natpmp' ? 'natpmp' : 'none',
      gateway: typeof fc.gateway === 'string' && fc.gateway ? fc.gateway : null,
      natPmpPort: typeof fc.natPmpPort === 'number' ? fc.natPmpPort : 5351,
      turn: {
        domain: typeof fc.turn?.domain === 'string' && fc.turn.domain ? fc.turn.domain : null,
        tlsPort: typeof fc.turn?.tlsPort === 'number' ? fc.turn.tlsPort : 8443,
        udpPort: typeof fc.turn?.udpPort === 'number' ? fc.turn.udpPort : null,
      },
      tokenTtlSec: 10 * 60,
    },
  };
  const config: Config = {
    ...base,
    ...overrides,
    limits: { ...base.limits, ...overrides.limits },
    calls: { ...base.calls, ...overrides.calls },
  };
  config.allowedOrigins = [...new Set(config.allowedOrigins.map(normalizeOrigin))];
  return config;
}
