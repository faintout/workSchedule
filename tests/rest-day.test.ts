import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';

const options = { adminPassword: 'rest-test-password', startHolidayJobs: false, startBackupJobs: false };

test('rest round trips, rejects overtime and uses existing permissions, versions, deletion and logs', async t => {
  const { app, db } = await createApp({ ...options, databasePath: ':memory:', now: () => new Date('2026-11-02T00:00:00Z') });
  t.after(() => app.close());
  const registration = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '休班测试' } });
  const user = registration.json().user;
  const cookie = String(registration.headers['set-cookie']).split(';')[0];
  const url = `/api/schedules/${user.id}/2026-11-02`;
  const write = (normalShift: string, overtime: boolean, version: number | null, session = cookie) => app.inject({
    method: 'PUT', url, headers: { cookie: session }, payload: { normalShift, overtime, version },
  });
  assert.equal((await write('rest', false, null, '')).statusCode, 401);
  assert.equal((await write('rest', true, null)).statusCode, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedules').get()!.count, 0);
  const saved = await write('rest', false, null);
  assert.equal(saved.statusCode, 200, saved.body);
  const rest = saved.json().schedule;
  assert.equal(rest.normalShift, 'rest');
  assert.equal(rest.overtime, false);
  assert.equal((await write('rest', false, null)).statusCode, 409);
  const month = (await app.inject('/api/month?month=2026-11')).json();
  assert.deepEqual(month.schedules, [rest]);
  assert.equal((await write('rest', true, rest.version)).statusCode, 400);
  assert.deepEqual((await app.inject('/api/month?month=2026-11')).json().schedules, [rest]);

  const other = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '另一人' } });
  const otherCookie = String(other.headers['set-cookie']).split(';')[0];
  assert.equal((await write('rest', false, rest.version, otherCookie)).statusCode, 403);
  const working = (await write('full', true, rest.version)).json().schedule;
  assert.equal(working.normalShift, 'full');
  assert.equal(working.overtime, true);
  const login = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: options.adminPassword } });
  const adminCookie = String(login.headers['set-cookie']).split(';')[0];
  const changed = await write('rest', false, working.version, adminCookie);
  assert.equal(changed.statusCode, 200, changed.body);
  const restored = changed.json().schedule;
  assert.ok(restored.version > working.version);
  const logs = (await app.inject({ url: '/api/admin/logs?date=2026-11-02', headers: { cookie: adminCookie } })).json().logs;
  const update = logs.find((log: { action: string }) => log.action === 'schedule.update');
  assert.equal(update.before.normalShift, 'full');
  assert.equal(update.after.normalShift, 'rest');
  assert.equal(update.after.overtime, false);
  assert.equal((await write('none', false, restored.version)).json().schedule, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedules').get()!.count, 0);
  const recreated = (await write('rest', false, null)).json().schedule;
  assert.ok(recreated.version > restored.version);
  assert.equal((await app.inject({ method: 'DELETE', url, headers: { cookie }, payload: { version: recreated.version } })).statusCode, 200);
  assert.deepEqual((await app.inject('/api/month?month=2026-11')).json().schedules, []);
});

test('v1 migration backs up existing data and preserves records, sessions and rest across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-rest-'));
  const databasePath = join(directory, 'schedule.sqlite');
  let runtime = await createApp({ ...options, databasePath });
  try {
    const registration = await runtime.app.inject({ method: 'POST', url: '/api/identity', payload: { name: '迁移测试' } });
    const user = registration.json().user;
    const cookie = String(registration.headers['set-cookie']).split(';')[0];
    const url = `/api/schedules/${user.id}/2026-11-02`;
    const saved = await runtime.app.inject({ method: 'PUT', url, headers: { cookie }, payload: { normalShift: 'full', overtime: true, version: null } });
    assert.equal(saved.statusCode, 200, saved.body);
    const before = saved.json().schedule;
    const originalLogs = runtime.db.prepare('SELECT * FROM operation_logs').all();
    const originalSessions = runtime.db.prepare('SELECT * FROM sessions').all();
    const originalRow = runtime.db.prepare('SELECT * FROM schedules').get();
    await runtime.app.close();

    // Restore the v1 table definition; the other tables are unchanged between versions.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE schedules_v1 (
        user_id TEXT NOT NULL REFERENCES users(id), date TEXT NOT NULL,
        normal_shift TEXT NOT NULL CHECK(normal_shift IN ('none','morning','afternoon','full')),
        overtime INTEGER NOT NULL CHECK(overtime IN (0,1)), version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,date),
        CHECK(normal_shift != 'none' OR overtime = 1)
      );
      INSERT INTO schedules_v1 SELECT * FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules_v1 RENAME TO schedules;
      CREATE INDEX schedules_date ON schedules(date);
      PRAGMA user_version = 1;
      COMMIT;
    `);
    legacy.close();

    runtime = await createApp({ ...options, adminPassword: undefined, databasePath });
    assert.equal(runtime.db.prepare('PRAGMA user_version').get()!.user_version, 2);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM schedules').get(), originalRow);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM operation_logs').all(), originalLogs);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM sessions').all(), originalSessions);
    assert.equal((await runtime.app.inject({ url: '/api/session', headers: { cookie } })).json().user.id, user.id);
    assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(runtime.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.ok(runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='schedules_date'").get());
    assert.throws(() => runtime.db.prepare("UPDATE schedules SET normal_shift='rest',overtime=1").run(), /CHECK constraint/);

    const backups = readdirSync(join(directory, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0]!, /^schedule-before-v2-.*\.sqlite$/);
    const backup = new DatabaseSync(join(directory, 'backups', backups[0]!), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 1);
      assert.equal(backup.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      assert.deepEqual(backup.prepare('SELECT * FROM schedules').get(), originalRow);
      assert.deepEqual(backup.prepare('SELECT * FROM operation_logs').all(), originalLogs);
      assert.deepEqual(backup.prepare('SELECT * FROM sessions').all(), originalSessions);
    } finally { backup.close(); }
    const rest = await runtime.app.inject({ method: 'PUT', url, headers: { cookie }, payload: { normalShift: 'rest', overtime: false, version: before.version } });
    assert.equal(rest.statusCode, 200, rest.body);
    await runtime.app.close();
    runtime = await createApp({ ...options, adminPassword: undefined, databasePath });
    assert.deepEqual((await runtime.app.inject('/api/month?month=2026-11')).json().schedules, [rest.json().schedule]);
    assert.equal((await runtime.app.inject({ url: '/api/session', headers: { cookie } })).json().user.id, user.id);
    assert.equal(readdirSync(join(directory, 'backups')).length, 1);
  } finally {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
