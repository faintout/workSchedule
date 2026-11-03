import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { ADMIN_COOKIE, MEMBER_COOKIE, getIdentity, issueSession, passwordMatches, requireAdmin, revokeSession } from './auth.js';
import { getSchedule, getUser, insertUser, logOperation, nextNumber, scheduleFromRow, transaction, userFromRow } from './db.js';
import { isDate, normalizeName, shanghaiDate, type NormalShift } from './types.js';

export interface CoreOptions {
  db: DatabaseSync;
  secureCookies?: boolean;
  now?: () => Date;
  getHolidays?: (month: string) => unknown | Promise<unknown>;
}

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) fail(400, '请提交有效数据');
  return request.body as Record<string, unknown>;
}

export async function registerCoreRoutes(app: FastifyInstance, options: CoreOptions) {
  const { db, secureCookies = false } = options;
  const now = options.now ?? (() => new Date());
  const identity = (request: FastifyRequest) => getIdentity(db, request, now());
  const authenticate = (request: FastifyRequest) => {
    const current = identity(request);
    if (!current.user && !current.admin) fail(401, '请先确认姓名或登录管理员');
    return current;
  };
  const admin = (request: FastifyRequest) => requireAdmin(db, request, now());
  const actor = (request: FastifyRequest) => {
    const current = identity(request);
    return current.admin
      ? { role: 'admin', name: current.user ? `管理员（当前身份：${current.user.displayName}）` : '管理员' }
      : { role: 'member', name: current.user!.displayName };
  };
  const renameUser = (request: FastifyRequest, id: string) => {
    const { name, key } = normalizeName(body(request).name);
    const operator = actor(request);
    const user = transaction(db, () => {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row || row.deleted_at != null) fail(404, '用户不存在');
      const previous = userFromRow(row);
      if (previous.originalName === name) return previous;
      let suffix = row.normalized_name === key ? Number(row.suffix) : 0;
      while (db.prepare('SELECT 1 FROM users WHERE normalized_display_name = ? AND id != ?').get(key + (suffix || ''), id)) suffix++;
      db.prepare(`UPDATE users SET original_name = ?, normalized_name = ?, display_name = ?, normalized_display_name = ?, suffix = ? WHERE id = ?`)
        .run(name, key, name + (suffix || ''), key + (suffix || ''), suffix, id);
      const updated = getUser(db, id)!;
      logOperation(db, operator, 'user.rename', updated, null, previous, updated, now());
      return updated;
    });
    return { user };
  };

  app.get('/api/session', async request => identity(request));
  app.put('/api/identity', async request => {
    const current = identity(request);
    if (!current.user) fail(401, '请先确认姓名');
    return renameUser(request, current.user.id);
  });
  app.post('/api/identity/candidates', async request => {
    const { key } = normalizeName(body(request).name);
    return { users: db.prepare('SELECT * FROM users WHERE normalized_name = ? AND deleted_at IS NULL ORDER BY registration_sequence').all(key).map(userFromRow) };
  });
  app.post('/api/identity', async (request, reply) => {
    const input = body(request);
    const { name, key } = normalizeName(input.name);
    const user = transaction(db, () => {
      if (input.userId !== undefined) {
        if (typeof input.userId !== 'string') fail(400, '请选择要认领的用户');
        const row = db.prepare('SELECT * FROM users WHERE id = ? AND normalized_name = ? AND deleted_at IS NULL').get(input.userId, key);
        if (!row) fail(404, '该身份不可认领，请重新选择');
        return userFromRow(row);
      }
      const created = insertUser(db, name, key);
      const current = identity(request);
      logOperation(db, current.admin ? actor(request) : { role: 'member', name: created.displayName }, 'user.create', created, null, null, created, now());
      return created;
    });
    issueSession(db, request, reply, 'member', user.id, secureCookies, now());
    return { user };
  });
  app.post('/api/identity/logout', async (request, reply) => {
    revokeSession(db, request, 'member');
    reply.clearCookie(MEMBER_COOKIE, { path: '/', secure: secureCookies, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });

  const loginFailures = new Map<string, { count: number; until: number }>();
  app.post('/api/admin/login', async (request, reply) => {
    const timestamp = now().getTime();
    for (const [ip, failures] of loginFailures) if (failures.until <= timestamp) loginFailures.delete(ip);
    const failures = loginFailures.get(request.ip);
    if (failures && failures.count >= 5) fail(429, '登录尝试过多，请 10 分钟后重试');
    const password = body(request).password;
    if (typeof password !== 'string' || password.length < 6 || password.length > 256) fail(400, '密码长度需为 6–256 个字符');
    const stored = String(db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get()!.value);
    if (!passwordMatches(password, stored)) {
      loginFailures.set(request.ip, { count: (failures?.count ?? 0) + 1, until: failures?.until ?? timestamp + 10 * 60 * 1000 });
      fail(401, '管理员密码不正确');
    }
    loginFailures.delete(request.ip);
    issueSession(db, request, reply, 'admin', null, secureCookies, now());
    return { admin: true };
  });
  app.post('/api/admin/logout', async (request, reply) => {
    revokeSession(db, request, 'admin');
    reply.clearCookie(ADMIN_COOKIE, { path: '/', secure: secureCookies, httpOnly: true, sameSite: 'strict' });
    return { ok: true };
  });

  const publicSettings = () => ({
    homeTitle: String(db.prepare("SELECT value FROM settings WHERE key = 'home_title'").get()?.value ?? '团队排班'),
    defaultDisplayMode: String(db.prepare("SELECT value FROM settings WHERE key = 'default_display_mode'").get()?.value ?? 'normal'),
    syncIntervalMinutes: Number(db.prepare("SELECT value FROM settings WHERE key = 'sync_interval_minutes'").get()?.value ?? 0.5),
  });
  app.get<{ Querystring: { month?: string } }>('/api/month', async request => {
    const month = request.query.month;
    if (typeof month !== 'string' || !isDate(`${month}-01`)) fail(400, '请选择有效月份');
    const schedules = db.prepare('SELECT * FROM schedules WHERE date >= ? AND date <= ? ORDER BY date,user_id')
      .all(`${month}-01`, `${month}-31`).map(scheduleFromRow);
    const users = db.prepare(`SELECT * FROM users WHERE deleted_at IS NULL OR id IN
      (SELECT user_id FROM schedules WHERE date >= ? AND date <= ?) ORDER BY registration_sequence`)
      .all(`${month}-01`, `${month}-31`).map(userFromRow);
    const holidays = options.getHolidays ? await options.getHolidays(month) : {};
    return { users, schedules, ...publicSettings(), ...(holidays as object) };
  });
  app.put('/api/admin/settings', async request => {
    admin(request);
    const input = body(request);
    const value = input.homeTitle;
    const defaultDisplayMode = input.defaultDisplayMode;
    const syncIntervalMinutes = input.syncIntervalMinutes;
    if (typeof value !== 'string') fail(400, '首页标题需为 1–40 个字符');
    const homeTitle = value.trim();
    if (!homeTitle || Array.from(homeTitle).length > 40) fail(400, '首页标题需为 1–40 个字符');
    if (defaultDisplayMode !== undefined && (typeof defaultDisplayMode !== 'string' || !['normal', 'horizontal', 'vertical', 'grouped'].includes(defaultDisplayMode))) {
      fail(400, '请选择有效的默认展示方式');
    }
    if (syncIntervalMinutes !== undefined && (typeof syncIntervalMinutes !== 'number' || !Number.isFinite(syncIntervalMinutes)
      || syncIntervalMinutes * 60_000 < 1 || syncIntervalMinutes * 60_000 > 2_147_483_647)) {
      fail(400, '同步间隔需为正数分钟，数值不能过小或过大');
    }
    return transaction(db, () => {
      const previous = publicSettings();
      const settings = { homeTitle, defaultDisplayMode: defaultDisplayMode ?? previous.defaultDisplayMode, syncIntervalMinutes: syncIntervalMinutes ?? previous.syncIntervalMinutes };
      const save = db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      save.run('home_title', settings.homeTitle);
      save.run('default_display_mode', settings.defaultDisplayMode);
      save.run('sync_interval_minutes', String(settings.syncIntervalMinutes));
      return settings;
    });
  });

  const writeSchedule = (request: FastifyRequest<{ Params: { userId: string; date: string } }>, remove: boolean) => {
    const current = authenticate(request);
    const { userId, date } = request.params;
    if (!isDate(date)) fail(400, '请选择有效日期');
    if (!current.admin && current.user!.id !== userId) fail(403, '只能修改自己的排班');
    const input = body(request);
    if (input.version !== null && !(typeof input.version === 'number' && Number.isSafeInteger(input.version) && input.version > 0)) {
      fail(400, '缺少排班版本，请重新加载');
    }
    const normalShift = remove ? 'none' : input.normalShift;
    const overtime = remove ? false : input.overtime;
    if (!['none', 'morning', 'afternoon', 'full', 'rest'].includes(normalShift as string) || typeof overtime !== 'boolean') fail(400, '请选择有效排班');
    if (normalShift === 'rest' && overtime) fail(400, '休班不能同时选择加班');
    return transaction(db, () => {
      const target = getUser(db, userId);
      if (!target) fail(404, '用户不存在');
      const previous = getSchedule(db, userId, date);
      if ((previous?.version ?? null) !== input.version) fail(409, '排班已被其他人修改，请重新加载后再保存');
      const clearing = normalShift === 'none' && !overtime;
      if (target.deletedAt && !previous && !clearing) fail(400, '已删除用户不能新增排班');
      if (target.deletedAt && date > shanghaiDate(now())) fail(400, '已删除用户不能新增未来排班');
      if (clearing) {
        if (previous) {
          db.prepare('DELETE FROM schedules WHERE user_id = ? AND date = ?').run(userId, date);
          logOperation(db, actor(request), 'schedule.delete', target, date, previous, null, now());
        }
        return { schedule: null };
      }
      if (previous && previous.normalShift === normalShift && previous.overtime === overtime) return { schedule: previous };
      const version = nextNumber(db, 'next_schedule_version');
      const timestamp = now().toISOString();
      db.prepare(`INSERT INTO schedules(user_id,date,normal_shift,overtime,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(user_id,date) DO UPDATE SET normal_shift=excluded.normal_shift,overtime=excluded.overtime,version=excluded.version,updated_at=excluded.updated_at`)
        .run(userId, date, normalShift as NormalShift, overtime ? 1 : 0, version, timestamp, timestamp);
      const schedule = getSchedule(db, userId, date)!;
      logOperation(db, actor(request), previous ? 'schedule.update' : 'schedule.create', target, date, previous, schedule, now());
      return { schedule };
    });
  };
  app.put<{ Params: { userId: string; date: string } }>('/api/schedules/:userId/:date', async request => writeSchedule(request, false));
  app.delete<{ Params: { userId: string; date: string } }>('/api/schedules/:userId/:date', async request => writeSchedule(request, true));

  app.get('/api/admin/users', async request => {
    admin(request);
    return { users: db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY registration_sequence').all().map(userFromRow) };
  });
  app.post('/api/admin/users', async request => {
    admin(request);
    const { name, key } = normalizeName(body(request).name);
    const user = transaction(db, () => {
      const created = insertUser(db, name, key);
      logOperation(db, actor(request), 'user.create', created, null, null, created, now());
      return created;
    });
    return { user };
  });
  app.put<{ Params: { id: string } }>('/api/admin/users/:id', async request => {
    admin(request);
    return renameUser(request, request.params.id);
  });
  const deletionPreview = (id: string) => {
    const target = getUser(db, id);
    if (!target || target.deletedAt) fail(404, '用户不存在');
    const result = db.prepare('SELECT COUNT(*) AS count,MIN(date) AS first_date,MAX(date) AS last_date FROM schedules WHERE user_id = ? AND date > ?').get(id, shanghaiDate(now()))!;
    return { futureCount: Number(result.count), firstDate: result.first_date ?? null, lastDate: result.last_date ?? null };
  };
  app.get<{ Params: { id: string } }>('/api/admin/users/:id/deletion-preview', async request => {
    admin(request);
    return deletionPreview(request.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async request => {
    admin(request);
    const operator = actor(request);
    return transaction(db, () => {
      const target = getUser(db, request.params.id);
      if (!target) fail(404, '用户不存在');
      if (target.deletedAt) fail(400, '用户已经删除');
      const preview = deletionPreview(target.id);
      const timestamp = now();
      db.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').run(timestamp.toISOString(), target.id);
      const releasedColors: number[] = JSON.parse(String(db.prepare("SELECT value FROM settings WHERE key = 'released_color_indexes'").get()!.value));
      releasedColors.push(target.colorIndex);
      db.prepare("UPDATE settings SET value = ? WHERE key = 'released_color_indexes'").run(JSON.stringify(releasedColors));
      db.prepare('DELETE FROM schedules WHERE user_id = ? AND date > ?').run(target.id, shanghaiDate(timestamp));
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      logOperation(db, operator, 'user.delete', target, null, target, { ...getUser(db, target.id), ...preview }, timestamp);
      return preview;
    });
  });
  app.get<{ Querystring: { date?: string; page?: string } }>('/api/admin/logs', async request => {
    admin(request);
    const date = request.query.date ?? shanghaiDate(now());
    if (!isDate(date)) fail(400, '请选择有效日期');
    const page = request.query.page === undefined ? 1 : Number(request.query.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail(400, '请选择有效页码');
    const pageSize = 30;
    const start = new Date(`${date}T00:00:00+08:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const total = Number(db.prepare('SELECT COUNT(*) AS count FROM operation_logs WHERE occurred_at >= ? AND occurred_at < ?')
      .get(start.toISOString(), end.toISOString())!.count);
    const logs = db.prepare('SELECT * FROM operation_logs WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC,id DESC LIMIT ? OFFSET ?')
      .all(start.toISOString(), end.toISOString(), pageSize, (page - 1) * pageSize).map(row => ({
        id: Number(row.id), actorRole: String(row.actor_role), actorName: String(row.actor_name), action: String(row.action),
        targetUserId: row.target_user_id, targetName: String(row.target_name), date: row.date,
        before: row.before_value == null ? null : JSON.parse(String(row.before_value)),
        after: row.after_value == null ? null : JSON.parse(String(row.after_value)), occurredAt: String(row.occurred_at),
      }));
    return { logs, total, page, pageSize };
  });
}
