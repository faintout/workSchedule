import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createApp } from '../server/app.js';
import { createDatabase } from '../server/db.js';
import { COLORS, type User } from '../server/types.js';

const PASSWORD = 'test-admin-123';
const offlineFetch: typeof fetch = async () => { throw new Error('offline fixture'); };
function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  return (Array.isArray(value) ? value : [value]).map(item => String(item).split(';')[0]).join('; ');
}
async function member(app: FastifyInstance, name = '张三'): Promise<{ user: User; cookie: string }> {
  const response = await app.inject({ method: 'POST', url: '/api/identity', payload: { name } });
  assert.equal(response.statusCode, 200, response.body);
  return { user: response.json().user, cookie: cookie(response) };
}
async function administrator(app: FastifyInstance): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { password: PASSWORD } });
  assert.equal(response.statusCode, 200, response.body);
  return cookie(response);
}
async function setup() {
  let clock = new Date('2026-11-01T16:00:00.000Z'); // Shanghai Nov 2 midnight.
  const runtime = await createApp({ databasePath: ':memory:', adminPassword: PASSWORD, now: () => clock, holidayFetch: offlineFetch, startHolidayJobs: false });
  return { ...runtime, setClock(value: string) { clock = new Date(value); } };
}
function write(app: FastifyInstance, userId: string, date: string, cookieValue: string, normalShift = 'full', overtime = true, version: number | null = null) {
  return app.inject({ method: 'PUT', url: `/api/schedules/${userId}/${date}`, headers: { cookie: cookieValue }, payload: { normalShift, overtime, version } });
}

test('first deployment requires an explicit valid password and stores a hash', () => {
  assert.throws(() => createDatabase(':memory:'), /ADMIN_PASSWORD/);
  assert.throws(() => createDatabase(':memory:', '12345'), /ADMIN_PASSWORD/);
  const db = createDatabase(':memory:', PASSWORD);
  assert.notEqual(db.prepare("SELECT value FROM settings WHERE key='admin_password_hash'").get()!.value, PASSWORD);
  db.close();
});

test('name creation, case insensitive candidates, suffix reservation, claims and 11th color', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const first = await member(app, ' Alice ');
  const duplicate = await member(app, 'alice');
  assert.equal(first.user.displayName, 'Alice');
  assert.equal(duplicate.user.displayName, 'alice1');
  const candidates = await app.inject({ method: 'POST', url: '/api/identity/candidates', payload: { name: 'ALICE' } });
  assert.deepEqual(candidates.json().users.map((user: User) => user.id), [first.user.id, duplicate.user.id]);
  const claim = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: 'ALICE', userId: duplicate.user.id } });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().user.colorIndex, duplicate.user.colorIndex);
  for (let i = 2; i < 11; i++) await member(app, '王五');
  const rows = db.prepare('SELECT * FROM users ORDER BY registration_sequence').all();
  assert.equal(rows.length, 11);
  assert.equal(rows[10]!.color_index, 0);
  assert.equal(first.user.color, COLORS[0]);
  for (const name of ['', '张 三', '张三1', '张三!', '123', 'abcdefghijk']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/identity', payload: { name } })).statusCode, 400, name);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '王五', userId: duplicate.user.id } })).statusCode, 404);
});

test('member cookies are hashed, HttpOnly, secure in production, restorable and revoked on logout', async t => {
  const { app, db } = await createApp({ databasePath: ':memory:', adminPassword: PASSWORD, secureCookies: true, holidayFetch: offlineFetch, startHolidayJobs: false });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '李四' } });
  const sessionCookie = cookie(response);
  const raw = sessionCookie.split('=')[1]!;
  const attributes = String(response.headers['set-cookie']);
  assert.match(attributes, /HttpOnly/);
  assert.match(attributes, /Secure/);
  assert.match(attributes, /SameSite=Strict/);
  const stored = db.prepare('SELECT token_hash FROM sessions').get()!.token_hash;
  assert.notEqual(stored, raw);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).json().user.id, response.json().user.id);
  await app.inject({ method: 'POST', url: '/api/identity/logout', headers: { cookie: sessionCookie } });
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: sessionCookie } })).json().user, null);
});

