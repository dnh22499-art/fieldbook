// SQLite storage: the app's documents, sign-in accounts, sessions and uploaded files.
// One file (DATA_DIR/fieldbook.db) holds everything except the uploaded files themselves.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "fieldbook.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS docs (
      coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY (coll, id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      pass_hash TEXT NOT NULL, is_owner INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, user_id TEXT, content_type TEXT NOT NULL, size INTEGER NOT NULL,
      name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  const now = () => new Date().toISOString();
  const q = {
    list: db.prepare("SELECT id, data, version FROM docs WHERE coll = ? ORDER BY rowid"),
    get: db.prepare("SELECT id, data, version FROM docs WHERE coll = ? AND id = ?"),
    upsert: db.prepare(`INSERT INTO docs (coll, id, data, version, updated_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at`),
    del: db.prepare("DELETE FROM docs WHERE coll = ? AND id = ?"),
    kvGet: db.prepare("SELECT v FROM kv WHERE k = ?"),
    kvSet: db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v"),
  };
  const a = {
    insert: db.prepare("INSERT INTO assets (id, user_id, content_type, size, name, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    get: db.prepare("SELECT * FROM assets WHERE id = ?"),
    del: db.prepare("DELETE FROM assets WHERE id = ?"),
  };
  const parse = (r) => r && { id: r.id, data: JSON.parse(r.data), version: r.version };
  // Every write announces the collection it touched, so open pages can refresh it.
  const listeners = new Set();
  const changed = (coll, id) => { for (const fn of listeners) { try { fn(coll, id); } catch {} } };
  const uploadsDir = path.join(dataDir, "uploads");
  return {
    db, dataDir, uploadsDir,
    newId: () => crypto.randomBytes(15).toString("base64url").replace(/[-_]/g, "").slice(0, 20).toLowerCase().padEnd(20, "0"),
    list: (coll) => q.list.all(coll).map(parse),
    get: (coll, id) => parse(q.get.get(coll, id)),
    set: (coll, id, data) => { q.upsert.run(coll, id, JSON.stringify(data), now()); changed(coll, id); },
    del: (coll, id) => { const n = q.del.run(coll, id).changes > 0; if (n) changed(coll, id); return n; },
    kvGet: (k) => { const r = q.kvGet.get(k); return r ? JSON.parse(r.v) : null; },
    kvSet: (k, v) => { q.kvSet.run(k, JSON.stringify(v)); },
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    assetPath: (id) => path.join(uploadsDir, id),
    addAsset: ({ id, userId, contentType, size, name }) => a.insert.run(id, userId || null, contentType, size, name || null, now()),
    getAsset: (id) => a.get.get(id),
    delAsset: (id) => { const r = a.del.run(id).changes > 0; try { fs.unlinkSync(path.join(uploadsDir, id)); } catch {} return r; },
    close: () => db.close(),
    now,
  };
}
