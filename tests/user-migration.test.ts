import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { COLORS, type User } from '../server/types.js';

test('v2 migration preserves legacy users, historical rest, sessions and logs while restoring released colors once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-user-migration-'));
  const databasePath = join(directory, 'schedule.sqlite');
  let clock = new Date('2026-11-02T02:00:00.000Z');
  const options = { databasePath, now: () => clock, startHolidayJobs: false, startBackupJobs: false,
    holidayFetch: async () => { throw new Error('offline fixture'); } };
  let runtime = await createApp({ ...options, adminPassword: 'migration-admin-123' });
  try {
    const login = await runtime.app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: 'migration-admin-123' } });
    assert.equal(login.statusCode, 200, login.body);
    const adminCookie = String(login.headers['set-cookie']).split(';')[0];
    const people: { user: User; cookie: string }[] = [];
    for (const name of ['在用成员', '旧成员甲', '旧成员乙']) {
      const response = await runtime.app.inject({ method: 'POST', url: '/api/identity', payload: { name } });
      assert.equal(response.statusCode, 200, response.body);
      people.push({ user: response.json().user, cookie: String(response.headers['set-cookie']).split(';')[0] });
    }
    const historical = await runtime.app.inject({ method: 'PUT', url: `/api/schedules/${people[2].user.id}/2026-11-01`,
      headers: { cookie: people[2].cookie }, payload: { normalShift: 'rest', overtime: false, version: null } });
    assert.equal(historical.statusCode, 200, historical.body);
    for (const person of [people[2], people[1]]) {
      const response = await runtime.app.inject({ method: 'DELETE', url: `/api/admin/users/${person.user.id}`, headers: { cookie: adminCookie } });
      assert.equal(response.statusCode, 200, response.body);
      clock = new Date(clock.getTime() + 1000);
    }
    await runtime.app.close();

    const legacy = new DatabaseSync(databasePath);
    let originalUsers, originalSchedules, originalSessions, originalLogs;
    try {
      legacy.exec("ALTER TABLE users RENAME COLUMN deleted_at TO disabled_at; DELETE FROM settings WHERE key = 'released_color_indexes'; PRAGMA user_version = 2;");
      for (const row of legacy.prepare('SELECT id,before_value,after_value FROM operation_logs').all()) {
        const oldSnapshot = (value: unknown) => {
          if (value == null) return null;
          const snapshot = JSON.parse(String(value));
          if (!Object.hasOwn(snapshot, 'deletedAt')) return String(value);
          const { deletedAt, ...fields } = snapshot;
          return JSON.stringify({ ...fields, disabledAt: deletedAt });
        };
        legacy.prepare('UPDATE operation_logs SET before_value = ?, after_value = ? WHERE id = ?')
          .run(oldSnapshot(row.before_value), oldSnapshot(row.after_value), row.id);
      }
      legacy.exec("UPDATE operation_logs SET action = 'user.disable' WHERE action = 'user.delete';");
      originalUsers = legacy.prepare('SELECT * FROM users ORDER BY registration_sequence').all();
      originalSchedules = legacy.prepare('SELECT * FROM schedules').all();
      originalSessions = legacy.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
      originalLogs = legacy.prepare('SELECT * FROM operation_logs ORDER BY id').all();
    } finally { legacy.close(); }

    runtime = await createApp(options);
    assert.equal(runtime.db.prepare('PRAGMA user_version').get()!.user_version, 3);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM users ORDER BY registration_sequence').all().map(row => ({ ...row })),
      originalUsers.map(({ disabled_at, ...fields }) => ({ ...fields, deleted_at: disabled_at })));
    assert.deepEqual(runtime.db.prepare('SELECT * FROM schedules').all(), originalSchedules);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(), originalSessions);
    assert.deepEqual(runtime.db.prepare('SELECT * FROM operation_logs ORDER BY id').all(), originalLogs);
    assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((await runtime.app.inject({ url: '/api/session', headers: { cookie: people[0].cookie } })).json().user.id, people[0].user.id);
    assert.equal((await runtime.app.inject({ url: '/api/session', headers: { cookie: people[2].cookie } })).json().user, null);
    const visible = (await runtime.app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })).json().users;
    assert.deepEqual(visible.map((user: User) => user.id), [people[0].user.id]);
    assert.deepEqual((await runtime.app.inject('/api/month?month=2026-11')).json().schedules, [historical.json().schedule]);
    assert.equal(runtime.db.prepare("SELECT value FROM settings WHERE key = 'released_color_indexes'").get()!.value, '[2,1]');

    const backups = readdirSync(join(directory, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^schedule-before-v3-.*\.sqlite$/);
    const backup = new DatabaseSync(join(directory, 'backups', backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 2);
      assert.deepEqual(backup.prepare('SELECT * FROM users ORDER BY registration_sequence').all(), originalUsers);
      assert.deepEqual(backup.prepare('SELECT * FROM schedules').all(), originalSchedules);
      assert.deepEqual(backup.prepare('SELECT * FROM sessions ORDER BY token_hash').all(), originalSessions);
      assert.deepEqual(backup.prepare('SELECT * FROM operation_logs ORDER BY id').all(), originalLogs);
      assert.equal(backup.prepare("SELECT value FROM settings WHERE key = 'released_color_indexes'").get(), undefined);
    } finally { backup.close(); }

    const added = await runtime.app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: adminCookie }, payload: { name: '新成员' } });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().user.color, COLORS[2]);
    await runtime.app.close();
    runtime = await createApp(options);
    assert.equal(runtime.db.prepare("SELECT value FROM settings WHERE key = 'released_color_indexes'").get()!.value, '[1]');
    assert.deepEqual(readdirSync(join(directory, 'backups')), backups);
  } finally {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
