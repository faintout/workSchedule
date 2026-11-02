import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getUser } from './db.js';

export const MEMBER_COOKIE = 'ws_session';
export const ADMIN_COOKIE = 'ws_admin';
const MEMBER_AGE = 365 * 24 * 60 * 60;
const ADMIN_AGE = 12 * 60 * 60;

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function passwordMatches(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function revokeSession(db: DatabaseSync, request: FastifyRequest, role: 'member' | 'admin') {
  const token = request.cookies[role === 'member' ? MEMBER_COOKIE : ADMIN_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ? AND role = ?').run(tokenHash(token), role);
}

export function issueSession(db: DatabaseSync, request: FastifyRequest, reply: FastifyReply, role: 'member' | 'admin', userId: string | null, secure: boolean, now: Date) {
  revokeSession(db, request, role);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  const token = randomBytes(32).toString('base64url');
  const age = role === 'member' ? MEMBER_AGE : ADMIN_AGE;
  db.prepare('INSERT INTO sessions(token_hash, role, user_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), role, userId, new Date(now.getTime() + age * 1000).toISOString());
  reply.setCookie(role === 'member' ? MEMBER_COOKIE : ADMIN_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: age,
  });
}

export function getIdentity(db: DatabaseSync, request: FastifyRequest, now = new Date()) {
  const find = (role: 'member' | 'admin') => {
    const token = request.cookies[role === 'member' ? MEMBER_COOKIE : ADMIN_COOKIE];
    if (!token || token.length > 128) return undefined;
    return db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND role = ? AND expires_at > ?')
      .get(tokenHash(token), role, now.toISOString());
  };
  const session = find('member');
  const candidate = session ? getUser(db, String(session.user_id)) : null;
  return { user: candidate && !candidate.disabledAt ? candidate : null, admin: Boolean(find('admin')) };
}

export function requireAdmin(db: DatabaseSync, request: FastifyRequest, now = new Date()) {
  const identity = getIdentity(db, request, now);
  if (!identity.admin) throw Object.assign(new Error('请先登录管理员'), { statusCode: 403 });
  return identity;
}
