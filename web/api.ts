export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new ApiError(response.status, data.message || data.error || '请求失败，请重试')
  return data as T
}
