import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { accessToken, signJwt, verifyJwt, verifyWebhook } from '../src/calls/jwt.ts';
import { liveKitYaml } from '../src/calls/livekit.ts';
import { loadConfig } from '../src/config.ts';
import { api, createRoom, joinRoom, setupAdmin, startServer, WsClient, type TestServer } from './helpers.ts';

const LIVEKIT = fileURLToPath(new URL('../../.tools/livekit/livekit-server.exe', import.meta.url));
const HAS_LIVEKIT = fs.existsSync(LIVEKIT);

describe('JWT pentru LiveKit', () => {
  test('semnătura și expirarea sunt verificate', () => {
    const t = signJwt({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, 'secret-lung-de-test-0123456789abcdef');
    assert.deepEqual(verifyJwt(t, 'secret-lung-de-test-0123456789abcdef')?.a, 1);
    assert.equal(verifyJwt(t, 'alt-secret-0123456789abcdef0123456789'), null);
    const expired = signJwt({ exp: Math.floor(Date.now() / 1000) - 10 }, 's'.repeat(32));
    assert.equal(verifyJwt(expired, 's'.repeat(32)), null);
    const [h, b] = t.split('.');
    assert.equal(verifyJwt(`${h}.${b}.`, 'secret-lung-de-test-0123456789abcdef'), null);
  });
  test('biletul de apel este limitat la o cameră și fără canal de date', () => {
    const t = accessToken({ apiKey: 'k', apiSecret: 'x'.repeat(32), identity: 'participant:p1:abcd', name: 'Ana', ttlSec: 600, grant: { room: 'r1', roomJoin: true, canPublishData: false } });
    const c = verifyJwt(t, 'x'.repeat(32))!;
    assert.equal(c.sub, 'participant:p1:abcd');
    assert.deepEqual(c.video, { room: 'r1', roomJoin: true, canPublishData: false });
    assert.ok((c.exp as number) - (c.nbf as number) <= 610);
  });
  test('webhook: corp modificat sau semnătură falsă → respins', () => {
    const body = Buffer.from('{"event":"participant_joined","room":{"name":"r1"}}');
    const sha = createHash('sha256').update(body).digest('base64');
    const auth = signJwt({ iss: 'k', sha256: sha, exp: Math.floor(Date.now() / 1000) + 60 }, 'x'.repeat(32));
    assert.equal(verifyWebhook(body, auth, 'k', 'x'.repeat(32)), true);
    assert.equal(verifyWebhook(Buffer.from(body.toString() + ' '), auth, 'k', 'x'.repeat(32)), false);
    assert.equal(verifyWebhook(body, auth, 'alt', 'x'.repeat(32)), false);
    assert.equal(verifyWebhook(body, undefined, 'k', 'x'.repeat(32)), false);
  });
  test('configurația LiveKit ascultă doar local și nu conține înregistrare', () => {
    const cfg = loadConfig({}, { calls: { maxParticipants: 6 } });
    const yaml = liveKitYaml(cfg.calls, { apiKey: 'k', apiSecret: 'secret' }, 'http://127.0.0.1:1/x');
    assert.match(yaml, /bind_addresses:\n {2}- 127\.0\.0\.1/);
    assert.match(yaml, /max_participants: 6/);
    assert.doesNotMatch(yaml, /egress|recording/i);
  });
});

describe('apeluri fără server media configurat', () => {
  test('biletul este refuzat clar, iar starea spune „indisponibil”', async () => {
    const srv = await startServer();
    try {
      const admin = await setupAdmin(srv);
      const { room } = await createRoom(srv, admin.token);
      const res = await api(srv.base, 'POST', `/api/rooms/${room.id}/call/token`, { token: admin.token });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'calls_unavailable');
      const state = await api(srv.base, 'GET', `/api/rooms/${room.id}/call`, { token: admin.token });
      assert.deepEqual(state.body, { roomId: room.id, available: false, participants: [] });
    } finally {
      await srv.stop();
    }
  });
});