test('member authorization rejects forged user IDs, unauthenticated writes and admin log access', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const first = await member(app);
  const other = await member(app, '李四');
  assert.equal((await write(app, other.user.id, '2026-11-02', first.cookie)).statusCode, 403);
  assert.equal((await write(app, first.user.id, '2026-11-02', '')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/admin/logs', headers: { cookie: first.cookie } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users', headers: { cookie: first.cookie }, payload: { name: '王五' } })).statusCode, 403);
  const forged = await app.inject({ method: 'PUT', url: `/api/schedules/${first.user.id}/2026-11-02`, headers: { cookie: first.cookie }, payload: { userId: other.user.id, normalShift: 'full', overtime: false, version: null } });
  assert.equal(forged.statusCode, 200);
  assert.equal(forged.json().schedule.userId, first.user.id);
  const preview = await app.inject({ url: '/api/month?month=2026-11' });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().schedules[0].userId, first.user.id);
  assert.deepEqual(preview.json().users.map((user: User) => user.id), [first.user.id, other.user.id]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/schedules/${first.user.id}/2026-11-02`, payload: { version: forged.json().schedule.version } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/month?month=invalid' })).statusCode, 400);
  const adminCookie = await administrator(app);
  assert.equal((await app.inject({ url: '/api/month?month=2026-11', headers: { cookie: adminCookie } })).statusCode, 200);
});

test('only administrators can update the public home title, with validation and persistence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-title-'));
  const databasePath = join(directory, 'schedule.sqlite');
  const { app } = await createApp({ databasePath, adminPassword: PASSWORD, holidayFetch: offlineFetch, startHolidayJobs: false, startBackupJobs: false });
  try {
    assert.equal((await app.inject('/api/month?month=2026-11')).json().homeTitle, '团队排班');
    const person = await member(app);
    for (const sessionCookie of ['', person.cookie]) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: sessionCookie }, payload: { homeTitle: '越权修改' } })).statusCode, 403);
    }
    const adminCookie = await administrator(app);
    for (const value of [undefined, null, 42, '', '  ', '排'.repeat(41)]) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { homeTitle: value } })).statusCode, 400);
    }
    const updated = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { homeTitle: '  浩楠的排班  ' } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.deepEqual(updated.json(), { homeTitle: '浩楠的排班' });
    assert.equal((await app.inject('/api/month?month=2026-11')).json().homeTitle, '浩楠的排班');
    const unicodeTitle = '🌅'.repeat(40);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { homeTitle: unicodeTitle } })).statusCode, 200);
    await app.close();
    const reopened = createDatabase(databasePath);
    try { assert.equal(reopened.prepare("SELECT value FROM settings WHERE key = 'home_title'").get()!.value, unicodeTitle); }
    finally { reopened.close(); }
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all seven time selections round trip, duplicate dates conflict and cancel deletes', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const person = await member(app);
  const combinations = [['morning', false], ['afternoon', false], ['full', false], ['none', true], ['morning', true], ['afternoon', true], ['full', true]] as const;
  for (let i = 0; i < combinations.length; i++) {
    const [shift, overtime] = combinations[i]!;
    const date = `2026-11-${String(i + 2).padStart(2, '0')}`;
    const saved = await write(app, person.user.id, date, person.cookie, shift, overtime);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().schedule.normalShift, shift);
    assert.equal(saved.json().schedule.overtime, overtime);
    assert.equal((await write(app, person.user.id, date, person.cookie, shift, overtime)).statusCode, 409);
  }
  const original = (await app.inject({ url: '/api/month?month=2026-11', headers: { cookie: person.cookie } })).json().schedules[0];
  const cleared = await write(app, person.user.id, original.date, person.cookie, 'none', false, original.version);
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().schedule, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedules').get()!.count, 6);
  const empty = await write(app, person.user.id, '2026-11-30', person.cookie, 'none', false);
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.json().schedule, null);
  assert.equal((await write(app, person.user.id, '2026-02-30', person.cookie)).statusCode, 400);
});

test('concurrent member/admin updates conflict and deletion/recreation never reuses a stale version', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const person = await member(app);
  const adminCookie = await administrator(app);
  const first = (await write(app, person.user.id, '2026-11-02', person.cookie)).json().schedule;
  const results = await Promise.all([
    write(app, person.user.id, first.date, person.cookie, 'morning', false, first.version),
    write(app, person.user.id, first.date, adminCookie, 'afternoon', false, first.version),
  ]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const updated = results.find(result => result.statusCode === 200)!.json().schedule;
  const removed = await app.inject({ method: 'DELETE', url: `/api/schedules/${person.user.id}/${first.date}`, headers: { cookie: person.cookie }, payload: { version: updated.version } });
  assert.equal(removed.statusCode, 200);
  const recreated = (await write(app, person.user.id, first.date, person.cookie)).json().schedule;
  assert.ok(recreated.version > updated.version);
  assert.equal((await write(app, person.user.id, first.date, adminCookie, 'full', false, updated.version)).statusCode, 409);
});

test('soft deletion hides users, preserves Shanghai today/history, removes future atomically and revokes claims', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const person = await member(app);
  const adminCookie = await administrator(app);
  for (const date of ['2026-11-01', '2026-11-02', '2026-11-03']) await write(app, person.user.id, date, person.cookie);
  const preview = await app.inject({ url: `/api/admin/users/${person.user.id}/deletion-preview`, headers: { cookie: adminCookie } });
  assert.deepEqual(preview.json(), { futureCount: 1, firstDate: '2026-11-03', lastDate: '2026-11-03' });
  const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/users/${person.user.id}`, headers: { cookie: `${person.cookie}; ${adminCookie}` } });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const retained = db.prepare('SELECT * FROM users WHERE id = ?').get(person.user.id)!;
  assert.equal(retained.deleted_at, '2026-11-01T16:00:00.000Z');
  assert.equal(retained.color_index, person.user.colorIndex);
  assert.deepEqual((await app.inject({ url: '/api/admin/users', headers: { cookie: adminCookie } })).json().users, []);
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: person.cookie } })).json().user, null);
  assert.equal((await app.inject({ method: 'POST', url: '/api/identity', payload: { name: '张三', userId: person.user.id } })).statusCode, 404);
  const month = (await app.inject({ url: '/api/month?month=2026-11', headers: { cookie: adminCookie } })).json();
  assert.deepEqual(month.schedules.map((schedule: { date: string }) => schedule.date), ['2026-11-01', '2026-11-02']);
  assert.equal(month.users[0].deletedAt, retained.deleted_at);
  const historical = month.schedules[0];
  assert.equal((await write(app, person.user.id, historical.date, adminCookie, 'morning', false, historical.version)).statusCode, 200);
  assert.equal((await write(app, person.user.id, '2026-10-31', adminCookie)).statusCode, 400);
  assert.equal((await write(app, person.user.id, '2026-11-03', adminCookie)).statusCode, 400);
  const replacement = await member(app);
  assert.equal(replacement.user.displayName, '张三1');
  assert.equal(replacement.user.registrationSequence, 2);
  const logs = (await app.inject({ url: '/api/admin/logs?date=2026-11-02', headers: { cookie: adminCookie } })).json().logs;
  const deletedLog = logs.find((log: { action: string }) => log.action === 'user.delete');
  assert.match(deletedLog.actorName, /当前身份：张三/);
  assert.equal(deletedLog.targetName, '张三');
  assert.equal(deletedLog.after.futureCount, 1);
  assert.equal(deletedLog.after.deletedAt, retained.deleted_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?').get(person.user.id)!.count, 0);
});

