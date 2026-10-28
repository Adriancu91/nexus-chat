import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { adminLogin, api, newDeviceKey, setupAdmin, startServer, type TestServer } from './helpers.ts';

describe('administrator: inițializare, înrolare, autentificare, revocare', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.stop());

  test('la prima pornire există un cod de inițializare', () => {
    assert.match(srv.bootstrapCode ?? '', /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  });

  test('cod greșit → refuz; codul corect se poate folosi o singură dată', async () => {
    const key = await newDeviceKey();
    const bad = await api(srv.base, 'POST', '/api/admin/enroll', {
      body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA', publicKey: key.publicJwk, label: 'X' },
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'invalid_enrollment_code');

    const admin = await setupAdmin(srv);
    assert.ok(admin.token);

    const reuse = await api(srv.base, 'POST', '/api/admin/enroll', {
      body: { code: srv.bootstrapCode, publicKey: key.publicJwk, label: 'Atacator' },
    });
    assert.equal(reuse.status, 401);
  });

  test('autentificarea cere semnătura cheii înregistrate; provocarea nu poate fi refolosită', async () => {
    const key = await newDeviceKey();
    const codeRes = await api(srv.base, 'POST', '/api/admin/enrollment-codes', { token: (await setupAdminToken()).token });
    assert.equal(codeRes.status, 201);
    const enroll = await api(srv.base, 'POST', '/api/admin/enroll', {
      body: { code: codeRes.body.code, publicKey: key.publicJwk, label: 'Telefon' },
    });
    assert.equal(enroll.status, 201);
    const deviceId = enroll.body.device.id;

    // altă cheie, același deviceId → refuz
    const impostor = await newDeviceKey();
    assert.equal((await adminLogin(srv.base, deviceId, impostor)).status, 401);

    // reluarea aceleiași provocări semnate → refuz
    const ch = await api(srv.base, 'POST', '/api/admin/challenge', { body: { deviceId } });
    const signature = await key.sign(`nexus-chat/admin-login/v1\n${ch.body.challengeId}\n${ch.body.nonce}`);
    const body = { deviceId, challengeId: ch.body.challengeId, signature };
    assert.equal((await api(srv.base, 'POST', '/api/admin/login', { body })).status, 200);
    assert.equal((await api(srv.base, 'POST', '/api/admin/login', { body })).status, 401);
  });

  test('dispozitivul revocat pierde imediat sesiunile și nu se mai poate autentifica', async () => {
    const primary = await setupAdminToken();
    const key = await newDeviceKey();
    const code = (await api(srv.base, 'POST', '/api/admin/enrollment-codes', { token: primary.token })).body.code;
    const deviceId = (
      await api(srv.base, 'POST', '/api/admin/enroll', { body: { code, publicKey: key.publicJwk, label: 'Telefon vechi' } })
    ).body.device.id;
    const phoneToken = (await adminLogin(srv.base, deviceId, key)).body.token;
    assert.equal((await api(srv.base, 'GET', '/api/admin/rooms', { token: phoneToken })).status, 200);

    const rev = await api(srv.base, 'POST', `/api/admin/devices/${deviceId}/revoke`, { token: primary.token });
    assert.equal(rev.status, 204);
    assert.equal((await api(srv.base, 'GET', '/api/admin/rooms', { token: phoneToken })).status, 401);
    assert.equal((await adminLogin(srv.base, deviceId, key)).status, 401);

    const audit = await api(srv.base, 'GET', '/api/admin/audit', { token: primary.token });
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    assert.ok(actions.includes('admin.device_revoked'));
    assert.ok(actions.includes('admin.device_enrolled'));
    assert.ok(!JSON.stringify(audit.body).includes(phoneToken), 'jurnalul nu conține tokenuri');
  });

  test('limitarea încercărilor eșuate de autentificare', async () => {
    const limited = await startServer({ overrides: { limits: { adminFailuresPerIp: 3 } } });
    try {
      const key = await newDeviceKey();
      for (let i = 0; i < 3; i++) {
        const r = await api(limited.base, 'POST', '/api/admin/enroll', {
          body: { code: 'AAAAA-AAAAA-AAAAA-AAAAA', publicKey: key.publicJwk, label: 'X' },
        });
        assert.equal(r.status, 401);
      }
      // chiar și codul corect este refuzat cât timp IP-ul e blocat
      const blocked = await api(limited.base, 'POST', '/api/admin/enroll', {
        body: { code: limited.bootstrapCode, publicKey: key.publicJwk, label: 'X' },
      });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    } finally {
      await limited.stop();
    }
  });

  // Sesiunea dispozitivului principal, creată o singură dată.
  let primary: { token: string } | undefined;
  async function setupAdminToken() {
    if (!primary) {
      const devices = await api(srv.base, 'GET', '/api/admin/devices');
      assert.equal(devices.status, 401);
      // Codul de inițializare a fost deja consumat în al doilea test, deci emitem unul nou din CLI-ul local.
      const { issueEnrollmentCode } = await import('../src/services/admin.ts');
      srv.bootstrapCode = issueEnrollmentCode(srv.app.ctx, 'enroll', 'local-cli').code;
      primary = await setupAdmin(srv);
    }
    return primary;
  }
});