describe('apeluri cu LiveKit real', { skip: HAS_LIVEKIT ? false : 'livekit-server nu este disponibil' }, () => {
  let srv: TestServer;
  let admin: Awaited<ReturnType<typeof setupAdmin>>;
  let roomA: { room: { id: string; code: string }; password: string };
  let ana: any;
  before(async () => {
    srv = await startServer({ overrides: { calls: { livekitBinary: LIVEKIT, httpPort: 17880, rtcTcpPort: 17881, rtcUdpPort: 17882, maxParticipants: 3 } } });
    assert.equal(await srv.app.startCalls(), true, 'LiveKit trebuie să pornească');
    admin = await setupAdmin(srv);
    roomA = await createRoom(srv, admin.token, 'A');
    ana = (await joinRoom(srv, roomA.room.code, roomA.password, 'Ana')).body;
  });
  after(() => srv?.stop());

  test('biletul se dă doar celor cu acces la cameră', async () => {
    const ok = await api(srv.base, 'POST', `/api/rooms/${roomA.room.id}/call/token`, { token: ana.token });
    assert.equal(ok.status, 201);
    const keys = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'livekit-keys.json'), 'utf8'));
    const claims = verifyJwt(ok.body.token, keys.apiSecret)!;
    assert.equal((claims.video as { room: string }).room, roomA.room.id);
    assert.equal(claims.name, 'Ana');

    const roomB = await createRoom(srv, admin.token, 'B');
    assert.equal((await api(srv.base, 'POST', `/api/rooms/${roomB.room.id}/call/token`, { token: ana.token })).status, 403);
    assert.equal((await api(srv.base, 'POST', `/api/rooms/${roomA.room.id}/call/token`)).status, 401);

    await api(srv.base, 'PATCH', `/api/admin/rooms/${roomB.room.id}`, { token: admin.token, body: { closed: true } });
    assert.equal((await api(srv.base, 'POST', `/api/rooms/${roomB.room.id}/call/token`, { token: admin.token })).status, 403);
  });

  test('semnalizarea /rtc trece prin NEXUS doar pentru originile permise', async () => {
    const res = await fetch(`${srv.base}/rtc/validate`);
    assert.equal(res.status, 401, 'LiveKit răspunde prin proxy și cere bilet');
    assert.equal((await fetch(`${srv.base}/rtc/validate`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    // LiveKit nu este accesibil direct din afara calculatorului: ascultă doar pe 127.0.0.1
    const yaml = fs.readFileSync(path.join(srv.dataDir, 'livekit.yaml'), 'utf8');
    assert.match(yaml, /- 127\.0\.0\.1/);
  });

  test('webhook-urile nesemnate sunt respinse; cele semnate actualizează starea apelului în chat', async () => {
    const ws = await WsClient.authed(srv.wsUrl, ana.token);
    ws.send({ type: 'subscribe', roomId: roomA.room.id });
    const initial = await ws.next((m) => m.type === 'call');
    assert.deepEqual(initial, { type: 'call', roomId: roomA.room.id, available: true, participants: [] });

    const body = JSON.stringify({ event: 'participant_joined', room: { name: roomA.room.id } });
    const forged = await fetch(`${srv.base}/internal/livekit/webhook`, { method: 'POST', body, headers: { Authorization: 'Bearer x.y.z' } });
    assert.equal(forged.status, 401);

    const keys = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'livekit-keys.json'), 'utf8'));
    const sha = createHash('sha256').update(body).digest('base64');
    const auth = signJwt({ iss: keys.apiKey, sha256: sha, exp: Math.floor(Date.now() / 1000) + 60 }, keys.apiSecret);
    const real = await fetch(`${srv.base}/internal/livekit/webhook`, { method: 'POST', body, headers: { Authorization: auth } });
    assert.equal(real.status, 200);
    assert.equal((await ws.next((m) => m.type === 'call')).available, true);
    ws.close();
  });

  test('cheia secretă LiveKit stă doar în folderul arhivei', () => {
    const keys = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'livekit-keys.json'), 'utf8'));
    assert.ok(keys.apiSecret.length >= 40);
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    assert.ok(!path.resolve(srv.dataDir).startsWith(path.resolve(repoRoot)), 'arhiva de test nu e în repository');
  });
});
