import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import { promisify } from 'node:util';

/**
 * Client NAT-PMP (RFC 6886): cere routerului să redirecționeze temporar un port spre acest
 * calculator. Maparea expiră singură (o „închiriere”), deci trebuie reînnoită cât timp
 * serverul rulează și se eliberează la oprire.
 */
const NATPMP_PORT = 5351;

function request(gateway: string, port: number, payload: Buffer, expectOpcode: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let attempt = 0;
    let timer: NodeJS.Timeout | undefined;
    const finish = (err: Error | null, buf?: Buffer) => {
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve(buf!);
    };
    const send = () => {
      // RFC 6886: retrimitere la 250 ms, apoi dublare (aici maximum 4 încercări, ~4 s).
      if (attempt >= 4) return finish(new Error(`routerul ${gateway} nu răspunde la NAT-PMP`));
      sock.send(payload, port, gateway);
      timer = setTimeout(send, 250 * 2 ** attempt++);
    };
    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== gateway || msg.length < 8 || msg[0] !== 0 || msg[1] !== expectOpcode) return;
      const result = msg.readUInt16BE(2);
      if (result !== 0) return finish(new Error(`NAT-PMP: routerul a refuzat cererea (cod ${result})`));
      finish(null, msg);
    });
    sock.on('error', (err) => finish(err));
    sock.bind(0, send);
  });
}

export async function natPmpExternalAddress(gateway: string, port = NATPMP_PORT): Promise<string> {
  const msg = await request(gateway, port, Buffer.from([0, 0]), 128);
  if (msg.length < 12) throw new Error('NAT-PMP: răspuns incomplet');
  return `${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`;
}

export interface Mapping {
  protocol: 'udp' | 'tcp';
  internalPort: number;
  externalPort: number;
  lifetimeSec: number;
}

/** Cere maparea unui port. lifetimeSec = 0 eliberează maparea. */
export async function natPmpMap(
  gateway: string,
  protocol: 'udp' | 'tcp',
  internalPort: number,
  externalPort: number,
  lifetimeSec: number,
  port = NATPMP_PORT,
): Promise<Mapping> {
  const op = protocol === 'udp' ? 1 : 2;
  const req = Buffer.alloc(12);
  req[0] = 0;
  req[1] = op;
  req.writeUInt16BE(internalPort, 4);
  req.writeUInt16BE(externalPort, 6);
  req.writeUInt32BE(lifetimeSec, 8);
  const msg = await request(gateway, port, req, 128 + op);
  if (msg.length < 16) throw new Error('NAT-PMP: răspuns incomplet');
  return { protocol, internalPort: msg.readUInt16BE(8), externalPort: msg.readUInt16BE(10), lifetimeSec: msg.readUInt32BE(12) };
}

/** Gateway-ul implicit IPv4 (routerul de acasă), din tabela de rutare a sistemului. */
export async function defaultGateway(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('route', ['print', '-4', '0.0.0.0'], { windowsHide: true });
      const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/m.exec(stdout);
      return m?.[1] ?? null;
    }
    const { stdout } = await promisify(execFile)('ip', ['-4', 'route', 'show', 'default']);
    return /default via (\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface PortMapperStatus {
  active: boolean;
  externalIp: string | null;
  error: string | null;
}

/**
 * Deschide în router porturile media (UDP și TCP), le reînnoiește la jumătatea închirierii și
 * le închide la oprire. Anunță schimbarea IP-ului public (ex. după repornirea routerului).
 */
export class PortMapper {
  private readonly gateway: string;
  private readonly ports: { protocol: 'udp' | 'tcp'; port: number }[];
  private readonly lifetimeSec: number;
  private readonly pmpPort: number;
  private timer: NodeJS.Timeout | undefined;
  status: PortMapperStatus = { active: false, externalIp: null, error: null };
  onExternalIpChange: (ip: string) => void = () => undefined;

  constructor(opts: { gateway: string; ports: { protocol: 'udp' | 'tcp'; port: number }[]; lifetimeSec?: number; pmpPort?: number }) {
    this.gateway = opts.gateway;
    this.ports = opts.ports;
    this.lifetimeSec = opts.lifetimeSec ?? 3600;
    this.pmpPort = opts.pmpPort ?? NATPMP_PORT;
  }

  /** Prima mapare; aruncă eroare dacă routerul refuză sau dă alt port extern. */
  async start(): Promise<string> {
    const ip = await this.refresh();
    this.schedule();
    return ip;
  }

  private schedule() {
    this.timer = setTimeout(async () => {
      try {
        await this.refresh();
      } catch (err) {
        this.status = { ...this.status, active: false, error: err instanceof Error ? err.message : String(err) };
        console.error('[apeluri] reînnoirea porturilor în router a eșuat:', this.status.error);
      }
      this.schedule();
    }, (this.lifetimeSec * 1000) / 2);
    this.timer.unref();
  }

  private async refresh(): Promise<string> {
    const ip = await natPmpExternalAddress(this.gateway, this.pmpPort);
    for (const p of this.ports) {
      const m = await natPmpMap(this.gateway, p.protocol, p.port, p.port, this.lifetimeSec, this.pmpPort);
      // Serverul media anunță clienților portul local; un alt port extern nu ar funcționa.
      if (m.externalPort !== p.port) {
        throw new Error(`routerul a alocat portul ${m.externalPort} în loc de ${p.port} (${p.protocol.toUpperCase()})`);
      }
    }
    const changed = this.status.externalIp !== null && this.status.externalIp !== ip;
    this.status = { active: true, externalIp: ip, error: null };
    if (changed) this.onExternalIpChange(ip);
    return ip;
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.status.active) return;
    for (const p of this.ports) {
      await natPmpMap(this.gateway, p.protocol, p.port, 0, 0, this.pmpPort).catch(() => undefined);
    }
    this.status = { ...this.status, active: false };
  }
}
