export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrațiile se adaugă, nu se modifică după publicare.
 * Fiecare rulează într-o tranzacție împreună cu înregistrarea versiunii sale.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE admin_devices (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        public_key_jwk TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE admin_enrollment_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap', 'enroll')),
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        max_participants INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );

      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX idx_participants_room ON participants(room_id);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('admin', 'participant')),
        admin_device_id TEXT REFERENCES admin_devices(id) ON DELETE CASCADE,
        participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
        room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        CHECK (
          (kind = 'admin' AND admin_device_id IS NOT NULL AND participant_id IS NULL AND room_id IS NULL) OR
          (kind = 'participant' AND participant_id IS NOT NULL AND room_id IS NOT NULL AND admin_device_id IS NULL)
        )
      );
      CREATE INDEX idx_sessions_device ON sessions(admin_device_id);
      CREATE INDEX idx_sessions_participant ON sessions(participant_id);
      CREATE INDEX idx_sessions_room ON sessions(room_id);

      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        sender_kind TEXT NOT NULL CHECK (sender_kind IN ('admin', 'participant')),
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        client_msg_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_room_seq ON messages(room_id, seq);
      CREATE UNIQUE INDEX idx_messages_idempotency ON messages(sender_id, client_msg_id)
        WHERE client_msg_id IS NOT NULL;

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
      CREATE INDEX idx_audit_at ON audit_log(at);
    `,
  },
  {
    version: 2,
    name: 'files-search-settings',
    sql: `
      -- Metadatele fișierelor. Conținutul stă pe disc, la data/files/<storage_key>;
      -- storage_key este generat de server (niciodată din numele trimis de utilizator).
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        storage_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        inline_safe INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        uploader_kind TEXT NOT NULL CHECK (uploader_kind IN ('admin', 'participant')),
        uploader_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_files_room ON files(room_id);

      ALTER TABLE messages ADD COLUMN file_id TEXT REFERENCES files(id) ON DELETE CASCADE;
      CREATE INDEX idx_messages_file ON messages(file_id) WHERE file_id IS NOT NULL;
      CREATE INDEX idx_messages_created ON messages(created_at);

      -- Căutare full-text, fără diacritice („maine” găsește „mâine”).
      CREATE VIRTUAL TABLE messages_fts USING fts5(body, file_name, tokenize = 'unicode61 remove_diacritics 2');
      INSERT INTO messages_fts (rowid, body, file_name) SELECT seq, body, '' FROM messages;
      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (rowid, body, file_name)
        VALUES (new.seq, new.body, COALESCE((SELECT original_name FROM files WHERE id = new.file_id), ''));
      END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.seq;
      END;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];
