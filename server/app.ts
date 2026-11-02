import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from './db.js';
import { requireAdmin } from './auth.js';
import { registerCoreRoutes } from './routes.js';
import { HolidayService } from './holidays.js';
import { startDailyBackups } from './backup.js';

export interface AppOptions {
  databasePath: string;
  adminPassword?: string;
  secureCookies?: boolean;
  now?: () => Date;
  holidayFetch?: typeof fetch;
  startHolidayJobs?: boolean;
  startBackupJobs?: boolean;
  webRoot?: string;
  logger?: boolean;
}

export async function createApp(options: AppOptions) {
  const db = createDatabase(options.databasePath, options.adminPassword);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16 * 1024 });
  const holidays = new HolidayService(db, { now: options.now, fetch: options.holidayFetch });
  await app.register(cookie);

  app.setErrorHandler((error, request, reply) => {
    const exception = error as Error & { statusCode?: number };
    const status = exception.statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    reply.code(status).send({ error: status >= 500 ? '服务暂时不可用，请稍后重试' : exception.message });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    // Reject browser writes from another origin; SameSite cookies also protect sessions.
    const origin = request.headers.origin;
    if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* rejected below */ }
      if (originHost !== request.headers.host) {
        return reply.code(403).send({ error: '请从排班系统页面提交操作' });
      }
    }
  });
  await registerCoreRoutes(app, {
    db,
    secureCookies: options.secureCookies ?? false,
    now: options.now,
    getHolidays: month => holidays.getMonth(month),
  });
  app.get('/api/health', async () => {
    db.prepare('SELECT 1').get();
    return { status: 'ok' };
  });
  app.post<{ Params: { year: string } }>('/api/admin/holidays/:year/refresh', async (request, reply) => {
    requireAdmin(db, request, options.now?.());
    const year = Number(request.params.year);
    if (!/^\d{4}$/.test(request.params.year) || year < 1900 || year > 2100) {
      throw Object.assign(new Error('请选择 1900–2100 年'), { statusCode: 400 });
    }
    const status = await holidays.sync(year, { force: true });
    const state = db.prepare('SELECT validationError FROM holiday_years WHERE year = ?').get(year);
    if (state?.validationError) return reply.code(502).send({ error: '节假日刷新失败，已保留已有数据，请稍后重试' });
    return { status };
  });

  const webRoot = resolve(options.webRoot ?? 'dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: '页面或接口不存在' });
    });
  }
  const stopBackups = options.startBackupJobs !== false && options.databasePath !== ':memory:'
    ? startDailyBackups(options.databasePath, error => app.log.error(error), options.now)
    : async () => {};
  app.addHook('onClose', async () => {
    await holidays.stop();
    await stopBackups();
    db.close();
  });
  if (options.startHolidayJobs !== false) holidays.start();
  return { app, db, holidays };
}
