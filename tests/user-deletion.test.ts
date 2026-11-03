import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';
import { COLORS, type User } from '../server/types.js';

const PASSWORD = 'test-admin-123';
function setup(databasePath = ':memory:') {
  return createApp({ databasePath, adminPassword: PASSWORD, now: () => new Date('2026-11-02T02:00:00.000Z'),
    holidayFetch: async () => { throw new Error('offline fixture'); }, startHolidayJobs: false, startBackupJobs: false });
}
function cookie(response: { headers: Record<string, unknown> }) {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : [value]).map(item => String(item).split(';')[0]).join('; ');
}
async function administrator(app: FastifyInstance) {
  const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return cookie(response);
}
async function addUser(app: FastifyInstance, adminCookie?: string) {
  const response = await app.inject({ method: 'POST', url: adminCookie ? '/api/admin/users' : '/api/identity',
    headers: { cookie: adminCookie ?? '' }, payload: { name: '张三' } });
  assert.equal(response.statusCode, 200, response.body);
  return { user: response.json().user as User, cookie: cookie(response) };
}
async function deleteUser(app: FastifyInstance, userId: string, adminCookie: string) {
  const response = await app.inject({ method: 'DELETE', url: `/api/admin/users/${userId}`, headers: { cookie: adminCookie } });
  assert.equal(response.statusCode, 200, response.body);
}
function releasedColors(db: DatabaseSync): number[] {
  return JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key = 'released_color_indexes'").get()?.value ?? '[]'));
}

test('member and administrator additions reuse released colors in deletion order before continuing the palette', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const adminCookie = await administrator(app);
  const people = [];
  for (let i = 0; i < 6; i++) people.push(await addUser(app));
  await deleteUser(app, people[4].user.id, adminCookie);
  await deleteUser(app, people[1].user.id, adminCookie);
  assert.deepEqual(releasedColors(db), [4, 1]);
  const claim = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '张三', userId: people[0].user.id } });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.deepEqual(releasedColors(db), [4, 1]);
  const first = await addUser(app, adminCookie);
  const second = await addUser(app);
  const third = await addUser(app, adminCookie);
  assert.deepEqual([first.user.color, second.user.color, third.user.color], [COLORS[4], COLORS[1], COLORS[6]]);
  assert.deepEqual(releasedColors(db), []);
  for (const person of people) {
    assert.equal(db.prepare('SELECT color_index FROM users WHERE id = ?').get(person.user.id)!.color_index, person.user.colorIndex);
  }
});

test('zero active users and complete palette cycles discard released colors and restart the constant order', async t => {
  for (const initialCount of [2, COLORS.length + 1, COLORS.length * 2 + 1]) {
    await t.test(`${initialCount} users before deletion`, async t => {
      const { app, db } = await setup();
      t.after(() => app.close());
      const adminCookie = await administrator(app);
      const people = [];
      for (let i = 0; i < initialCount; i++) people.push(await addUser(app));
      if (initialCount === 2) {
        await deleteUser(app, people[1].user.id, adminCookie);
        await deleteUser(app, people[0].user.id, adminCookie);
        assert.deepEqual(releasedColors(db), [1, 0]);
      } else {
        await deleteUser(app, people[5].user.id, adminCookie);
        assert.deepEqual(releasedColors(db), [5]);
      }
      const first = await addUser(app);
      assert.equal(first.user.color, COLORS[0]);
      assert.deepEqual(releasedColors(db), []);
      assert.equal((await addUser(app, adminCookie)).user.color, COLORS[1]);
    });
  }
});

