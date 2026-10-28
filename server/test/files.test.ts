import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { classifyFile, sanitizeFileName, storedFilePath, sweepStorage } from '../src/services/files.ts';
import {
  api,
  createRoom,
  download,
  joinRoom,
  PNG_1PX,
  setupAdmin,
  startServer,
  uploadFile,
  WsClient,
  type TestServer,
} from './helpers.ts';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('fișiere: upload, descărcare, autorizare', () => {
  let srv: TestServer;
  let admin: Awaited<ReturnType<typeof setupAdmin>>;
  let roomA: { room: { id: string; code: string }; password: string };
  let ana: any;
  let ion: any;
  before(async () => {
    srv = await startServer({ overrides: { limits: { maxFileBytes: 64 * 1024, minFreeDiskBytes: 0 } } });
    admin = await setupAdmin(srv);
    roomA = await createRoom(srv, admin.token, 'A');
    ana = (await joinRoom(srv, roomA.room.code, roomA.password, 'Ana')).body;
    ion = (await joinRoom(srv, roomA.room.code, roomA.password, 'Ion')).body;
  });
  after(() => srv.stop());

  test('fișierul este salvat pe disc cu nume intern, integritate SHA-256 și distribuit în timp real', async () => {
    const watcher = await WsClient.authed(srv.wsUrl, ion.token);
    watcher.send({ type: 'subscribe', roomId: roomA.room.id });
    await watcher.next((m) => m.type === 'history');

    const content = Buffer.from('Lista de cumpărături: lapte, pâine\n');
    const res = await uploadFile(srv.base, ana.token, roomA.room.id, 'listă cumpărături.txt', content, { caption: 'Pentru mâine' });
    assert.equal(res.status, 201);
    const msg = res.body.message;
    assert.equal(msg.body, 'Pentru mâine');
    assert.equal(msg.file.name, 'listă cumpărături.txt');
    assert.equal(msg.file.size, content.length);
    assert.equal(msg.file.sha256, sha(content));
    assert.equal(msg.file.previewable, false);

    const live = await watcher.next((m) => m.type === 'message');
    assert.equal(live.message.file.id, msg.file.id);

    // pe disc: sub un nume generat de server (UUID), nu sub numele trimis
    const row = srv.app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(msg.file.id) as { storage_key: string };
    assert.match(row.storage_key, /^[0-9a-f]{2}\/[0-9a-f-]{36}$/);
    assert.deepEqual(fs.readFileSync(storedFilePath(srv.app.ctx.config, row.storage_key)), content);

    const dl = await download(srv.base, msg.file.id, ion.token);
    assert.equal(dl.status, 200);
    assert.deepEqual(dl.data, content);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; .*filename\*=UTF-8''list%C4%83%20cump%C4%83r%C4%83turi\.txt/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-security-policy') ?? '', /sandbox/);
    watcher.close();
  });

  test('imaginile verificate pot fi previzualizate; o „imagine” falsă nu', async () => {
    const real = await uploadFile(srv.base, ana.token, roomA.room.id, 'poza.png', PNG_1PX);
    assert.equal(real.body.message.file.previewable, true);
    const dl = await download(srv.base, real.body.message.file.id, ana.token);
    assert.equal(dl.headers.get('content-type'), 'image/png');
    assert.match(dl.headers.get('content-disposition') ?? '', /^inline;/);
    const forced = await download(srv.base, real.body.message.file.id, ana.token, '?download=1');
    assert.match(forced.headers.get('content-disposition') ?? '', /^attachment;/);

    const fake = await uploadFile(srv.base, ana.token, roomA.room.id, 'poza.png', '<html><script>alert(1)</script></html>');
    assert.equal(fake.body.message.file.previewable, false);
    const fdl = await download(srv.base, fake.body.message.file.id, ana.token);
    assert.equal(fdl.headers.get('content-type'), 'application/octet-stream');
  });

  test('programele executabile sunt refuzate, inclusiv cele deghizate', async () => {
    const exe = await uploadFile(srv.base, ana.token, roomA.room.id, 'joc.exe', 'MZ fake');
    assert.equal(exe.status, 415);
    const disguised = await uploadFile(srv.base, ana.token, roomA.room.id, 'vacanta.jpg', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]));
    assert.equal(disguised.status, 415);
    const bat = await uploadFile(srv.base, ana.token, roomA.room.id, 'script.BAT', 'echo');
    assert.equal(bat.status, 415);
    // nimic nu rămâne pe disc după refuz
    assert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'tmp')), []);
  });

  test('limite: fișier prea mare, fișier gol, fără nume, tip de conținut greșit', async () => {
    const big = await uploadFile(srv.base, ana.token, roomA.room.id, 'mare.bin', Buffer.alloc(64 * 1024 + 1));
    assert.equal(big.status, 413);
    assert.equal((await uploadFile(srv.base, ana.token, roomA.room.id, 'gol.txt', Buffer.alloc(0))).status, 400);
    const noName = await fetch(`${srv.base}/api/rooms/${roomA.room.id}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ana.token}`, 'Content-Type': 'application/octet-stream' },
      body: 'x',
    });
    assert.equal(noName.status, 400);
    assert.equal((await uploadFile(srv.base, ana.token, roomA.room.id, 'a.txt', 'x', { contentType: 'text/plain' })).status, 415);
  });

  test('izolare: alt participant sau anonim nu poate descărca, nici încărca în altă cameră', async () => {
    const roomB = await createRoom(srv, admin.token, 'B');
    const bob = (await joinRoom(srv, roomB.room.code, roomB.password, 'Bob')).body;
    const up = await uploadFile(srv.base, ana.token, roomA.room.id, 'secret.txt', 'doar pentru camera A');
    const fileId = up.body.message.file.id;
    assert.equal((await download(srv.base, fileId, bob.token)).status, 403);
    assert.equal((await download(srv.base, fileId)).status, 401);
    assert.equal((await download(srv.base, fileId, admin.token)).status, 200);
    assert.equal((await uploadFile(srv.base, bob.token, roomA.room.id, 'intrus.txt', 'x')).status, 403);
    assert.equal((await download(srv.base, '../../nexus.db', ana.token)).status, 404);
    assert.equal((await download(srv.base, '00000000-0000-0000-0000-000000000000', ana.token)).status, 404);
  });

  test('lista fișierelor din cameră', async () => {
    const list = await api(srv.base, 'GET', `/api/rooms/${roomA.room.id}/files`, { token: ion.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.messages.length >= 3);
    assert.ok(list.body.messages.every((m: { file: unknown }) => m.file));
    assert.ok(list.body.messages[0].seq > list.body.messages[1].seq, 'cele mai noi primele');
  });

  test('ștergerea camerei șterge și fișierele de pe disc', async () => {
    const tmp = await createRoom(srv, admin.token, 'Temporară');
    const p = (await joinRoom(srv, tmp.room.code, tmp.password, 'X')).body;
    const up = await uploadFile(srv.base, p.token, tmp.room.id, 'a.txt', 'abc');
    const key = (srv.app.ctx.db.prepare('SELECT storage_key FROM files WHERE id = ?').get(up.body.message.file.id) as { storage_key: string }).storage_key;
    const file = storedFilePath(srv.app.ctx.config, key);
    assert.ok(fs.existsSync(file));
    await api(srv.base, 'DELETE', `/api/admin/rooms/${tmp.room.id}`, { token: admin.token, body: { confirmCode: tmp.room.code } });
    assert.ok(!fs.existsSync(file));
  });

  test('curățenia de la pornire elimină transferurile neterminate și fișierele orfane', async () => {
    const tmpFile = path.join(srv.dataDir, 'tmp', 'abc.part');
    fs.writeFileSync(tmpFile, 'neterminat');
    const orphanDir = path.join(srv.dataDir, 'files', 'zz');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'orfan'), 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(path.join(orphanDir, 'orfan'), twoHoursAgo, twoHoursAgo);
    fs.writeFileSync(path.join(orphanDir, 'recent'), 'y'); // poate fi un upload în curs: rămâne
    const r = await sweepStorage(srv.app.ctx);
    assert.equal(r.tmpRemoved, 1);
    assert.equal(r.orphansRemoved, 1);
    assert.ok(!fs.existsSync(tmpFile));
    assert.ok(fs.existsSync(path.join(orphanDir, 'recent')));
    // fișierele cunoscute rămân
    const list = await api(srv.base, 'GET', `/api/rooms/${roomA.room.id}/files`, { token: ana.token });
    assert.equal((await download(srv.base, list.body.messages[0].file.id, ana.token)).status, 200);
  });
});

