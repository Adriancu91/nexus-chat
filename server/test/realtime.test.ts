import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { CloseCode } from '../src/ws/hub.ts';
import { api, createRoom, joinRoom, setupAdmin, startServer, WsClient } from './helpers.ts';

async function setup() {
  const srv = await startServer();
  const admin = await setupAdmin(srv);
  const { room, password } = await createRoom(srv, admin.token);
  const ana = (await joinRoom(srv, room.code, password, 'Ana')).body;
  const ion = (await joinRoom(srv, room.code, password, 'Ion')).body;
  return { srv, admin, room, password, ana, ion };
}

describe('mesaje în timp real', () => {
  test('mesajul ajunge la ceilalți participanți și este salvat', async () => {
    const { srv, room, ana, ion } = await setup();
    try {
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      const b = await WsClient.authed(srv.wsUrl, ion.token);
      a.send({ type: 'subscribe', roomId: room.id });
      b.send({ type: 'subscribe', roomId: room.id });
      await a.next((m) => m.type === 'history');
      await b.next((m) => m.type === 'history');
      await b.next((m) => m.type === 'presence' && m.online.length === 2);

      a.send({ type: 'send', roomId: room.id, body: 'Salut tuturor!', clientMsgId: 'msg-00000001' });
      const ack = await a.next((m) => m.type === 'ack');
      assert.equal(ack.message.body, 'Salut tuturor!');
      const got = await b.next((m) => m.type === 'message');
      assert.equal(got.message.senderName, 'Ana');
      assert.equal(got.message.id, ack.message.id);

      const hist = await api(srv.base, 'GET', `/api/rooms/${room.id}/messages`, { token: ion.token });
      assert.equal(hist.body.messages.length, 1);
      assert.equal(hist.body.messages[0].body, 'Salut tuturor!');
      a.close();
      b.close();
    } finally {
      await srv.stop();
    }
  });

  test('retrimiterea cu același clientMsgId nu dublează mesajul', async () => {
    const { srv, room, ana } = await setup();
    try {
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      a.send({ type: 'subscribe', roomId: room.id });
      await a.next((m) => m.type === 'history');
      for (let i = 0; i < 2; i++) {
        a.send({ type: 'send', roomId: room.id, body: 'o singură dată', clientMsgId: 'retry-0000001' });
        await a.next((m) => m.type === 'ack');
      }
      const hist = await api(srv.base, 'GET', `/api/rooms/${room.id}/messages`, { token: ana.token });
      assert.equal(hist.body.messages.length, 1);
      a.close();
    } finally {
      await srv.stop();
    }
  });

  test('izolare: participantul nu se poate abona și nu poate scrie în altă cameră', async () => {
    const { srv, admin, ana } = await setup();
    try {
      const other = await createRoom(srv, admin.token, 'Altă cameră');
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      a.send({ type: 'subscribe', roomId: other.room.id, ref: 's' });
      assert.equal((await a.next((m) => m.type === 'error' && m.ref === 's')).code, 'forbidden');
      a.send({ type: 'send', roomId: other.room.id, body: 'intrus', ref: 'w' });
      assert.equal((await a.next((m) => m.type === 'error' && m.ref === 'w')).code, 'forbidden');
      const hist = await api(srv.base, 'GET', `/api/rooms/${other.room.id}/messages`, { token: admin.token });
      assert.equal(hist.body.messages.length, 0);
      a.close();
    } finally {
      await srv.stop();
    }
  });

  test('fără autentificare nu se poate face nimic; token invalid închide conexiunea', async () => {
    const { srv, room } = await setup();
    try {
      const c = await WsClient.connect(srv.wsUrl);
      c.send({ type: 'subscribe', roomId: room.id });
      assert.equal((await c.next((m) => m.type === 'error')).code, 'unauthorized');
      c.send({ type: 'auth', token: 'x'.repeat(43) });
      assert.equal((await c.closed).code, CloseCode.Unauthorized);
    } finally {
      await srv.stop();
    }
  });

  test('origine neaprobată este refuzată la conectare', async () => {
    const { srv } = await setup();
    try {
      await assert.rejects(WsClient.connect(srv.wsUrl, 'https://evil.example'), /403/);
    } finally {
      await srv.stop();
    }
  });

  test('participantul revocat este deconectat imediat', async () => {
    const { srv, admin, room, ana } = await setup();
    try {
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      a.send({ type: 'subscribe', roomId: room.id });
      await a.next((m) => m.type === 'history');
      await api(srv.base, 'POST', `/api/admin/participants/${ana.participant.id}/revoke`, { token: admin.token });
      assert.equal((await a.closed).code, CloseCode.Revoked);
    } finally {
      await srv.stop();
    }
  });

  test('administratorul poate scrie în orice cameră, cu insigna de administrator', async () => {
    const { srv, admin, room, ion } = await setup();
    try {
      const b = await WsClient.authed(srv.wsUrl, ion.token);
      b.send({ type: 'subscribe', roomId: room.id });
      await b.next((m) => m.type === 'history');
      const adm = await WsClient.authed(srv.wsUrl, admin.token);
      adm.send({ type: 'subscribe', roomId: room.id });
      await adm.next((m) => m.type === 'history');
      adm.send({ type: 'send', roomId: room.id, body: 'Bun venit!' });
      const got = await b.next((m) => m.type === 'message');
      assert.equal(got.message.senderKind, 'admin');
      assert.equal(got.message.senderName, 'Administrator');
      b.close();
      adm.close();
    } finally {
      await srv.stop();
    }
  });

  test('limitarea ritmului de trimitere', async () => {
    const srv = await startServer({ overrides: { limits: { messagesPerWindow: 3 } } });
    try {
      const admin = await setupAdmin(srv);
      const { room, password } = await createRoom(srv, admin.token);
      const ana = (await joinRoom(srv, room.code, password, 'Ana')).body;
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      for (let i = 0; i < 4; i++) a.send({ type: 'send', roomId: room.id, body: `m${i}`, ref: `r${i}` });
      for (let i = 0; i < 3; i++) await a.next((m) => m.type === 'ack' && m.ref === `r${i}`);
      assert.equal((await a.next((m) => m.type === 'error' && m.ref === 'r3')).code, 'rate_limited');
      a.close();
    } finally {
      await srv.stop();
    }
  });

  test('mesaj binar sau JSON invalid nu oprește conexiunea', async () => {
    const { srv, ana } = await setup();
    try {
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      a.ws.send('{nu e json');
      assert.equal((await a.next((m) => m.type === 'error')).code, 'invalid_json');
      a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
      assert.equal((await a.next((m) => m.type === 'error')).code, 'unsupported');
      a.send({ type: 'ping', ref: 'p' });
      await a.next((m) => m.type === 'pong' && m.ref === 'p');
      assert.equal(a.ws.readyState, WebSocket.OPEN);
      a.close();
    } finally {
      await srv.stop();
    }
  });
});

