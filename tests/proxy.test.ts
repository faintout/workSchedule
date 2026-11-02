import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import viteConfig from '../vite.config.js';
import { createApp } from '../server/app.js';

test('development proxy preserves the browser origin for rest saves and rejects cross-origin writes', async t => {
  const { app } = await createApp({ databasePath: ':memory:', adminPassword: 'proxy-test-password', startHolidayJobs: false, startBackupJobs: false });
  t.after(() => app.close());
  const backend = await app.listen({ host: '127.0.0.1', port: 0 });
  const proxy = viteConfig.server?.proxy?.['/api'];
  assert.ok(proxy);
  const vite = await createServer({
    ...viteConfig, configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...viteConfig.server, host: '127.0.0.1', port: 0, hmr: false, open: false,
      proxy: { '/api': typeof proxy === 'string' ? backend : { ...proxy, target: backend } } },
  });
  t.after(() => vite.close());
  await vite.listen();
  const address = vite.httpServer!.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const registration = await fetch(origin + '/api/identity', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '代理测试' }),
  });
  assert.equal(registration.status, 200, await registration.clone().text());
  const { user } = await registration.json();
  const cookie = registration.headers.get('set-cookie')!.split(';')[0]!;
  const url = origin + `/api/schedules/${user.id}/2026-11-20`;
  const saved = await fetch(url, {
    method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ normalShift: 'rest', overtime: false, version: null }),
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const { schedule } = await saved.json();
  assert.equal(schedule.normalShift, 'rest');
  const rejected = await fetch(url, {
    method: 'PUT', headers: { Origin: 'http://other.example', Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ normalShift: 'full', overtime: true, version: schedule.version }),
  });
  assert.equal(rejected.status, 403);
  const month = await (await fetch(origin + '/api/month?month=2026-11')).json();
  assert.deepEqual(month.schedules, [schedule]);
});
