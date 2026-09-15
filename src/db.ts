import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,
  product_name   TEXT NOT NULL,
  brand          TEXT,
  sku            TEXT,
  unit           TEXT NOT NULL DEFAULT 'unit',
  package_size   REAL,
  package_unit   TEXT,
  latest_price   REAL,
  currency       TEXT,
  min_quantity   REAL,
  target_quantity REAL,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS items_identity
  ON items (lower(product_name), lower(coalesce(brand, '')));
CREATE INDEX IF NOT EXISTS items_sku ON items (sku);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS locations_name ON locations (lower(name));

CREATE TABLE IF NOT EXISTS stock (
  item_id     TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  quantity    REAL NOT NULL DEFAULT 0,
  expires_on  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, location_id)
);

CREATE TABLE IF NOT EXISTS pantry_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  location_id     TEXT NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  change_type     TEXT NOT NULL,
  quantity_before REAL NOT NULL,
  quantity_delta  REAL NOT NULL,
  quantity_after  REAL NOT NULL,
  unit            TEXT,
  source          TEXT NOT NULL,
  note            TEXT,
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  batch_id        TEXT
);
CREATE INDEX IF NOT EXISTS pantry_events_item ON pantry_events (item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS pantry_events_time ON pantry_events (occurred_at DESC);

CREATE TABLE IF NOT EXISTS price_observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  price       REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  store       TEXT,
  quantity    REAL,
  observed_on TEXT NOT NULL,
  source      TEXT NOT NULL,
  note        TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_obs_item ON price_observations (item_id, observed_on DESC);

-- Replay guard: an AI client that retries a photo upload must not double-log history.
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  client_secret              TEXT,
  client_name                TEXT,
  redirect_uris              TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  grant_types                TEXT NOT NULL,
  response_types             TEXT NOT NULL,
  scope                      TEXT,
  created_at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_authorizations (
  state                 TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  client_state          TEXT,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT,
  resource              TEXT,
  created_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT,
  user_sub              TEXT NOT NULL,
  user_email            TEXT NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed              INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  user_sub   TEXT NOT NULL,
  user_email TEXT NOT NULL,
  scope      TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_user ON oauth_tokens (user_sub);
`;

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'pantry.sqlite'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** Drop expired authorization codes, pending authorizations and access tokens. */
export function pruneExpired(db: DatabaseSync): void {
  const now = Date.now();
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM oauth_authorizations WHERE created_at < ?').run(now - 15 * 60 * 1000);
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
}
