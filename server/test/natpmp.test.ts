import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { natPmpExternalAddress, natPmpMap, PortMapper } from '../src/calls/natpmp.ts';
import { api, setupAdmin, startServer } from './helpers.ts';

/** Router NAT-PMP simulat (RFC 6886), pe 127.0.0.1. */
async function fakeRouter(opts: { externalIp?: string; remapPort?: (p: number) => number; resultCode?: number } = {}) {
  const sock = dgram.createSocket('udp4');
  const requests: { op: number; internal: number; external: number; lifetime: number }[] = [];
  let externalIp = opts.externalIp ?? '203.0.113.7';
  sock.on('message', (msg, rinfo) => {
    const op = msg[1]!;
    const res = Buffer.alloc(op === 0 ? 12 : 16);
    res[0] = 0;
    res[1] = 128 + op;
    res.writeUInt16BE(opts.resultCode ?? 0, 2);
    res.writeUInt32BE(1000, 4);
    if (op === 0) {
      externalIp.split('.').forEach((n, i) => (res[8 + i] = Number(n)));
    } else {
      const internal = msg.readUInt16BE(4);
      const external = msg.readUInt16BE(6);
      const lifetime = msg.readUInt32BE(8);
      requests.push({ op, internal, external, lifetime });
      res.writeUInt16BE(internal, 8);
      res.writeUInt16BE(lifetime === 0 ? 0 : (opts.remapPort?.(external) ?? external), 10);
      res.writeUInt32BE(lifetime, 12);
    }
    sock.send(res, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return {
    port: (sock.address() as { port: number }).port,
    requests,
    setIp: (ip: string) => (externalIp = ip),
    close: () => sock.close(),
  };
}

describe('NAT-PMP', () => {
  test('află IP-ul public și deschide/eliberează un port', async () => {
    const r = await fakeRouter();
    try {
      assert.equal(await natPmpExternalAddress('127.0.0.1', r.port), '203.0.113.7');
      const m = await natPmpMap('127.0.0.1', 'udp', 7882, 7882, 3600, r.port);
      assert.deepEqual(m, { protocol: 'udp', internalPort: 7882, externalPort: 7882, lifetimeSec: 3600 });
      await natPmpMap('127.0.0.1', 'tcp', 7881, 0, 0, r.port);
      assert.deepEqual(r.requests.at(-1), { op: 2, internal: 7881, external: 0, lifetime: 0 });
    } finally {
      r.close();
    }
  });

  test('refuzul routerului și un port extern diferit sunt erori clare', async () => {
    const refusing = await fakeRouter({ resultCode: 2 });
    try {
      await assert.rejects(natPmpExternalAddress('127.0.0.1', refusing.port), /refuzat cererea \(cod 2\)/);
    } finally {
      refusing.close();
    }
    const remapping = await fakeRouter({ remapPort: (p) => p + 1000 });
    try {
      const mapper = new PortMapper({ gateway: '127.0.0.1', ports: [{ protocol: 'udp', port: 7882 }], pmpPort: remapping.port });
      await assert.rejects(mapper.start(), /a alocat portul 8882 în loc de 7882/);
    } finally {
      remapping.close();
    }
  });

  test('router care nu răspunde: eroare după câteva reîncercări', async () => {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    const port = (sock.address() as { port: number }).port;
    sock.close(); // portul nu mai ascultă
    await assert.rejects(natPmpExternalAddress('127.0.0.1', port), /nu răspunde|ECONNRESET/);
  });

  test('reînnoiește la jumătatea închirierii și anunță schimbarea IP-ului public', async () => {
    const r = await fakeRouter();
    const mapper = new PortMapper({
      gateway: '127.0.0.1',
      ports: [
        { protocol: 'udp', port: 7882 },
        { protocol: 'tcp', port: 7881 },
      ],
      lifetimeSec: 2,
      pmpPort: r.port,
    });
    try {
      assert.equal(await mapper.start(), '203.0.113.7');
      const changed = new Promise<string>((resolve) => (mapper.onExternalIpChange = resolve));
      r.setIp('198.51.100.20');
      assert.equal(await changed, '198.51.100.20');
      assert.equal(mapper.status.externalIp, '198.51.100.20');
      await mapper.stop();
      const releases = r.requests.filter((q) => q.lifetime === 0);
      assert.deepEqual(releases.map((q) => q.op).sort(), [1, 2], 'ambele porturi eliberate la oprire');
    } finally {
      await mapper.stop();
      r.close();
    }
  });
});

const LIVEKIT = fileURLToPath(new URL('../../.tools/livekit/livekit-server.exe', import.meta.url));

describe('apeluri cu porturi deschise automat', { skip: fs.existsSync(LIVEKIT) ? false : 'livekit-server nu este disponibil' }, () => {
  test('serverul media anunță IP-ul public primit de la router; starea apare în administrare', async () => {
    const r = await fakeRouter({ externalIp: '203.0.113.50' });
    const srv = await startServer({
      overrides: {
        calls: {
          livekitBinary: LIVEKIT,
          httpPort: 17890,
          rtcTcpPort: 17891,
          rtcUdpPort: 17892,
          portMapping: 'natpmp',
          gateway: '127.0.0.1',
          natPmpPort: r.port,
        },
      },
    });
    try {
      assert.equal(await srv.app.startCalls(), true);
      const yaml = fs.readFileSync(path.join(srv.dataDir, 'livekit.yaml'), 'utf8');
      assert.match(yaml, /node_ip: 203\.0\.113\.50/);
      assert.deepEqual(
        r.requests.filter((q) => q.lifetime > 0).map((q) => [q.op, q.internal]).sort(),
        [
          [1, 17892],
          [2, 17891],
        ],
      );
      const admin = await setupAdmin(srv);
      const status = await api(srv.base, 'GET', '/api/admin/status', { token: admin.token });
      assert.deepEqual(status.body.calls, { available: true, portMapping: 'natpmp', active: true, externalIp: '203.0.113.50', error: null });
    } finally {
      await srv.stop();
      r.close();
    }
    assert.equal(r.requests.filter((q) => q.lifetime === 0).length, 2, 'porturile se închid la oprirea serverului');
  });
});
