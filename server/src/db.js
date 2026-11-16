import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH === ':memory:' ? ':memory:'
  : resolve(process.env.DB_PATH ?? new URL('../../data/origin-flags.db', import.meta.url).pathname);
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS products (
  asin TEXT PRIMARY KEY, title TEXT, brand TEXT, seller_id TEXT, seller_name TEXT,
  manufacturer TEXT, manufacturer_address TEXT, manufacturer_country TEXT,
  updated_at INTEGER, source TEXT
);
CREATE TABLE IF NOT EXISTS brands (
  name TEXT PRIMARY KEY COLLATE NOCASE, owner_name TEXT, owner_country TEXT,
  source TEXT, evidence_url TEXT, checked_at INTEGER
);
CREATE TABLE IF NOT EXISTS sellers (
  seller_id TEXT PRIMARY KEY, name TEXT, address TEXT, country TEXT, source TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- search | product | seller | brand
  target TEXT NOT NULL,          -- search term, ASIN, seller id or brand name
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, origin TEXT, created_at INTEGER, updated_at INTEGER,
  UNIQUE(kind, target)
);
CREATE INDEX IF NOT EXISTS queue_ready ON queue(status, next_try_at, priority);
CREATE TABLE IF NOT EXISTS collector_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT, event TEXT, detail TEXT
);
`);

// A crash mid-job leaves rows in 'running'; put them back so nothing is lost.
db.prepare(`UPDATE queue SET status='pending' WHERE status='running'`).run();

export const now = () => Date.now();

export function log(level, event, detail = '') {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  db.prepare('INSERT INTO collector_log (ts, level, event, detail) VALUES (?,?,?,?)').run(now(), level, event, text);
  console.log(`${new Date().toISOString()} ${level.padEnd(5)} ${event} ${text}`);
}

/** Add work to the queue. Existing items are re-armed when they failed (or, with rearm, when done). */
export function enqueue(kind, target, { priority = 0, origin = 'collector', rearm = false } = {}) {
  const t = now();
  const again = rearm ? `status IN ('failed','done')` : `status = 'failed'`;
  const r = db.prepare(`INSERT INTO queue (kind, target, priority, origin, created_at, updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(kind, target) DO UPDATE SET
      priority = max(priority, excluded.priority),
      status = CASE WHEN ${again} THEN 'pending' ELSE status END,
      attempts = CASE WHEN ${again} THEN 0 ELSE attempts END,
      next_try_at = CASE WHEN ${again} THEN 0 ELSE next_try_at END`)
    .run(kind, target, priority, origin, t, t);
  return r.changes > 0;
}
