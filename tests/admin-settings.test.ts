import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';

const PASSWORD = 'test-admin-123';
const DEFAULTS = { homeTitle: '团队排班', defaultDisplayMode: 'normal', syncIntervalMinutes: 0.5 };
const offlineFetch: typeof fetch = async () => { throw new Error('offline fixture'); };
const setup = (databasePath = ':memory:') => createApp({ databasePath, adminPassword: PASSWORD, holidayFetch: offlineFetch, startHolidayJobs: false, startBackupJobs: false });
async function login(app: FastifyInstance, admin = true) {
  const response = await app.inject({ method: 'POST', url: admin ? '/api/admin/login' : '/api/identity', payload: admin ? { password: PASSWORD } : { name: '张三' } });
  assert.equal(response.statusCode, 200, response.body);
  return String(response.headers['set-cookie']).split(';')[0];
}
async function publicSettings(app: FastifyInstance, cookie = '') {
  const response = await app.inject({ url: '/api/month?month=2026-11', headers: { cookie } });
  assert.equal(response.statusCode, 200, response.body);
  const { homeTitle, defaultDisplayMode, syncIntervalMinutes } = response.json();
  return { homeTitle, defaultDisplayMode, syncIntervalMinutes };
}
function save(app: FastifyInstance, cookie: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie }, payload });
}

test('public settings default to normal display and a 30-second sync for every identity', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  for (const cookie of ['', await login(app, false), await login(app)]) {
    const settings = await publicSettings(app, cookie);
    assert.deepEqual(settings, DEFAULTS);
    assert.equal(settings.syncIntervalMinutes * 60_000, 30_000);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key IN ('home_title','default_display_mode','sync_interval_minutes')").get()!.count, 0);
});

test('guests and members cannot change defaults or the sync interval', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  for (const cookie of ['', await login(app, false)]) {
    assert.equal((await save(app, cookie, { homeTitle: '越权修改', defaultDisplayMode: 'vertical', syncIntervalMinutes: 2 })).statusCode, 403);
    assert.deepEqual(await publicSettings(app), DEFAULTS);
  }
});

test('administrators can select all display modes and decimal minute intervals', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const cookie = await login(app);
  for (const [defaultDisplayMode, syncIntervalMinutes] of [['horizontal', 0.5], ['vertical', 1.25], ['grouped', 0.75], ['normal', 2]] as const) {
    const expected = { homeTitle: '团队日历', defaultDisplayMode, syncIntervalMinutes };
    const response = await save(app, cookie, { ...expected, homeTitle: '  团队日历  ' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
    assert.deepEqual(await publicSettings(app), expected);
  }
});

test('invalid settings reject the entire change before writing any fields', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const cookie = await login(app);
  const previous = { homeTitle: '已保存标题', defaultDisplayMode: 'vertical', syncIntervalMinutes: 1.25 };
  assert.equal((await save(app, cookie, previous)).statusCode, 200);
  const invalidInputs = [
    ...[null, false, 0, '', 'detail', ' vertical ', {}, []].map(defaultDisplayMode => ({ homeTitle: '新标题', defaultDisplayMode, syncIntervalMinutes: 2 })),
    ...[null, false, '0.5', 0, -1, 0.000001, 40_000, {}, []].map(syncIntervalMinutes => ({ homeTitle: '新标题', defaultDisplayMode: 'normal', syncIntervalMinutes })),
    { homeTitle: '', defaultDisplayMode: 'normal', syncIntervalMinutes: 2 },
    { defaultDisplayMode: 'normal', syncIntervalMinutes: 2 },
  ];
  for (const payload of invalidInputs) {
    const response = await save(app, cookie, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(await publicSettings(app), previous);
  }
  const overflow = await app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie, 'content-type': 'application/json' }, payload: '{"homeTitle":"新标题","syncIntervalMinutes":1e309}' });
  assert.equal(overflow.statusCode, 400, overflow.body);
  assert.deepEqual(await publicSettings(app), previous);
});

test('omitted new settings preserve existing values during title or single-field updates', async t => {
  const { app } = await setup();
  t.after(() => app.close());
  const cookie = await login(app);
  assert.equal((await save(app, cookie, { homeTitle: '原标题', defaultDisplayMode: 'vertical', syncIntervalMinutes: 1.25 })).statusCode, 200);
  for (const [payload, expected] of [
    [{ homeTitle: '新标题' }, { homeTitle: '新标题', defaultDisplayMode: 'vertical', syncIntervalMinutes: 1.25 }],
    [{ homeTitle: '新标题', defaultDisplayMode: 'horizontal' }, { homeTitle: '新标题', defaultDisplayMode: 'horizontal', syncIntervalMinutes: 1.25 }],
    [{ homeTitle: '新标题', syncIntervalMinutes: 0.5 }, { homeTitle: '新标题', defaultDisplayMode: 'horizontal', syncIntervalMinutes: 0.5 }],
  ]) {
    const response = await save(app, cookie, payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), expected);
    assert.deepEqual(await publicSettings(app), expected);
  }
});

test('display defaults and decimal sync intervals remain public after restarting', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-settings-'));
  const databasePath = join(directory, 'schedule.sqlite');
  const first = await setup(databasePath);
  try {
    const expected = { homeTitle: '持久化标题', defaultDisplayMode: 'grouped', syncIntervalMinutes: 1.25 };
    assert.equal((await save(first.app, await login(first.app), expected)).statusCode, 200);
    await first.app.close();
    const reopened = await setup(databasePath);
    try {
      assert.deepEqual(await publicSettings(reopened.app), expected);
      assert.equal(reopened.db.prepare("SELECT value FROM settings WHERE key='default_display_mode'").get()!.value, 'grouped');
      assert.equal(reopened.db.prepare("SELECT value FROM settings WHERE key='sync_interval_minutes'").get()!.value, '1.25');
    } finally { await reopened.app.close(); }
  } finally {
    await first.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a database failure rolls back the title, display default and sync interval together', async t => {
  const { app, db } = await setup();
  t.after(() => app.close());
  const cookie = await login(app);
  const previous = { homeTitle: '原标题', defaultDisplayMode: 'vertical', syncIntervalMinutes: 1.25 };
  assert.equal((await save(app, cookie, previous)).statusCode, 200);
  db.exec("CREATE TRIGGER reject_interval BEFORE INSERT ON settings WHEN NEW.key='sync_interval_minutes' BEGIN SELECT RAISE(ABORT, 'test settings failure'); END;");
  const response = await save(app, cookie, { homeTitle: '新标题', defaultDisplayMode: 'normal', syncIntervalMinutes: 0.5 });
  assert.equal(response.statusCode, 500, response.body);
  assert.deepEqual(await publicSettings(app), previous);
});
