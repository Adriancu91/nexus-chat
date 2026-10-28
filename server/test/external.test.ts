import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configFilePath, loadConfig, readConfigFile } from '../src/config.ts';
import { clientIp } from '../src/http/http.ts';
import { api, setupAdmin, startServer, tempDir } from './helpers.ts';

const fakeReq = (remoteAddress: string, headers: Record<string, string>) =>
  ({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe('IP-ul clientului în spatele proxy-ului', () => {
  const config = loadConfig({}, { trustProxyHeader: 'x-forwarded-for' });

  test('se folosește ultima adresă (adăugată de proxy), nu cea trimisă de client', () => {
    assert.equal(clientIp(config, fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })), '203.0.113.9');
    assert.equal(clientIp(config, fakeReq('::1', { 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  });
  test('antetul este ignorat dacă cererea nu vine de la proxy-ul local', () => {
    assert.equal(clientIp(config, fakeReq('198.51.100.7', { 'x-forwarded-for': '1.2.3.4' })), '198.51.100.7');
  });
  test('fără configurare explicită, antetul nu este folosit niciodată', () => {
    assert.equal(clientIp(loadConfig({}), fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), '127.0.0.1');
  });
});

describe('fișierul de configurare', () => {
  test('originile din fișier se adaugă celor de dezvoltare; variabilele de mediu au prioritate', () => {
    const file = path.join(tempDir(), 'config.json');
    fs.writeFileSync(file, '﻿' + JSON.stringify({ allowedOrigins: ['https://familie.github.io/'], port: 9999, trustProxyHeader: 'X-Forwarded-For', maxFileMb: 5 }));
    const fromFile = loadConfig({}, {}, readConfigFile(file));
    assert.ok(fromFile.allowedOrigins.includes('https://familie.github.io'));
    assert.ok(fromFile.allowedOrigins.includes('http://localhost:5173'));
    assert.equal(fromFile.port, 9999);
    assert.equal(fromFile.trustProxyHeader, 'x-forwarded-for');
    assert.equal(fromFile.limits.maxFileBytes, 5 * 1024 * 1024);
    const env = loadConfig({ NEXUS_PORT: '1234', NEXUS_ALLOWED_ORIGINS: 'https://alt.example' }, {}, readConfigFile(file));
    assert.equal(env.port, 1234);
    assert.deepEqual(env.allowedOrigins, ['https://alt.example']);
  });
  test('fișier lipsă = valori implicite; JSON invalid = eroare clară', () => {
    assert.deepEqual(readConfigFile(path.join(tempDir(), 'nu-exista.json')), {});
    const bad = path.join(tempDir(), 'config.json');
    fs.writeFileSync(bad, '{ nu e json');
    assert.throws(() => readConfigFile(bad), /nu este JSON valid/);
  });
  test('locația implicită este lângă folderul arhivei', () => {
    const base = path.join(tempDir(), 'NexusChat');
    assert.equal(configFilePath({ NEXUS_DATA_DIR: path.join(base, 'data') }), path.join(base, 'config.json'));
    assert.equal(configFilePath({ NEXUS_CONFIG: path.join(base, 'alt.json') }), path.join(base, 'alt.json'));
  });
  test('npm run config adaugă o origine HTTPS și refuză HTTP din internet', () => {
    const file = path.join(tempDir(), 'config.json');
    const cli = fileURLToPath(new URL('../src/cli/config.ts', import.meta.url));
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NEXUS_CONFIG: file }, stdio: 'pipe' });
    run('--allow-origin', 'https://familie.github.io', '--trust-proxy', 'x-forwarded-for');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { allowedOrigins: ['https://familie.github.io'], trustProxyHeader: 'x-forwarded-for' });
    assert.throws(() => run('--allow-origin', 'http://evil.example'));
    run('--remove-origin', 'https://familie.github.io', '--no-trust-proxy');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { allowedOrigins: [], trustProxyHeader: null });
  });
});

describe('diagnostic acces extern', () => {
  test('arată ce vede serverul, doar administratorului, fără antetul Authorization', async () => {
    const srv = await startServer({ overrides: { trustProxyHeader: 'x-forwarded-for' } });
    try {
      const admin = await setupAdmin(srv);
      const res = await fetch(`${srv.base}/api/admin/diagnostics/request`, {
        headers: { Authorization: `Bearer ${admin.token}`, 'X-Forwarded-For': 'spoof, 203.0.113.5' },
      });
      const body = (await res.json()) as { clientIp: string; headers: Record<string, string>; trustProxyHeader: string };
      assert.equal(res.status, 200);
      assert.equal(body.clientIp, '203.0.113.5');
      assert.equal(body.trustProxyHeader, 'x-forwarded-for');
      assert.ok(!JSON.stringify(body).includes(admin.token));
      assert.equal((await api(srv.base, 'GET', '/api/admin/diagnostics/request')).status, 401);
    } finally {
      await srv.stop();
    }
  });
});
