const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kudos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  message_hash TEXT NOT NULL,
  is_visible INTEGER NOT NULL DEFAULT 1,
  moderated_by INTEGER REFERENCES users(id),
  moderated_at DATETIME,
  moderation_reason TEXT,
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (recipient_id <> sender_id)
);
CREATE INDEX IF NOT EXISTS idx_kudos_feed ON kudos (is_visible, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kudos_sender_created ON kudos (sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_kudos_dupe ON kudos (sender_id, recipient_id, message_hash, created_at);

CREATE TABLE IF NOT EXISTS kudos_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kudos_id INTEGER NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kudos_id, reporter_id)
);

CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kudos_id INTEGER NOT NULL,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('hide','restore','delete','auto_hide')),
  reason TEXT,
  message_snapshot TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function createDb(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function seed(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return;
  const insert = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)');
  const adminHash = bcrypt.hashSync('Admin123!', 10);
  const userHash = bcrypt.hashSync('User123!', 10);
  insert.run('Alex Admin', 'admin@example.com', adminHash, 'admin');
  [
    ['Aroha Kingi', 'aroha@example.com'],
    ['Sam Lee', 'sam@example.com'],
    ['Mei Chen', 'mei@example.com'],
    ['Liam Walker', 'liam@example.com'],
    ['Priya Patel', 'priya@example.com'],
  ].forEach(([n, e]) => insert.run(n, e, userHash, 'user'));
}

module.exports = { createDb, seed };
