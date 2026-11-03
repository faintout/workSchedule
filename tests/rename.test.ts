import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import type { User } from '../server/types.js';

const PASSWORD = 'test-admin-123';
const NOW = new Date('2026-11-02T02:00:00.000Z');
function setup(databasePath = ':memory:') {
  return createApp({ databasePath, adminPassword: PASSWORD, now: () => NOW,
    holidayFetch: async () => { throw new Error('offline fixture'); }, startHolidayJobs: false, startBackupJobs: false });
}
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : [value]).map(item => String(item).split(';')[0]).join('; ');
}
async function member(app: FastifyInstance, name: string) {
  const response = await app.inject({ method: 'POST', url: '/api/identity', payload: { name } });
  assert.equal(response.statusCode, 200, response.body);
  return { user: response.json().user as User, cookie: cookie(response) };
}
async function administrator(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return cookie(response);
}
function rename(app: FastifyInstance, sessionCookie: string, name: unknown, id?: string, userId?: string) {
  return app.inject({ method: 'PUT', url: id ? `/api/admin/users/${id}` : '/api/identity',
    headers: { cookie: sessionCookie }, payload: { name, userId } });
}
async function candidates(app: FastifyInstance, name: string): Promise<User[]> {
  return (await app.inject({ method: 'POST', url: '/api/identity/candidates', payload: { name } })).json().users;
}

test('renaming requires the appropriate session and ignores forged target IDs on self updates', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const first = await member(app, '张三');
  const other = await member(app, '李四');
  const adminCookie = await administrator(app);
  assert.equal((await rename(app, '', '王五')).statusCode, 401);
  assert.equal((await rename(app, adminCookie, '王五')).statusCode, 401);
  for (const sessionCookie of ['', first.cookie]) {
    assert.equal((await rename(app, sessionCookie, '王五', other.user.id)).statusCode, 403);
  }
  assert.equal((await rename(app, adminCookie, '王五', 'missing-user')).statusCode, 404);
  const updated = await rename(app, first.cookie, '王五', undefined, other.user.id);
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().user.id, first.user.id);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: other.cookie } })).json().user.displayName, '李四');
});

test('renaming validates names without changing the user or adding logs', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const person = await member(app, '张三');
  const adminCookie = await administrator(app);
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id);
  const logCount = db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count;
  for (const name of [undefined, null, 42, '', '  ', '张 三', '张三1', '张三!', 'abcdefghijk']) {
    for (const [sessionCookie, id] of [[person.cookie, undefined], [adminCookie, person.user.id]] as const) {
      const response = await rename(app, sessionCookie, name, id);
      assert.equal(response.statusCode, 400, response.body);
    }
  }
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count, logCount);
});

test('self rename synchronizes stored fields, existing sessions, claims and month users while preserving schedules and log history', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const person = await member(app, '张三');
  const claim = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '张三', userId: person.user.id } });
  const secondCookie = cookie(claim);
  const saved = await app.inject({ method: 'PUT', url: `/api/schedules/${person.user.id}/2026-11-02`, headers: { cookie: person.cookie },
    payload: { normalShift: 'full', overtime: true, version: null } });
  assert.equal(saved.statusCode, 200, saved.body);
  const schedulesBefore = db.prepare('SELECT * FROM schedules').all();
  const sessionsBefore = db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
  const oldLogs = db.prepare('SELECT * FROM operation_logs ORDER BY id').all();
  const response = await rename(app, person.cookie, '  Alice  ');
  assert.equal(response.statusCode, 200, response.body);
  const updated = response.json().user as User;
  assert.deepEqual(updated, { ...person.user, originalName: 'Alice', displayName: 'Alice' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id)!;
  assert.deepEqual([row.original_name, row.normalized_name, row.display_name, row.normalized_display_name, row.suffix], ['Alice', 'alice', 'Alice', 'alice', 0]);
  assert.deepEqual(db.prepare('SELECT * FROM schedules').all(), schedulesBefore);
  assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(), sessionsBefore);
  for (const sessionCookie of [person.cookie, secondCookie]) {
    assert.deepEqual((await app.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).json().user, updated);
  }
  assert.deepEqual(await candidates(app, '张三'), []);
  assert.deepEqual(await candidates(app, 'ALICE'), [updated]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '张三', userId: person.user.id } })).statusCode, 404);
  const newClaim = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: 'ALICE', userId: person.user.id } });
  assert.equal(newClaim.statusCode, 200, newClaim.body);
  assert.deepEqual(newClaim.json().user, updated);
  const month = (await app.inject('/api/month?month=2026-11')).json();
  assert.deepEqual(month.users, [updated]);
  assert.deepEqual(month.schedules, [saved.json().schedule]);
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id').all();
  assert.deepEqual(logs.slice(0, -1), oldLogs);
  const log = logs.at(-1)!;
  assert.equal(log.action, 'user.rename');
  assert.equal(log.actor_role, 'member');
  assert.equal(log.actor_name, '张三');
  assert.equal(log.target_name, 'Alice');
  assert.deepEqual(JSON.parse(String(log.before_value)), person.user);
  assert.deepEqual(JSON.parse(String(log.after_value)), updated);
});