test('operation logs commit with business writes, retain exact snapshots and use Shanghai day boundaries with paging', async t => {
  const runtime = await setup();
  const { app, db, setClock } = runtime;
  t.after(() => app.close());
  const person = await member(app);
  const initialCount = db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count;
  db.exec("CREATE TRIGGER reject_log BEFORE INSERT ON operation_logs BEGIN SELECT RAISE(ABORT, 'test log failure'); END;");
  assert.equal((await write(app, person.user.id, '2026-11-02', person.cookie)).statusCode, 500);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schedules').get()!.count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM operation_logs').get()!.count, initialCount);
  db.exec('DROP TRIGGER reject_log;');
  setClock('2026-11-02T15:59:59.000Z');
  const first = (await write(app, person.user.id, '2026-11-02', person.cookie, 'morning', false)).json().schedule;
  setClock('2026-11-02T16:00:00.000Z');
  await write(app, person.user.id, first.date, person.cookie, 'full', true, first.version);
  const adminCookie = await administrator(app);
  const nextDay = (await app.inject({ url: '/api/admin/logs?date=2026-11-03', headers: { cookie: adminCookie } })).json();
  assert.equal(nextDay.total, 1);
  assert.equal(nextDay.logs[0].before.normalShift, 'morning');
  assert.equal(nextDay.logs[0].after.normalShift, 'full');
  assert.equal(nextDay.logs[0].after.overtime, true);
  for (let i = 0; i < 35; i++) await member(app, '王五');
  const page1 = (await app.inject({ url: '/api/admin/logs?date=2026-11-03&page=1', headers: { cookie: adminCookie } })).json();
  const page2 = (await app.inject({ url: '/api/admin/logs?date=2026-11-03&page=2', headers: { cookie: adminCookie } })).json();
  assert.equal(page1.total, 36);
  assert.equal(page1.logs.length, 30);
  assert.equal(page2.logs.length, 6);
  assert.ok(page1.logs[29].id > page2.logs[0].id);
});

test('admin failures are rate limited and browser cross-origin writes are rejected', async t => {
  const { app, setClock } = await setup();
  t.after(() => app.close());
  const options: InjectOptions = { method: 'POST', url: '/api/admin/login', payload: { password: 'wrong-password' } };
  for (let i = 0; i < 5; i++) assert.equal((await app.inject(options)).statusCode, 401);
  assert.equal((await app.inject({ ...options, payload: { password: PASSWORD } })).statusCode, 429);
  setClock('2026-11-01T16:10:01.000Z');
  assert.equal((await app.inject({ ...options, payload: { password: PASSWORD } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/identity', headers: { origin: 'https://other.example', host: 'schedule.example' }, payload: { name: '王五' } })).statusCode, 403);
});
