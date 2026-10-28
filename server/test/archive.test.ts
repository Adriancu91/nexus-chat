import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { storedFilePath } from '../src/services/files.ts';
import { acquireServerLock, runningServerPid } from '../src/services/lock.ts';
import { api, createRoom, joinRoom, setupAdmin, startServer, tempDir, uploadFile, WsClient } from './helpers.ts';

async function roomWithMessages(bodies: string[]) {
  const srv = await startServer({ overrides: { limits: { minFreeDiskBytes: 0 } } });
  const admin = await setupAdmin(srv);
  const { room, password } = await createRoom(srv, admin.token);
  const ana = (await joinRoom(srv, room.code, password, 'Ana')).body;
  const ws = await WsClient.authed(srv.wsUrl, ana.token);
  for (const body of bodies) {
    ws.send({ type: 'send', roomId: room.id, body });
    await ws.next((m) => m.type === 'ack');
  }
  ws.close();
  return { srv, admin, room, password, ana };
}

describe('căutare în istoric', () => {
  test('găsește cuvinte fără diacritice, prefixe și nume de fișiere; marchează fragmentul', async () => {
    const { srv, admin, room, password, ana } = await roomWithMessages([
      'Mâine mergem la bunica în Brașov',
      'Nu uitați cadourile',
      'Brânza de la piață e foarte bună',
    ]);
    try {
      await uploadFile(srv.base, ana.token, room.id, 'Factură curent octombrie.pdf', '%PDF-1.4 test');
      const search = (q: string, token = ana.token) =>
        api(srv.base, 'GET', `/api/rooms/${room.id}/search?q=${encodeURIComponent(q)}`, { token });

      const r1 = await search('maine brasov');
      assert.equal(r1.status, 200);
      assert.equal(r1.body.results.length, 1);
      assert.equal(r1.body.results[0].message.body, 'Mâine mergem la bunica în Brașov');
      assert.match(r1.body.results[0].snippet, /\u0001Mâine\u0002/);

      assert.equal((await search('cadour')).body.results.length, 1, 'căutare după prefix');
      assert.equal((await search('factura')).body.results[0].message.file.name, 'Factură curent octombrie.pdf');
      assert.equal((await search('inexistent')).body.results.length, 0);

      // sintaxa FTS5 din textul utilizatorului nu este interpretată
      for (const q of ['"', 'NEAR(a b)', 'body:x', '* OR 1', '-brânza', "'; DROP TABLE messages; --"]) {
        assert.equal((await search(q)).status, 200, q);
      }
      assert.equal((await search('   ')).status, 400);

      // izolare: alt participant nu poate căuta în această cameră
      const other = await createRoom(srv, admin.token, 'Alta');
      const bob = (await joinRoom(srv, other.room.code, other.password, 'Bob')).body;
      assert.equal((await search('maine', bob.token)).status, 403);
      // iar căutarea în camera lui nu întoarce mesaje din altă cameră
      const own = await api(srv.base, 'GET', `/api/rooms/${other.room.id}/search?q=maine`, { token: bob.token });
      assert.equal(own.body.results.length, 0);
      void password;
    } finally {
      await srv.stop();
    }
  });
});

