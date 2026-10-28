import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { accessToken } from './jwt.ts';
import type { CallsConfig } from '../config.ts';

export interface LiveKitKeys {
  apiKey: string;
  apiSecret: string;
}

/**
 * Cheia secretă LiveKit este generată la prima pornire și păstrată doar în folderul arhivei
 * (niciodată în repository). Cu ea NEXUS semnează biletele de intrare în apel.
 */
export function ensureLiveKitKeys(dataDir: string): LiveKitKeys {
  const file = path.join(dataDir, 'livekit-keys.json');
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveKitKeys;
    if (typeof k.apiKey === 'string' && typeof k.apiSecret === 'string' && k.apiSecret.length >= 32) return k;
  } catch {
    // lipsește: se generează mai jos
  }
  const keys: LiveKitKeys = { apiKey: `nexus${randomBytes(4).toString('hex')}`, apiSecret: randomBytes(32).toString('base64url') };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** Configurația LiveKit (YAML scris de NEXUS). Semnalizarea ascultă doar pe 127.0.0.1. */
export function liveKitYaml(calls: CallsConfig, keys: LiveKitKeys, webhookUrl: string): string {
  const lines = [
    '# Generat automat de NEXUS CHAT la pornire. Nu edita: modificările se pierd.',
    `port: ${calls.httpPort}`,
    'bind_addresses:',
    '  - 127.0.0.1',
    'rtc:',
    `  tcp_port: ${calls.rtcTcpPort}`,
    `  udp_port: ${calls.rtcUdpPort}`,
    '  use_external_ip: false',
  ];
  if (calls.nodeIp) lines.push(`  node_ip: ${calls.nodeIp}`);
  lines.push(
    'keys:',
    `  ${keys.apiKey}: ${keys.apiSecret}`,
    'room:',
    `  max_participants: ${calls.maxParticipants}`,
    '  empty_timeout: 30',
    '  departure_timeout: 10',
    'webhook:',
    `  api_key: ${keys.apiKey}`,
    '  urls:',
    `    - ${webhookUrl}`,
    'logging:',
    '  level: info',
    '',
  );
  return lines.join('\n');
}

/**
 * Rulează livekit-server ca proces-copil: îl pornește odată cu NEXUS, îl repornește dacă
 * se oprește neașteptat și îl oprește la închiderea NEXUS.
 */
export class LiveKitProcess {
  private child: ChildProcess | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly binary: string;
  private readonly configFile: string;
  private readonly logFile: string;
  readonly httpUrl: string;

  constructor(opts: { binary: string; configFile: string; logFile: string; httpPort: number }) {
    this.binary = opts.binary;
    this.configFile = opts.configFile;
    this.logFile = opts.logFile;
    this.httpUrl = `http://127.0.0.1:${opts.httpPort}`;
  }

  start(): void {
    if (this.stopped) return;
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const log = fs.openSync(this.logFile, 'a');
    this.child = spawn(this.binary, ['--config', this.configFile], { stdio: ['ignore', log, log], windowsHide: true });
    fs.closeSync(log);
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      console.error(`[apeluri] livekit-server s-a oprit (cod ${code}); repornesc în 5 s.`);
      this.restartTimer = setTimeout(() => this.start(), 5000);
    });
    this.child.on('error', (err) => console.error('[apeluri] nu pot porni livekit-server:', err.message));
  }

  /** Repornește procesul (ex. după schimbarea configurației); bucla de supraveghere îl pornește din nou. */
  restart(): void {
    if (this.child) this.child.kill();
    else if (!this.stopped) this.start();
  }

  /** Așteaptă până răspunde serverul media (sau expiră). */
  async waitReady(timeoutMs = 15_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      try {
        const res = await fetch(this.httpUrl, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {
        // încă pornește
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}

export interface CallParticipant {
  identity: string;
  name: string;
}

/** Client minimal pentru API-ul de administrare LiveKit (Twirp/JSON, doar pe 127.0.0.1). */
export class RoomServiceClient {
  private readonly url: string;
  private readonly keys: LiveKitKeys;

  constructor(url: string, keys: LiveKitKeys) {
    this.url = url;
    this.keys = keys;
  }

  private async call<T>(method: string, room: string, body: Record<string, unknown>): Promise<T> {
    const token = accessToken({ ...this.keys, ttlSec: 60, grant: { room, roomAdmin: true, roomList: true } });
    const res = await fetch(`${this.url}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Camera nu există în LiveKit = nimeni nu e în apel.
      if (res.status === 404 || /not.?found/i.test(text)) return {} as T;
      throw new Error(`LiveKit ${method}: ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async listParticipants(room: string): Promise<CallParticipant[]> {
    const r = await this.call<{ participants?: { identity: string; name?: string; state?: string }[] }>('ListParticipants', room, { room });
    return (r.participants ?? []).map((p) => ({ identity: p.identity, name: p.name ?? '' }));
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.call('RemoveParticipant', room, { room, identity });
  }
}