test('unauthorized and repeated deletions do not release colors or change deleted accounts', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const first = await addUser(app);
  const other = await addUser(app);
  const adminCookie = await administrator(app);
  for (const sessionCookie of ['', other.cookie]) {
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/users/${first.user.id}`, headers: { cookie: sessionCookie } })).statusCode, 403);
  }
  assert.deepEqual(releasedColors(db), []);
  await deleteUser(app, first.user.id, adminCookie);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(first.user.id);
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id').all();
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/users/${first.user.id}`, headers: { cookie: adminCookie } })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/admin/users/${first.user.id}/deletion-preview`, headers: { cookie: adminCookie } })).statusCode, 404);
  assert.deepEqual(releasedColors(db), [0]);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(first.user.id), row);
  assert.deepEqual(db.prepare('SELECT * FROM operation_logs ORDER BY id').all(), logs);
  assert.deepEqual((await app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })).json().users.map((user: User) => user.id), [other.user.id]);
});

test('deleted state and released colors survive reopening the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-deletion-'));
  const databasePath = join(directory, 'schedule.sqlite');
  let runtime = await setup(databasePath);
  try {
    const adminCookie = await administrator(runtime.app);
    const people = [];
    for (let i = 0; i < 4; i++) people.push(await addUser(runtime.app));
    await deleteUser(runtime.app, people[2].user.id, adminCookie);
    await runtime.app.close();
    runtime = await setup(databasePath);
    assert.deepEqual(releasedColors(runtime.db), [2]);
    assert.ok(runtime.db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(people[2].user.id)!.deleted_at);
    assert.equal((await runtime.app.inject({ url: '/api/session', headers: { cookie: people[2].cookie } })).json().user, null);
    assert.equal((await addUser(runtime.app, adminCookie)).user.color, COLORS[2]);
    assert.equal((await addUser(runtime.app)).user.color, COLORS[4]);
  } finally {
    await runtime.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed operation logs roll back soft deletion, released colors and color consumption', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const adminCookie = await administrator(app);
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await addUser(app));
  await deleteUser(app, people[1].user.id, adminCookie);
  const target = people[3];
  for (const date of ['2026-11-02', '2026-11-03']) {
    const saved = await app.inject({ method: 'PUT', url: `/api/schedules/${target.user.id}/${date}`, headers: { cookie: target.cookie },
      payload: { normalShift: 'full', overtime: false, version: null } });
    assert.equal(saved.statusCode, 200, saved.body);
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(target.user.id);
  const schedules = db.prepare('SELECT * FROM schedules ORDER BY date').all();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY token_hash').all();
  const logs = db.prepare('SELECT * FROM operation_logs ORDER BY id').all();
  db.exec("CREATE TRIGGER reject_delete_log BEFORE INSERT ON operation_logs WHEN NEW.action = 'user.delete' BEGIN SELECT RAISE(ABORT, 'test log failure'); END;");
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/users/${target.user.id}`, headers: { cookie: adminCookie } })).statusCode, 500);
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(target.user.id), row);
  assert.deepEqual(db.prepare('SELECT * FROM schedules ORDER BY date').all(), schedules);
  assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY token_hash').all(), sessions);
  assert.deepEqual(db.prepare('SELECT * FROM operation_logs ORDER BY id').all(), logs);
  assert.deepEqual(releasedColors(db), [1]);
  db.exec('DROP TRIGGER reject_delete_log;');
  await deleteUser(app, target.user.id, adminCookie);
  assert.deepEqual(releasedColors(db), [1, 3]);
  const users = db.prepare('SELECT * FROM users ORDER BY registration_sequence').all();
  const settings = db.prepare('SELECT * FROM settings ORDER BY key').all();
  db.exec("CREATE TRIGGER reject_create_log BEFORE INSERT ON operation_logs WHEN NEW.action = 'user.create' BEGIN SELECT RAISE(ABORT, 'test log failure'); END;");
  for (const url of ['/api/identity', '/api/admin/users']) {
    assert.equal((await app.inject({ method: 'POST', url, headers: { cookie: adminCookie }, payload: { name: '李四' } })).statusCode, 500);
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY registration_sequence').all(), users);
    assert.deepEqual(db.prepare('SELECT * FROM settings ORDER BY key').all(), settings);
  }
  db.exec('DROP TRIGGER reject_create_log;');
  assert.equal((await addUser(app, adminCookie)).user.color, COLORS[1]);
  assert.equal((await addUser(app)).user.color, COLORS[3]);
});