describe('politica de retenție', () => {
  test('previzualizare, apoi ștergerea mesajelor vechi și a fișierelor lor de pe disc', async () => {
    const srv = await startServer({ overrides: { limits: { minFreeDiskBytes: 0 } } });
    const realNow = srv.app.ctx.now;
    let now = realNow();
    srv.app.ctx.now = () => now;
    try {
      const admin = await setupAdmin(srv);
      const { room, password } = await createRoom(srv, admin.token);
      const ana = (await joinRoom(srv, room.code, password, 'Ana')).body;
      const ws = await WsClient.authed(srv.wsUrl, ana.token);
      now = realNow() - 40 * 24 * 3600_000; // mesajele următoare sunt „vechi de 40 de zile”
      ws.send({ type: 'send', roomId: room.id, body: 'mesaj vechi' });
      await ws.next((m) => m.type === 'ack');
      const old = await uploadFile(srv.base, ana.token, room.id, 'veche.txt', 'conținut vechi');
      const key = (srv.app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(old.body.message.file.id) as { storage_key: string }).storage_key;

      now = realNow();
      ws.send({ type: 'send', roomId: room.id, body: 'mesaj nou' });
      await ws.next((m) => m.type === 'ack');
      ws.close();

      const preview = await api(srv.base, 'GET', '/api/admin/archive/retention-preview?days=30', { token: admin.token });
      assert.deepEqual(preview.body, { messages: 2, files: 1, fileBytes: Buffer.byteLength('conținut vechi') });

      const set = await api(srv.base, 'PUT', '/api/admin/archive/settings', { token: admin.token, body: { retentionDays: 30 } });
      assert.equal(set.status, 200);
      assert.equal(set.body.retentionApplied.messages, 2);

      const hist = await api(srv.base, 'GET', `/api/rooms/${room.id}/messages`, { token: ana.token });
      assert.deepEqual(hist.body.messages.map((m: { body: string }) => m.body), ['mesaj nou']);
      assert.ok(!fs.existsSync(storedFilePath(srv.app.ctx.config, key)), 'fișierul vechi a fost șters de pe disc');
      const search = await api(srv.base, 'GET', `/api/rooms/${room.id}/search?q=vechi`, { token: ana.token });
      assert.equal(search.body.results.length, 0, 'și din indexul de căutare');

      // dezactivare: păstrare pentru totdeauna
      const off = await api(srv.base, 'PUT', '/api/admin/archive/settings', { token: admin.token, body: { retentionDays: null } });
      assert.equal(off.body.settings.retentionDays, null);
      // doar administratorul
      assert.equal((await api(srv.base, 'PUT', '/api/admin/archive/settings', { token: ana.token, body: { retentionDays: 1 } })).status, 403);
    } finally {
      await srv.stop();
    }
  });
});

describe('verificarea integrității arhivei', () => {
  test('detectează fișiere lipsă și corupte', async () => {
    const { srv, admin, room, ana } = await roomWithMessages(['salut']);
    try {
      const a = await uploadFile(srv.base, ana.token, room.id, 'a.txt', 'aaa');
      const b = await uploadFile(srv.base, ana.token, room.id, 'b.txt', 'bbb');
      const ok = await api(srv.base, 'POST', '/api/admin/archive/verify', { token: admin.token });
      assert.equal(ok.body.ok, true);
      assert.equal(ok.body.files.checked, 2);

      const keyOf = (id: string) => (srv.app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(id) as { storage_key: string }).storage_key;
      fs.writeFileSync(storedFilePath(srv.app.ctx.config, keyOf(a.body.message.file.id)), 'XXX');
      fs.rmSync(storedFilePath(srv.app.ctx.config, keyOf(b.body.message.file.id)));
      const bad = await api(srv.base, 'POST', '/api/admin/archive/verify', { token: admin.token });
      assert.equal(bad.body.ok, false);
      assert.deepEqual(bad.body.files.corrupted, ['a.txt']);
      assert.deepEqual(bad.body.files.missing, ['b.txt']);
      assert.equal(bad.body.database.ok, true);
    } finally {
      await srv.stop();
    }
  });
});

describe('blocarea arhivei', () => {
  test('al doilea server pe aceeași arhivă este refuzat; blocarea rămasă de la un proces mort este ignorată', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'server.lock'), String(process.ppid)); // proces viu (părintele)
    assert.throws(() => acquireServerLock(dir), /rulează deja/);
    assert.equal(runningServerPid(dir), process.ppid);
    fs.writeFileSync(path.join(dir, 'server.lock'), '999999'); // proces inexistent
    const release = acquireServerLock(dir);
    assert.equal(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8'), String(process.pid));
    release();
    assert.ok(!fs.existsSync(path.join(dir, 'server.lock')));
  });
});
