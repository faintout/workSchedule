import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function backupDatabase(source: string, destination: string) {
  const target = resolve(destination);
  if (resolve(source) === target) throw new Error('备份路径不能与数据库相同');
  if (existsSync(target)) throw new Error('备份文件已存在，请使用新路径');
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try { await backup(db, target); }
  catch (error) { rmSync(target, { force: true }); throw error; }
  finally { db.close(); }
  return target;
}

export function startDailyBackups(source: string, onError: (error: unknown) => void, now = () => new Date()) {
  let running: Promise<void> | undefined;
  const check = () => {
    if (running) return;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now());
    const destination = resolve(dirname(source), 'backups', `schedule-${date}.sqlite`);
    if (existsSync(destination)) return;
    running = backupDatabase(source, destination).then(() => {}, onError).finally(() => { running = undefined; });
  };
  check();
  const timer = setInterval(check, 60 * 60 * 1000);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = process.env.DATABASE_PATH ?? './data/schedule.sqlite';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = process.argv[2] ?? `./data/backups/schedule-${stamp}.sqlite`;
  console.log(await backupDatabase(source, destination));
}
