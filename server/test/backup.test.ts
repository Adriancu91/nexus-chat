import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listBackups, restoreBackup, verifyBackup } from '../src/services/backup.ts';
import { api, createRoom, download, joinRoom, PNG_1PX, setupAdmin, startServer, tempDir, uploadFile, WsClient } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli/backup.ts', import.meta.url));

async function populated() {
  const base = tempDir();
  const dataDir = path.join(base, 'data');
  const backupDir = path.join(base, 'backups');
  const srv = await startServer({ dataDir, overrides: { limits: { minFreeDiskBytes: 0 } } });
  const admin = await setupAdmin(srv);
  await api(srv.base, 'PUT', '/api/admin/archive/settings', { token: admin.token, body: { backup: { dir: backupDir, keep: 2 } } });
  const { room, password } = await createRoom(srv, admin.token, 'Familia');
  const ana = (await joinRoom(srv, room.code, password, 'Ana')).body;
  const ws = await WsClient.authed(srv.wsUrl, ana.token);
  for (const body of ['primul mesaj', 'al doilea mesaj']) {
    ws.send({ type: 'send', roomId: room.id, body });
    await ws.next((m) => m.type === 'ack');
  }
  ws.close();
  const photo = await uploadFile(srv.base, ana.token, room.id, 'poza.png', PNG_1PX);
  return { srv, admin, room, ana, dataDir, backupDir, photoId: photo.body.message.file.id as string };
}

