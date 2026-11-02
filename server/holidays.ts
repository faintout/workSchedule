import type { DatabaseSync } from 'node:sqlite';

export interface HolidayDay {
  date: string;
  type: number;
  name: string;
}

export type HolidayStatus = 'pending' | 'ready';

interface YearState {
  status: HolidayStatus;
  nextRetryAt: string | null;
}

const RETRY_MS = 72 * 60 * 60 * 1000;

export function validateHolidayYear(year: number, payload: unknown): { days: HolidayDay[]; status: HolidayStatus } {
  if (!payload || typeof payload !== 'object') throw new Error('节假日响应格式无效');
  const response = payload as Record<string, unknown>;
  if (response.code !== 0) throw new Error('节假日接口未返回成功状态');
  if (String(response.year) !== String(year)) throw new Error('节假日响应年份与请求不符');
  if (!Array.isArray(response.data)) throw new Error('节假日全年数据缺失');
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const expectedCount = (end - start) / 86_400_000;
  if (response.count !== expectedCount || response.data.length !== expectedCount) throw new Error('节假日全年日期不完整');
  const expectedDates = new Set<string>();
  for (let time = start; time < end; time += 86_400_000) expectedDates.add(new Date(time).toISOString().slice(0, 10));
  const days: HolidayDay[] = response.data.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('节假日日期数据无效');
    const day = value as Record<string, unknown>;
    if (typeof day.date !== 'string' || !expectedDates.delete(day.date)) throw new Error('节假日日期重复、越界或无效');
    if (typeof day.type !== 'number' || !Number.isInteger(day.type) || day.type < 0 || day.type > 4) throw new Error('节假日类型无效');
    if (day.type >= 2 && (typeof day.name !== 'string' || !day.name.trim())) throw new Error('法定安排名称缺失');
    return {
      date: day.date,
      type: day.type,
      name: day.type >= 2 ? (day.name as string).replace(/[（(][休班][）)]$/, '').trim() : '',
    };
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, status: days.some(day => day.type === 2 || day.type === 3) ? 'ready' : 'pending' };
}

export class HolidayService {
  private readonly now: () => Date;
  private readonly fetcher: typeof fetch;
  private readonly tasks = new Map<number, Promise<HolidayStatus>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly db: DatabaseSync, options: { now?: () => Date; fetch?: typeof fetch } = {}) {
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetch ?? fetch;
    db.exec(`
      CREATE TABLE IF NOT EXISTS holiday_years (
        year INTEGER PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
        lastAttemptAt TEXT,
        nextRetryAt TEXT,
        lastSuccessAt TEXT,
        validationError TEXT
      );
      CREATE TABLE IF NOT EXISTS holiday_days (
        date TEXT PRIMARY KEY,
        year INTEGER NOT NULL REFERENCES holiday_years(year),
        type INTEGER NOT NULL CHECK (type BETWEEN 0 AND 4),
        name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS holiday_days_year ON holiday_days(year);
    `);
  }

  getMonth(month: string): { holidays: HolidayDay[]; holidayStatus: HolidayStatus } {
    const year = Number(month.slice(0, 4));
    void this.sync(year);
    return {
      holidays: this.db.prepare('SELECT date, type, name FROM holiday_days WHERE date LIKE ? ORDER BY date').all(`${month}-%`) as unknown as HolidayDay[],
      holidayStatus: this.state(year)?.status ?? 'pending',
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.checkDue();
    this.timer = setInterval(() => { void this.checkDue(); }, 60 * 60 * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled(this.tasks.values());
  }

  sync(year: number, options: { force?: boolean } = {}): Promise<HolidayStatus> {
    if (!Number.isInteger(year) || year < 1900 || year > 9998) return Promise.reject(new Error('节假日年份无效'));
    const existing = this.tasks.get(year);
    if (existing) return existing;
    const state = this.state(year);
    if (this.stopped || (!options.force && (state?.status === 'ready' || (state?.nextRetryAt && Date.parse(state.nextRetryAt) > this.now().getTime())))) {
      return Promise.resolve(state?.status ?? 'pending');
    }
    const task = this.fetchYear(year).finally(() => { this.tasks.delete(year); });
    this.tasks.set(year, task);
    return task;
  }

  private state(year: number): YearState | undefined {
    return this.db.prepare('SELECT status, nextRetryAt FROM holiday_years WHERE year = ?').get(year) as unknown as YearState | undefined;
  }

  private async checkDue(): Promise<void> {
    if (this.stopped) return;
    const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(this.now()));
    const pending = this.db.prepare("SELECT year FROM holiday_years WHERE status = 'pending'").all() as { year: number }[];
    await Promise.allSettled([...new Set([year, year + 1, ...pending.map(row => row.year)])].map(value => this.sync(value)));
  }

  private async fetchYear(year: number): Promise<HolidayStatus> {
    const attemptedAt = this.now().toISOString();
    const nextRetryAt = new Date(this.now().getTime() + RETRY_MS).toISOString();
    this.db.prepare(`INSERT INTO holiday_years(year, status, lastAttemptAt, nextRetryAt)
      VALUES (?, 'pending', ?, ?)
      ON CONFLICT(year) DO UPDATE SET lastAttemptAt = excluded.lastAttemptAt, nextRetryAt = excluded.nextRetryAt`).run(year, attemptedAt, nextRetryAt);
    try {
      const response = await this.fetcher(`https://holiday.ailcc.com/api/holiday/allyear/${year}`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`节假日接口 HTTP ${response.status}`);
      const { days, status } = validateHolidayYear(year, await response.json());
      if (this.state(year)?.status === 'ready' && status === 'pending') throw new Error('返回数据缺少法定安排，保留已有缓存');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM holiday_days WHERE year = ?').run(year);
        const insert = this.db.prepare('INSERT INTO holiday_days(date, year, type, name) VALUES (?, ?, ?, ?)');
        for (const day of days) insert.run(day.date, year, day.type, day.name);
        this.db.prepare('UPDATE holiday_years SET status = ?, nextRetryAt = ?, lastSuccessAt = ?, validationError = NULL WHERE year = ?')
          .run(status, status === 'ready' ? null : nextRetryAt, this.now().toISOString(), year);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.db.prepare('UPDATE holiday_years SET validationError = ? WHERE year = ?').run(error instanceof Error ? error.message : '节假日同步失败', year);
    }
    return this.state(year)?.status ?? 'pending';
  }
}
