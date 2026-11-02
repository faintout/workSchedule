import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';
import { backupDatabase } from '../server/backup.js';

const offlineFetch: typeof fetch = async () => { throw new Error('offline fixture'); };

test('same database preserves identity, schedules, logs and sessions across restart and consistent backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'work-schedule-'));
  const databasePath = join(directory, 'schedule.sqlite');
  const options = { databasePath, adminPassword: 'temporary-test-password', holidayFetch: offlineFetch, startHolidayJobs: false, startBackupJobs: false };
  let instance = await createApp(options);
  try {
    const registration = await instance.app.inject({ method: 'POST', url: '/api/identity', payload: { name: '备份测试' } });
    assert.equal(registration.statusCode, 200, registration.body);
    const user = registration.json().user;
    const cookie = String(registration.headers['set-cookie']).split(';')[0];
    const saved = await instance.app.inject({
      method: 'PUT', url: `/api/schedules/${user.id}/2026-11-02`, headers: { cookie },
      payload: { normalShift: 'full', overtime: true, version: null },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    const snapshot = await backupDatabase(databasePath, join(directory, 'backup.sqlite'));
    const backup = new DatabaseSync(snapshot, { readOnly: true });
    try {
      assert.equal(backup.prepare('SELECT count(*) AS n FROM schedules').get()?.n, 1);
      assert.equal(backup.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.ok(Number(backup.prepare('SELECT count(*) AS n FROM operation_logs').get()?.n) >= 2);
    } finally { backup.close(); }
    await instance.app.close();
    instance = await createApp({ ...options, adminPassword: undefined });
    const session = await instance.app.inject({ url: '/api/session', headers: { cookie } });
    assert.equal(session.json().user.id, user.id);
    const month = await instance.app.inject({ url: '/api/month?month=2026-11', headers: { cookie } });
    assert.equal(month.json().schedules[0].normalShift, 'full');
    assert.equal(month.json().schedules[0].overtime, true);
  } finally {
    await instance.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production app rejects cross-origin writes and unknown API routes stay JSON', async () => {
  const { app } = await createApp({ databasePath: ':memory:', adminPassword: 'temporary-test-password', startHolidayJobs: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/identity', headers: { origin: 'https://other.example', host: 'schedule.example' }, payload: { name: '张三' } });
    assert.equal(response.statusCode, 403);
    assert.equal((await app.inject('/api/health')).json().status, 'ok');
    assert.equal((await app.inject('/api/missing')).statusCode, 404);
  } finally { await app.close(); }
});