test('rename uses case insensitive suffixes, preserves suffixes for unchanged names and rejects deleted users', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const first = await member(app, 'Alice');
  const duplicate = await member(app, 'alice');
  const other = await member(app, '张三');
  const adminCookie = await administrator(app);
  const collision = await rename(app, other.cookie, 'ALICE');
  assert.equal(collision.statusCode, 200, collision.body);
  assert.equal(collision.json().user.displayName, 'ALICE2');
  assert.equal(db.prepare('SELECT suffix FROM users WHERE id = ?').get(other.user.id)!.suffix, 2);
  const freed = await rename(app, adminCookie, 'Bob', first.user.id);
  assert.equal(freed.statusCode, 200, freed.body);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: first.cookie } })).json().user.displayName, 'Bob');
  const count = db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count;
  const unchanged = await rename(app, duplicate.cookie, ' alice ');
  assert.deepEqual(unchanged.json().user, duplicate.user);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count, count);
  const casing = await rename(app, duplicate.cookie, 'ALICE');
  assert.equal(casing.statusCode, 200, casing.body);
  assert.equal(casing.json().user.displayName, 'ALICE1');
  const renamed = await rename(app, `${duplicate.cookie}; ${adminCookie}`, '李四', first.user.id);
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().user.displayName, '李四');
  const log = db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT 1').get()!;
  assert.equal(log.actor_role, 'admin');
  assert.equal(log.actor_name, '管理员（当前身份：ALICE1）');
  const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/users/${first.user.id}`, headers: { cookie: adminCookie } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await rename(app, first.cookie, '无权限')).statusCode, 401);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(first.user.id);
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id').all();
  assert.equal((await rename(app, adminCookie, '王五', first.user.id)).statusCode, 404);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(first.user.id), row);
  assert.deepEqual(db.prepare('SELECT * FROM operation_logs ORDER BY id').all(), logs);
  assert.deepEqual(await candidates(app, '李四'), []);
});

test('rename and operation log commit together and rollback leaves the prior identity usable', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const person = await member(app, '张三');
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id);
  const logCount = db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count;
  db.exec("CREATE TRIGGER reject_rename_log BEFORE INSERT ON operation_logs WHEN NEW.action = 'user.rename' BEGIN SELECT RAISE(ABORT, 'test log failure'); END;");
  assert.equal((await rename(app, person.cookie, '李四')).statusCode, 500);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count, logCount);
  assert.deepEqual((await app.inject({ url: '/api/session', headers: { cookie: person.cookie } })).json().user, person.user);
  db.exec('DROP TRIGGER reject_rename_log;');
  assert.equal((await rename(app, person.cookie, '李四')).statusCode, 200);
});

test('renamed users and existing sessions survive a database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-rename-'));
  const databasePath = join(directory, 'schedule.sqlite');
  let runtime = await setup(databasePath);
  try {
    const person = await member(runtime.app, '张三');
    const adminCookie = await administrator(runtime.app);
    const response = await rename(runtime.app, adminCookie, '李四', person.user.id);
    assert.equal(response.statusCode, 200, response.body);
    await runtime.app.close();
    runtime = await setup(databasePath);
    assert.deepEqual((await runtime.app.inject({ url: '/api/session', headers: { cookie: person.cookie } })).json().user, response.json().user);
    assert.deepEqual(await candidates(runtime.app, '李四'), [response.json().user]);
    assert.deepEqual(await candidates(runtime.app, '张三'), []);
    const logs = (await runtime.app.inject({ url: '/api/admin/logs?date=2026-11-02', headers: { cookie: adminCookie } })).json().logs;
    assert.equal(logs[0].action, 'user.rename');
    assert.equal(logs[0].after.displayName, '李四');
  } finally {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
