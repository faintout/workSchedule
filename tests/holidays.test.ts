import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HolidayService, validateHolidayYear } from '../server/holidays.js';

function yearData(year: number, ready = false) {
  const data = [];
  for (let time = Date.UTC(year, 0, 1); time < Date.UTC(year + 1, 0, 1); time += 86_400_000) {
    const date = new Date(time);
    data.push({ date: date.toISOString().slice(0, 10), type: [0, 6].includes(date.getUTCDay()) ? 1 : 0, name: '普通日期' });
  }
  if (ready) { data[0] = { date: `${year}-01-01`, type: 2, name: '元旦节（休）' }; }
  return { code: 0, year: String(year), count: data.length, data };
}

function fetchData(payload: unknown, onCall = () => {}) {
  return (async () => { onCall(); return Response.json(payload); }) as typeof fetch;
}

test('validates complete leap years, pending future calendars and actual holiday arrangements', () => {
  const leap = validateHolidayYear(2028, yearData(2028, true));
  assert.equal(leap.days.length, 366);
  assert.equal(leap.status, 'ready');
  assert.equal(leap.days[0]?.name, '元旦节');
  assert.equal(validateHolidayYear(2027, yearData(2027)).status, 'pending');
  assert.throws(() => validateHolidayYear(2027, yearData(2026)), /年份/);
  assert.throws(() => validateHolidayYear(2028, { ...yearData(2028), count: 365 }), /不完整/);
  assert.throws(() => validateHolidayYear(2026, { ...yearData(2026), code: -1 }), /成功/);
  const duplicate = yearData(2026);
  duplicate.data[1] = { ...duplicate.data[0]! };
  assert.throws(() => validateHolidayYear(2026, duplicate), /重复/);
  const wrongType = yearData(2026);
  wrongType.data[0]!.type = 5;
  assert.throws(() => validateHolidayYear(2026, wrongType), /类型/);
});

test('pending retries persist across service restart and respect 72 hours', async () => {
  const db = new DatabaseSync(':memory:');
  let time = new Date('2026-11-02T00:00:00Z');
  let calls = 0;
  const options = { now: () => time, fetch: fetchData(yearData(2027), () => { calls++; }) };
  const first = new HolidayService(db, options);
  assert.equal(await first.sync(2027), 'pending');
  await first.stop();
  const restarted = new HolidayService(db, options);
  assert.equal(await restarted.sync(2027), 'pending');
  assert.equal(calls, 1);
  time = new Date(time.getTime() + 72 * 60 * 60 * 1000 - 1);
  await restarted.sync(2027);
  assert.equal(calls, 1);
  time = new Date(time.getTime() + 1);
  await restarted.sync(2027);
  assert.equal(calls, 2);
  assert.equal(restarted.getMonth('2027-01').holidays.length, 31);
  await restarted.stop();
  db.close();
});

test('ready calendars stop automatic fetching and invalid refresh preserves cache', async () => {
  const db = new DatabaseSync(':memory:');
  let payload: unknown = yearData(2026, true);
  let calls = 0;
  const service = new HolidayService(db, { fetch: (async () => { calls++; return Response.json(payload); }) as typeof fetch });
  assert.equal(await service.sync(2026), 'ready');
  await service.sync(2026);
  assert.equal(calls, 1);
  payload = yearData(2027);
  assert.equal(await service.sync(2026, { force: true }), 'ready');
  assert.equal(service.getMonth('2026-01').holidays[0]?.type, 2);
  payload = yearData(2026);
  assert.equal(await service.sync(2026, { force: true }), 'ready');
  assert.equal(service.getMonth('2026-01').holidays[0]?.name, '元旦节');
  assert.match(String(db.prepare('SELECT validationError FROM holiday_years WHERE year = 2026').get()?.validationError), /已有缓存/);
  await service.stop();
  db.close();
});

test('failed requests keep cached days and postpone retries across restart', async () => {
  const db = new DatabaseSync(':memory:');
  const good = new HolidayService(db, { fetch: fetchData(yearData(2027)) });
  await good.sync(2027);
  await good.stop();
  let calls = 0;
  const failed = new HolidayService(db, { fetch: (async () => { calls++; throw new Error('network offline'); }) as typeof fetch });
  assert.equal(await failed.sync(2027, { force: true }), 'pending');
  assert.equal(failed.getMonth('2027-01').holidays.length, 31);
  await failed.stop();
  const restarted = new HolidayService(db, { fetch: (async () => { calls++; throw new Error('network offline'); }) as typeof fetch });
  await restarted.sync(2027);
  assert.equal(calls, 1);
  await restarted.stop();
  db.close();
});

test('only one task fetches a year and shutdown waits for the task', async () => {
  const db = new DatabaseSync(':memory:');
  let release!: (response: Response) => void;
  let calls = 0;
  const service = new HolidayService(db, { fetch: (() => { calls++; return new Promise<Response>(resolve => { release = resolve; }); }) as typeof fetch });
  const a = service.sync(2026);
  const b = service.sync(2026, { force: true });
  assert.equal(a, b);
  assert.equal(calls, 1);
  let stopped = false;
  const shutdown = service.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release(Response.json(yearData(2026, true)));
  await shutdown;
  assert.equal(await a, 'ready');
  assert.equal(stopped, true);
  db.close();
});

test('startup uses Shanghai current year and retries due years previously browsed', async () => {
  const db = new DatabaseSync(':memory:');
  const requested: number[] = [];
  const service = new HolidayService(db, {
    now: () => new Date('2026-12-31T16:30:00Z'),
    fetch: (async input => {
      const year = Number(String(input).split('/').at(-1));
      requested.push(year);
      return Response.json(yearData(year, true));
    }) as typeof fetch,
  });
  await service.sync(2026);
  requested.length = 0;
  db.prepare("INSERT INTO holiday_years(year,status,nextRetryAt) VALUES(2030,'pending','2026-12-01T00:00:00Z')").run();
  service.start();
  await service.stop();
  assert.deepEqual(requested.sort(), [2027, 2028, 2030]);
  assert.equal(db.prepare('SELECT status FROM holiday_years WHERE year=2030').get()?.status, 'ready');
  db.close();
});
