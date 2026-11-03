// Isolated preview fixture; an optional test database preserves edits across restarts.
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { shanghaiDate, type NormalShift } from '../server/types.js';

const { app, db } = await createApp({
  databasePath: process.env.UI_TEST_DATABASE ?? ':memory:', adminPassword: 'browser-test-only',
  startHolidayJobs: false, startBackupJobs: false,
  holidayFetch: async () => { throw new Error('offline browser fixture'); },
});
app.get('/test-mobile', async (_request, reply) => reply.type('text/html').send(`
  <!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>320px 排班验收</title>
  <style>body{margin:0;background:#e9edf2}iframe{display:block;width:320px;height:568px;border:0}</style>
  <iframe src="/" title="320px 排班系统"></iframe></html>
`));
const month = shanghaiDate().slice(0, 7);
const names = ['王小明', '李晓', '陈思', '赵雨', 'P测试成员甲乙丙丁戊', 'P测试成员甲乙丙丁戊', ...Array.from({ length: 24 }, (_, index) => `测试成员${String.fromCharCode(65 + index)}`)];
const shifts: [NormalShift, boolean][] = [['none', true], ['morning', false], ['afternoon', false], ['full', false], ['morning', true], ['afternoon', true], ['full', true]];
if (Number(db.prepare('SELECT COUNT(*) AS count FROM users').get()!.count) === 0) {
  for (let index = 0; index < names.length; index++) {
    const registration = await app.inject({ method: 'POST', url: '/api/identity', payload: { name: names[index] } });
    assert.equal(registration.statusCode, 200, registration.body);
    const user = registration.json().user;
    const cookie = String(registration.headers['set-cookie']).split(';')[0];
    for (const day of ['02', '26', ...(index < 7 ? ['03'] : []), ...(index < 8 ? ['04'] : []), ...(index === 0 ? ['06', '08'] : []), ...(index < 6 ? ['07'] : [])]) {
      const [normalShift, overtime] = day === '08' || day === '07' && index >= 3 ? ['rest', false] : day === '06' ? ['full', false] : index === 4 || index === 5 ? ['none', true] : shifts[index % shifts.length]!;
      const saved = await app.inject({ method: 'PUT', url: `/api/schedules/${user.id}/${month}-${day}`, headers: { cookie }, payload: { normalShift, overtime, version: null } });
      assert.equal(saved.statusCode, 200, saved.body);
    }
  }
}
const port = Number(process.env.UI_TEST_PORT ?? 3040);
const host = process.env.UI_TEST_HOST ?? '0.0.0.0';
await app.listen({ host, port });
console.log(`UI preview listening on ${host}:${port}; month ${month}; member 王小明; admin browser-test-only`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
