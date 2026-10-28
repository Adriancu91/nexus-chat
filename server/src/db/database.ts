import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrations as defaultMigrations, type Migration } from './migrations.ts';

export function openDatabase(file: string, migrations: Migration[] = defaultMigrations): DatabaseSync {
  const db = new DatabaseSync(file);
  // Integritatea arhivei are prioritate față de viteză: WAL + synchronous=FULL
  // garantează că o tranzacție confirmată supraviețuiește unei căderi de curent.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  runMigrations(db, migrations);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // tranzacția a fost deja anulată de SQLite
    }
    throw err;
  }
}

export function getRow<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function allRows<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function schemaVersion(db: DatabaseSync): number {
  const row = getRow<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM schema_migrations');
  return row?.v ?? 0;
}

export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const current = schemaVersion(db);
  const known = Math.max(0, ...migrations.map((m) => m.version));
  if (current > known) {
    throw new Error(
      `Baza de date are schema v${current}, mai nouă decât această versiune a aplicației (v${known}). Actualizează aplicația.`,
    );
  }
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
  }
}
