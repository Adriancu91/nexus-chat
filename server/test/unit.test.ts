import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { adminLoginMessage, parseAdminPublicKey, verifyAdminSignature } from '../src/crypto/adminKeys.ts';
import { hashPassword, verifyPassword } from '../src/crypto/passwords.ts';
import { newEnrollmentCode, newRoomCode, normalizeEnrollmentCode } from '../src/crypto/tokens.ts';
import { openDatabase, schemaVersion } from '../src/db/database.ts';
import { migrations } from '../src/db/migrations.ts';
import { RateLimiter } from '../src/services/rateLimiter.ts';
import { cleanLabel, cleanMessageBody } from '../src/validation.ts';
import { newDeviceKey, tempDir } from './helpers.ts';

describe('parole camere (scrypt)', () => {
  test('verifică parola corectă și o respinge pe cea greșită', async () => {
    const h = await hashPassword('parolă-lungă');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.equal(await verifyPassword('parolă-lungă', h), true);
    assert.equal(await verifyPassword('parola-lunga', h), false);
  });
  test('sare unică: același text produce hash-uri diferite', async () => {
    assert.notEqual(await hashPassword('x'.repeat(10)), await hashPassword('x'.repeat(10)));
  });
  test('hash corupt nu este acceptat', async () => {
    assert.equal(await verifyPassword('abc', 'nu-e-hash'), false);
  });
});

describe('coduri', () => {
  test('cod de cameră și cod de înrolare au formatul așteptat', () => {
    assert.match(newRoomCode(), /^[a-z2-9]{10}$/);
    const code = newEnrollmentCode();
    assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    assert.equal(normalizeEnrollmentCode(code.toLowerCase().replaceAll('-', ' ')), code);
  });
});

describe('semnături dispozitiv administrator', () => {
  test('acceptă semnătura WebCrypto validă și o respinge pe cea pentru alt mesaj', async () => {
    const key = await newDeviceKey();
    const jwk = parseAdminPublicKey(key.publicJwk);
    assert.ok(jwk);
    const msg = adminLoginMessage('c1', 'n1');
    const sig = await key.sign(msg.toString());
    assert.equal(verifyAdminSignature(jwk, msg, sig), true);
    assert.equal(verifyAdminSignature(jwk, adminLoginMessage('c1', 'n2'), sig), false);
    assert.equal(verifyAdminSignature(jwk, msg, 'A'.repeat(86)), false);
  });
  test('refuză chei private, alte curbe și puncte invalide', async () => {
    const key = await newDeviceKey();
    assert.equal(parseAdminPublicKey({ ...key.publicJwk, d: 'x' }), null);
    assert.equal(parseAdminPublicKey({ ...key.publicJwk, crv: 'P-384' }), null);
    assert.equal(parseAdminPublicKey({ kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) }), null);
    assert.equal(parseAdminPublicKey('nu'), null);
  });
});

describe('limitator de încercări', () => {
  test('blochează după limită și se resetează după fereastră', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    assert.equal(rl.hit('a'), true);
    assert.equal(rl.hit('a'), true);
    assert.equal(rl.hit('a'), false);
    assert.equal(rl.blockedFor('a'), 1000);
    assert.equal(rl.blockedFor('b'), 0);
    t = 1000;
    assert.equal(rl.blockedFor('a'), 0);
    assert.equal(rl.hit('a'), true);
  });
});

describe('validare', () => {
  test('numele afișat elimină caractere de control și bidi', () => {
    assert.equal(cleanLabel({ n: '  Ana‮  Maria\u0000 ' }, 'n', 40), 'Ana Maria');
    assert.throws(() => cleanLabel({ n: '   ' }, 'n', 40), /gol/);
    assert.throws(() => cleanLabel({ n: 'x'.repeat(41) }, 'n', 40), /depășește/);
    assert.throws(() => cleanLabel({ n: 5 }, 'n', 40), /nu este text/);
  });
  test('mesajul păstrează liniile noi și respectă limita', () => {
    assert.equal(cleanMessageBody(' salut\r\nce faci? ', 100), 'salut\nce faci?');
    assert.throws(() => cleanMessageBody('', 100), /gol/);
    assert.throws(() => cleanMessageBody('a'.repeat(101), 100), /depășește/);
    // HTML-ul este stocat ca text; afișarea sigură (escape) este responsabilitatea clientului.
    assert.equal(cleanMessageBody('<script>alert(1)</script>', 100), '<script>alert(1)</script>');
  });
});

describe('migrații SQLite', () => {
  test('se aplică o singură dată și persistă după redeschidere', () => {
    const file = path.join(tempDir(), 'm.db');
    const db = openDatabase(file);
    assert.equal(schemaVersion(db), migrations.length);
    db.prepare("INSERT INTO audit_log (at, actor, action) VALUES (1, 'test', 'x')").run();
    db.close();
    const again = openDatabase(file);
    assert.equal(schemaVersion(again), migrations.length);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, 1);
    assert.equal((again.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((again.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    again.close();
  });
  test('o migrație eșuată este anulată complet', () => {
    const file = path.join(tempDir(), 'm.db');
    const broken = [...migrations, { version: 99, name: 'broken', sql: 'CREATE TABLE ok_table (x); SELECT * FROM nu_exista;' }];
    assert.throws(() => openDatabase(file, broken));
    const db = openDatabase(file);
    assert.equal(schemaVersion(db), migrations.length);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_table'").get(), undefined);
    db.close();
  });
  test('refuză o bază de date cu schemă mai nouă decât aplicația', () => {
    const file = path.join(tempDir(), 'm.db');
    openDatabase(file, [...migrations, { version: 50, name: 'future', sql: 'SELECT 1' }]).close();
    assert.throws(() => openDatabase(file), /mai nouă/);
  });
});