describe('fișiere: spațiu pe disc', () => {
  test('upload-ul este refuzat când discul ar rămâne aproape plin', async () => {
    const srv = await startServer({ overrides: { limits: { minFreeDiskBytes: Number.MAX_SAFE_INTEGER } } });
    try {
      const admin = await setupAdmin(srv);
      const { room } = await createRoom(srv, admin.token);
      const res = await uploadFile(srv.base, admin.token, room.id, 'a.txt', 'abc');
      assert.equal(res.status, 507);
      assert.equal(res.body.error.code, 'insufficient_storage');
    } finally {
      await srv.stop();
    }
  });
});

describe('nume și tipuri de fișiere', () => {
  test('numele sunt curățate de căi, caractere de control și nume rezervate Windows', () => {
    assert.equal(sanitizeFileName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(sanitizeFileName('C:\\Windows\\a.txt'), 'C__Windows_a.txt');
    assert.equal(sanitizeFileName('poză\u202Egnp.exe'), 'pozăgnp.exe');
    assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
    assert.equal(sanitizeFileName('...'), 'fisier');
    const long = sanitizeFileName('a'.repeat(300) + '.pdf');
    assert.equal([...long].length, 150);
    assert.ok(long.endsWith('.pdf'));
  });
  test('clasificarea tipurilor', () => {
    assert.deepEqual(classifyFile('a.png', PNG_1PX), { mime: 'image/png', inlineSafe: true });
    assert.deepEqual(classifyFile('a.pdf', Buffer.from('%PDF-1.7')), { mime: 'application/pdf', inlineSafe: false });
    assert.deepEqual(classifyFile('a.svg', Buffer.from('<svg')), { mime: 'application/octet-stream', inlineSafe: false });
    assert.throws(() => classifyFile('a.ps1', Buffer.from('x')), /nu sunt permise/);
  });
});
