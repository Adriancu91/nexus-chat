import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { api, createRoom, joinRoom, setupAdmin, startServer, TEST_ORIGIN, type TestServer } from './helpers.ts';

describe('camere: creare, intrare, autorizare, izolare', () => {
  let srv: TestServer;
  let admin: Awaited<ReturnType<typeof setupAdmin>>;
  before(async () => {
    srv = await startServer();
    admin = await setupAdmin(srv);
  });
  after(() => srv.stop());

  test('doar administratorul poate crea camere', async () => {
    const anon = await api(srv.base, 'POST', '/api/admin/rooms', { body: { name: 'X', password: 'parola-sigura-1' } });
    assert.equal(anon.status, 401);

    const { room, password } = await createRoom(srv, admin.token);
    const joined = await joinRoom(srv, room.code, password, 'Ana');
    assert.equal(joined.status, 201);
    const asParticipant = await api(srv.base, 'POST', '/api/admin/rooms', {
      token: joined.body.token,
      body: { name: 'Y', password: 'parola-sigura-1' },
    });
    assert.equal(asParticipant.status, 403);
    for (const [method, path] of [
      ['GET', '/api/admin/rooms'],
      ['GET', '/api/admin/devices'],
      ['GET', '/api/admin/audit'],
      ['GET', '/api/admin/status'],
      ['POST', '/api/admin/enrollment-codes'],
    ] as const) {
      assert.equal((await api(srv.base, method, path, { token: joined.body.token })).status, 403, `${method} ${path}`);
    }
  });

  test('parola camerei: prea scurtă la creare; parola nu apare în răspunsuri', async () => {
    const weak = await api(srv.base, 'POST', '/api/admin/rooms', { token: admin.token, body: { name: 'X', password: 'scurt' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'weak_password');
    const { room } = await createRoom(srv, admin.token, 'Prieteni', 'parola-secreta-777');
    const list = await api(srv.base, 'GET', '/api/admin/rooms', { token: admin.token });
    assert.ok(list.body.rooms.some((r: { id: string }) => r.id === room.id));
    assert.ok(!JSON.stringify(list.body).includes('parola-secreta-777'));
    assert.ok(!JSON.stringify(list.body).includes('scrypt'));
  });

  test('intrare: cod inexistent și parolă greșită dau aceeași eroare', async () => {
    const { room } = await createRoom(srv, admin.token);
    const wrongPw = await joinRoom(srv, room.code, 'gresita-123', 'Ion');
    const wrongCode = await joinRoom(srv, 'zzzzzzzzzz', 'gresita-123', 'Ion');
    assert.equal(wrongPw.status, 401);
    assert.deepEqual(wrongPw.body, wrongCode.body);
  });

  test('nume afișat invalid este refuzat', async () => {
    const { room, password } = await createRoom(srv, admin.token);
    assert.equal((await joinRoom(srv, room.code, password, '   ')).status, 400);
    assert.equal((await joinRoom(srv, room.code, password, 'x'.repeat(41))).status, 400);
  });

  test('un participant nu poate citi istoricul altei camere', async () => {
    const a = await createRoom(srv, admin.token, 'A');
    const b = await createRoom(srv, admin.token, 'B');
    const inA = (await joinRoom(srv, a.room.code, a.password, 'Ana')).body;
    const own = await api(srv.base, 'GET', `/api/rooms/${a.room.id}/messages`, { token: inA.token });
    assert.equal(own.status, 200);
    const other = await api(srv.base, 'GET', `/api/rooms/${b.room.id}/messages`, { token: inA.token });
    assert.equal(other.status, 403);
    const anon = await api(srv.base, 'GET', `/api/rooms/${a.room.id}/messages`);
    assert.equal(anon.status, 401);
    const admins = await api(srv.base, 'GET', `/api/rooms/${b.room.id}/messages`, { token: admin.token });
    assert.equal(admins.status, 200);
  });

  test('închiderea camerei revocă sesiunile; redeschiderea nu le reactivează', async () => {
    const { room, password } = await createRoom(srv, admin.token);
    const p = (await joinRoom(srv, room.code, password, 'Ana')).body;
    const close = await api(srv.base, 'PATCH', `/api/admin/rooms/${room.id}`, { token: admin.token, body: { closed: true } });
    assert.equal(close.status, 200);
    assert.ok(close.body.room.closedAt);
    assert.equal((await api(srv.base, 'GET', '/api/session', { token: p.token })).status, 401);
    const closedJoin = await joinRoom(srv, room.code, password, 'Ana');
    assert.equal(closedJoin.status, 403);
    assert.equal(closedJoin.body.error.code, 'room_closed');
    await api(srv.base, 'PATCH', `/api/admin/rooms/${room.id}`, { token: admin.token, body: { closed: false } });
    assert.equal((await api(srv.base, 'GET', '/api/session', { token: p.token })).status, 401);
    assert.equal((await joinRoom(srv, room.code, password, 'Ana')).status, 201);
  });

  test('schimbarea parolei cu revokeSessions deconectează participanții', async () => {
    const { room, password } = await createRoom(srv, admin.token);
    const p = (await joinRoom(srv, room.code, password, 'Ana')).body;
    const res = await api(srv.base, 'PATCH', `/api/admin/rooms/${room.id}`, {
      token: admin.token,
      body: { password: 'parola-noua-456', revokeSessions: true },
    });
    assert.equal(res.status, 200);
    assert.equal((await api(srv.base, 'GET', '/api/session', { token: p.token })).status, 401);
    assert.equal((await joinRoom(srv, room.code, password, 'Ana')).status, 401);
    assert.equal((await joinRoom(srv, room.code, 'parola-noua-456', 'Ana')).status, 201);
  });

  test('revocarea unui participant', async () => {
    const { room, password } = await createRoom(srv, admin.token);
    const p = (await joinRoom(srv, room.code, password, 'Ana')).body;
    const list = await api(srv.base, 'GET', `/api/admin/rooms/${room.id}/participants`, { token: admin.token });
    assert.equal(list.body.participants[0].displayName, 'Ana');
    const rev = await api(srv.base, 'POST', `/api/admin/participants/${p.participant.id}/revoke`, { token: admin.token });
    assert.equal(rev.status, 204);
    assert.equal((await api(srv.base, 'GET', '/api/session', { token: p.token })).status, 401);
  });

  test('ștergerea cere confirmarea codului camerei', async () => {
    const { room, password } = await createRoom(srv, admin.token);
    const p = (await joinRoom(srv, room.code, password, 'Ana')).body;
    const noConfirm = await api(srv.base, 'DELETE', `/api/admin/rooms/${room.id}`, { token: admin.token, body: { confirmCode: 'gresit' } });
    assert.equal(noConfirm.status, 400);
    const del = await api(srv.base, 'DELETE', `/api/admin/rooms/${room.id}`, { token: admin.token, body: { confirmCode: room.code } });
    assert.equal(del.status, 204);
    assert.equal((await api(srv.base, 'GET', '/api/session', { token: p.token })).status, 401);
    assert.equal((await joinRoom(srv, room.code, password, 'Ana')).status, 401);
  });

  test('limita de participanți', async () => {
    const res = await api(srv.base, 'POST', '/api/admin/rooms', {
      token: admin.token,
      body: { name: 'Mică', password: 'parola-sigura-1', maxParticipants: 2 },
    });
    const code = res.body.room.code;
    assert.equal((await joinRoom(srv, code, 'parola-sigura-1', 'A')).status, 201);
    assert.equal((await joinRoom(srv, code, 'parola-sigura-1', 'B')).status, 201);
    const third = await joinRoom(srv, code, 'parola-sigura-1', 'C');
    assert.equal(third.status, 403);
    assert.equal(third.body.error.code, 'room_full');
  });

  test('CORS: doar originile aprobate', async () => {
    const good = await api(srv.base, 'GET', '/api/health', { origin: TEST_ORIGIN });
    assert.equal(good.headers.get('access-control-allow-origin'), TEST_ORIGIN);
    const bad = await api(srv.base, 'GET', '/api/health', { origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(srv.base + '/api/admin/rooms', { method: 'OPTIONS', headers: { Origin: TEST_ORIGIN } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  });

  test('cereri invalide: JSON greșit, tip greșit, corp prea mare', async () => {
    const r1 = await fetch(srv.base + '/api/rooms/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(r1.status, 400);
    const r2 = await fetch(srv.base + '/api/rooms/join', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(r2.status, 415);
    const r3 = await api(srv.base, 'POST', '/api/rooms/join', { body: { code: 'a', password: 'x'.repeat(20_000), displayName: 'A' } });
    assert.equal(r3.status, 413);
    assert.equal((await api(srv.base, 'GET', '/api/nimic')).status, 404);
    assert.equal((await api(srv.base, 'GET', '/api/admin/rooms/%E0%A4%A/participants', { token: admin.token })).status, 400);
  });
});

describe('limitarea încercărilor de intrare în cameră', () => {
  test('blochează IP-ul după prea multe parole greșite', async () => {
    const srv = await startServer({ overrides: { limits: { joinFailuresPerIp: 3 } } });
    try {
      const admin = await setupAdmin(srv);
      const { room, password } = await createRoom(srv, admin.token);
      for (let i = 0; i < 3; i++) assert.equal((await joinRoom(srv, room.code, 'gresita-000', 'X')).status, 401);
      const blocked = await joinRoom(srv, room.code, password, 'X');
      assert.equal(blocked.status, 429, 'chiar și parola corectă e refuzată cât timp IP-ul e blocat');
    } finally {
      await srv.stop();
    }
  });
});