describe('persistență', () => {
  test('mesajele și sesiunile supraviețuiesc repornirii serverului', async () => {
    const { srv, room, ana } = await setup();
    const a = await WsClient.authed(srv.wsUrl, ana.token);
    a.send({ type: 'subscribe', roomId: room.id });
    await a.next((m) => m.type === 'history');
    for (let i = 1; i <= 3; i++) {
      a.send({ type: 'send', roomId: room.id, body: `mesaj ${i}` });
      await a.next((m) => m.type === 'ack');
    }
    await srv.stop();
    await a.closed;

    const again = await startServer({ dataDir: srv.dataDir });
    try {
      assert.equal(again.bootstrapCode, null, 'administratorul existent nu primește alt cod de inițializare');
      const b = await WsClient.authed(again.wsUrl, ana.token);
      b.send({ type: 'subscribe', roomId: room.id });
      const hist = await b.next((m) => m.type === 'history');
      assert.deepEqual(
        hist.messages.map((m: { body: string }) => m.body),
        ['mesaj 1', 'mesaj 2', 'mesaj 3'],
      );
      // reconectare incrementală: doar mesajele de după ultimul seq cunoscut
      b.send({ type: 'subscribe', roomId: room.id, afterSeq: hist.messages[1].seq });
      const delta = await b.next((m) => m.type === 'history');
      assert.deepEqual(delta.messages.map((m: { body: string }) => m.body), ['mesaj 3']);
      b.close();
    } finally {
      await again.stop();
    }
  });

  test('paginare istoric înapoi în timp', async () => {
    const { srv, room, ana } = await setup();
    try {
      const a = await WsClient.authed(srv.wsUrl, ana.token);
      for (let i = 1; i <= 5; i++) {
        a.send({ type: 'send', roomId: room.id, body: `m${i}` });
        await a.next((m) => m.type === 'ack');
      }
      const last2 = await api(srv.base, 'GET', `/api/rooms/${room.id}/messages?limit=2`, { token: ana.token });
      assert.deepEqual(last2.body.messages.map((m: { body: string }) => m.body), ['m4', 'm5']);
      assert.equal(last2.body.hasMore, true);
      const prev = await api(srv.base, 'GET', `/api/rooms/${room.id}/messages?limit=10&beforeSeq=${last2.body.messages[0].seq}`, {
        token: ana.token,
      });
      assert.deepEqual(prev.body.messages.map((m: { body: string }) => m.body), ['m1', 'm2', 'm3']);
      assert.equal(prev.body.hasMore, false);
      a.close();
    } finally {
      await srv.stop();
    }
  });
});
