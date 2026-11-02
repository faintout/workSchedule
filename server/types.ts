export const COLORS = ['#5660F5', '#258856', '#227AAB', '#8853BF', '#B84778', '#17847B', '#5264AB', '#778A31', '#AF7237', '#536176'];

export type NormalShift = 'none' | 'morning' | 'afternoon' | 'full';
export interface User {
  id: string;
  originalName: string;
  displayName: string;
  registrationSequence: number;
  colorIndex: number;
  color: string;
  disabledAt: string | null;
}
export interface Schedule {
  userId: string;
  date: string;
  normalShift: NormalShift;
  overtime: boolean;
  version: number;
}

export function shanghaiDate(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2100-12-31';
}

export function normalizeName(input: unknown): { name: string; key: string } {
  if (typeof input !== 'string') throw Object.assign(new Error('请输入姓名'), { statusCode: 400 });
  const name = input.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 10 || !/^[\p{Script=Han}A-Za-z]+$/u.test(name)) {
    throw Object.assign(new Error('姓名需为 1–10 个中文或英文字母，不含数字、标点和内部空格'), { statusCode: 400 });
  }
  return { name, key: name.toLowerCase() };
}
