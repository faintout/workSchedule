import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { passwordHash } from './auth.js';
import { COLORS, type Schedule, type User } from './types.js';

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createDatabase(path: string, initialAdminPassword?: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 2) throw new Error('数据库版本高于当前应用，请使用新版应用');
    if (version === 0) transaction(db, () => {
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY, original_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
          display_name TEXT NOT NULL, normalized_display_name TEXT NOT NULL UNIQUE,
          suffix INTEGER NOT NULL, registration_sequence INTEGER NOT NULL UNIQUE,
          color_index INTEGER NOT NULL CHECK(color_index BETWEEN 0 AND 9), disabled_at TEXT
        );
        CREATE INDEX users_name ON users(normalized_name);
        CREATE TABLE schedules (
          user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL,
          normal_shift TEXT NOT NULL CHECK(normal_shift IN ('none','morning','afternoon','full','rest')),
          overtime INTEGER NOT NULL CHECK(overtime IN (0,1)), version INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,date),
          CHECK(normal_shift != 'none' OR overtime = 1), CHECK(normal_shift != 'rest' OR overtime = 0)
        );
        CREATE INDEX schedules_date ON schedules(date);
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('member','admin')),
          user_id TEXT REFERENCES users(id), expires_at TEXT NOT NULL
        );
        CREATE INDEX sessions_user ON sessions(user_id);
        CREATE TABLE operation_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, actor_role TEXT NOT NULL, actor_name TEXT NOT NULL,
          action TEXT NOT NULL, target_user_id TEXT, target_name TEXT NOT NULL, date TEXT,
          before_value TEXT, after_value TEXT, occurred_at TEXT NOT NULL
        );
        CREATE INDEX operation_logs_time ON operation_logs(occurred_at DESC,id DESC);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings(key,value) VALUES ('next_registration_sequence','1'),('next_schedule_version','1');
        PRAGMA user_version = 2;
      `);
    });
    if (version === 1) {
      if (path !== ':memory:') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const destination = join(dirname(path), 'backups', `schedule-before-v2-${stamp}.sqlite`);
        mkdirSync(dirname(destination), { recursive: true });
        db.prepare('VACUUM INTO ?').run(destination);
      }
      transaction(db, () => {
        db.exec(`
          CREATE TABLE schedules_v2 (
            user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL,
            normal_shift TEXT NOT NULL CHECK(normal_shift IN ('none','morning','afternoon','full','rest')),
            overtime INTEGER NOT NULL CHECK(overtime IN (0,1)), version INTEGER NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,date),
            CHECK(normal_shift != 'none' OR overtime = 1), CHECK(normal_shift != 'rest' OR overtime = 0)
          );
          INSERT INTO schedules_v2 SELECT * FROM schedules;
          DROP TABLE schedules;
          ALTER TABLE schedules_v2 RENAME TO schedules;
          CREATE INDEX schedules_date ON schedules(date);
          PRAGMA user_version = 2;
        `);
      });
    }
    if (!db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get()) {
      if (!initialAdminPassword || initialAdminPassword.length < 6 || initialAdminPassword.length > 256) {
        throw new Error('首次启动必须设置 ADMIN_PASSWORD，长度为 6–256 个字符');
      }
      db.prepare("INSERT INTO settings(key,value) VALUES ('admin_password_hash',?)").run(passwordHash(initialAdminPassword));
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function userFromRow(row: Record<string, unknown>): User {
  const colorIndex = Number(row.color_index);
  return {
    id: String(row.id), originalName: String(row.original_name), displayName: String(row.display_name),
    registrationSequence: Number(row.registration_sequence), colorIndex, color: COLORS[colorIndex]!,
    disabledAt: row.disabled_at == null ? null : String(row.disabled_at),
  };
}

export function getUser(db: DatabaseSync, id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? userFromRow(row) : null;
}

export function scheduleFromRow(row: Record<string, unknown>): Schedule {
  return {
    userId: String(row.user_id), date: String(row.date), normalShift: row.normal_shift as Schedule['normalShift'],
    overtime: Boolean(row.overtime), version: Number(row.version),
  };
}

export function getSchedule(db: DatabaseSync, userId: string, date: string): Schedule | null {
  const row = db.prepare('SELECT * FROM schedules WHERE user_id = ? AND date = ?').get(userId, date);
  return row ? scheduleFromRow(row) : null;
}

export function nextNumber(db: DatabaseSync, key: 'next_registration_sequence' | 'next_schedule_version'): number {
  const value = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)!.value);
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value + 1), key);
  return value;
}

export function insertUser(db: DatabaseSync, name: string, key: string): User {
  let suffix = 0;
  while (db.prepare('SELECT 1 FROM users WHERE normalized_display_name = ?').get(key + (suffix || ''))) suffix++;
  const id = randomUUID();
  const sequence = nextNumber(db, 'next_registration_sequence');
  db.prepare(`INSERT INTO users(id,original_name,normalized_name,display_name,normalized_display_name,suffix,registration_sequence,color_index)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, name, key, name + (suffix || ''), key + (suffix || ''), suffix, sequence, (sequence - 1) % COLORS.length);
  return getUser(db, id)!;
}

export function logOperation(db: DatabaseSync, actor: { role: string; name: string }, action: string, target: User, date: string | null, before: unknown, after: unknown, now: Date) {
  db.prepare(`INSERT INTO operation_logs(actor_role,actor_name,action,target_user_id,target_name,date,before_value,after_value,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(actor.role, actor.name, action, target.id, target.displayName, date,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), now.toISOString());
}