describe('backup și restaurare', () => {
  test('ciclu complet: backup → pierdere de date → restaurare → datele revin, verificate', async () => {
    const { srv, admin, room, ana, dataDir, backupDir, photoId } = await populated();
    const created = await api(srv.base, 'POST', '/api/admin/archive/backups', { token: admin.token });
    assert.equal(created.status, 201);
    const name: string = created.body.backup.name;
    assert.equal(created.body.backup.fileCount, 1);

    const verified = await api(srv.base, 'POST', `/api/admin/archive/backups/${name}/verify`, { token: admin.token });
    assert.deepEqual(verified.body, { name, ok: true, problems: [] });

    // „Dezastru”: camera este ștearsă (mesaje + fișiere).
    await api(srv.base, 'DELETE', `/api/admin/rooms/${room.id}`, { token: admin.token, body: { confirmCode: room.code } });
    await srv.stop();

    // restaurarea refuză să ruleze cât timp serverul folosește arhiva
    fs.writeFileSync(path.join(dataDir, 'server.lock'), String(process.ppid));
    await assert.rejects(restoreBackup({ root: backupDir, name, dataDir }), /Oprește-l/);
    fs.rmSync(path.join(dataDir, 'server.lock'));

    const { movedAside } = await restoreBackup({ root: backupDir, name, dataDir });
    assert.ok(movedAside && fs.existsSync(movedAside), 'arhiva veche a fost păstrată, nu ștearsă');

    const again = await startServer({ dataDir });
    try {
      // sesiunea participantului era în backup, deci este din nou validă
      const hist = await api(again.base, 'GET', `/api/rooms/${room.id}/messages`, { token: ana.token });
      assert.equal(hist.status, 200);
      assert.deepEqual(
        hist.body.messages.map((m: { body: string }) => m.body),
        ['primul mesaj', 'al doilea mesaj', ''],
      );
      const dl = await download(again.base, photoId, ana.token);
      assert.equal(dl.status, 200);
      assert.deepEqual(dl.data, PNG_1PX);
      const integrity = await api(again.base, 'POST', '/api/admin/archive/verify', { token: (await loginAgain(again, admin)).token });
      assert.equal(integrity.body.ok, true);
    } finally {
      await again.stop();
    }
  });

  test('un backup corupt este detectat și refuzat la restaurare', async () => {
    const { srv, admin, dataDir, backupDir } = await populated();
    const name: string = (await api(srv.base, 'POST', '/api/admin/archive/backups', { token: admin.token })).body.backup.name;
    await srv.stop();
    const store = path.join(backupDir, 'store');
    const prefix = fs.readdirSync(store)[0]!;
    const file = path.join(store, prefix, fs.readdirSync(path.join(store, prefix))[0]!);
    fs.writeFileSync(file, 'corupt');
    const v = await verifyBackup(backupDir, name);
    assert.equal(v.ok, false);
    assert.match(v.problems[0]!, /corupt/);
    await assert.rejects(restoreBackup({ root: backupDir, name, dataDir }), /nu trece verificarea/);
    assert.ok(fs.existsSync(path.join(dataDir, 'nexus.db')), 'arhiva curentă a rămas neatinsă');
  });

  test('backup incremental: fișierele sunt copiate o singură dată; se păstrează doar ultimele N', async () => {
    const { srv, admin, ana, room, backupDir } = await populated();
    try {
      const names: string[] = [];
      for (let i = 0; i < 3; i++) {
        if (i === 1) await uploadFile(srv.base, ana.token, room.id, 'doc.txt', 'document nou');
        names.push((await api(srv.base, 'POST', '/api/admin/archive/backups', { token: admin.token })).body.backup.name);
      }
      const list = await listBackups(backupDir);
      assert.deepEqual(list.map((b) => b.name), [names[2], names[1]], 'keep=2');
      const storeFiles = fs.readdirSync(path.join(backupDir, 'store'), { recursive: true }).filter((p) => fs.statSync(path.join(backupDir, 'store', String(p))).isFile());
      assert.equal(storeFiles.length, 2, 'poza și documentul, fiecare o singură dată');

      const archive = await api(srv.base, 'GET', '/api/admin/archive', { token: admin.token });
      assert.equal(archive.body.backups.length, 2);
      assert.equal(archive.body.backupStatus.lastSuccessName, names[2]);
      assert.equal(archive.body.backupStatus.lastError, null);
    } finally {
      await srv.stop();
    }
  });

  test('folderul de backup nu poate fi în interiorul arhivei; doar administratorul face backup', async () => {
    const { srv, admin, ana, dataDir } = await populated();
    try {
      const inside = await api(srv.base, 'PUT', '/api/admin/archive/settings', {
        token: admin.token,
        body: { backup: { dir: path.join(dataDir, 'b') } },
      });
      assert.equal(inside.status, 400);
      const relative = await api(srv.base, 'PUT', '/api/admin/archive/settings', { token: admin.token, body: { backup: { dir: 'backups' } } });
      assert.equal(relative.status, 400);
      assert.equal((await api(srv.base, 'POST', '/api/admin/archive/backups', { token: ana.token })).status, 403);
      assert.equal((await api(srv.base, 'POST', '/api/admin/archive/backups/..%2F..%2Fx/verify', { token: admin.token })).status, 404);
    } finally {
      await srv.stop();
    }
  });

  test('linia de comandă: backup, listare, verificare și restaurare cu serverul oprit', async () => {
    const { srv, dataDir, backupDir } = await populated();
    await srv.stop();
    const run = (...args: string[]) => execFileSync(process.execPath, [CLI, '--data-dir', dataDir, ...args], { encoding: 'utf8' });
    const out = run();
    const name = /Backup creat: (nexus-[\d-]+)/.exec(out)![1]!;
    assert.match(run('--list'), new RegExp(name));
    assert.match(run('--verify', name), /în regulă/);
    fs.rmSync(path.join(dataDir, 'nexus.db'));
    assert.match(run('--restore', name), /Restaurare reușită/);
    assert.ok(fs.existsSync(path.join(dataDir, 'nexus.db')));
    void backupDir;
  });
});

async function loginAgain(srv: Awaited<ReturnType<typeof startServer>>, admin: Awaited<ReturnType<typeof setupAdmin>>) {
  const { adminLogin } = await import('./helpers.ts');
  return (await adminLogin(srv.base, admin.deviceId, admin.key)).body as { token: string };
}
