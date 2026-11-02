export interface User {
  id: string
  originalName: string
  displayName: string
  registrationSequence: number
  colorIndex: number
  color: string
  disabledAt: string | null
}
export interface Schedule {
  userId: string
  date: string
  normalShift: 'none' | 'morning' | 'afternoon' | 'full'
  overtime: boolean
  version: number
}
export interface Holiday { date: string; type: number; name: string }
export function userBackground(user: User) {
  const ends = ['#20B5DF', '#39BDA0', '#27BBCE', '#C278DA', '#E88693', '#39B99B', '#789CE4', '#B5BE57', '#E6A65E', '#849AB1']
  return `linear-gradient(135deg, ${user.color}, ${ends[user.colorIndex]})`
}
export const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function shanghaiToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: string) => parts.find(p => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function monthCells(month: string): (string | null)[] {
  const [year, number] = month.split('-').map(Number)
  const offset = (new Date(Date.UTC(year, number - 1, 1)).getUTCDay() + 6) % 7
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate()
  return Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, i) => i < offset || i >= offset + days ? null : `${month}-${String(i - offset + 1).padStart(2, '0')}`)
}
export function selectedSlots(schedule?: Schedule) {
  return [schedule?.normalShift === 'morning' || schedule?.normalShift === 'full', schedule?.normalShift === 'afternoon' || schedule?.normalShift === 'full', !!schedule?.overtime]
}
export function sortedSchedules(schedules: Schedule[], users: User[]) {
  const sequence = new Map(users.map(user => [user.id, user.registrationSequence]))
  const count = (schedule: Schedule) => selectedSlots(schedule).filter(Boolean).length
  return [...schedules].sort((a, b) => count(b) - count(a) || (sequence.get(a.userId) ?? 0) - (sequence.get(b.userId) ?? 0))
}
export function contiguousBlocks(schedule: Schedule) {
  const slots = selectedSlots(schedule)
  const blocks: { start: number; end: number }[] = []
  for (let start = 0; start < 3; start++) {
    if (!slots[start]) continue
    let end = start
    while (end < 2 && slots[end + 1]) end++
    blocks.push({ start, end }); start = end
  }
  return blocks
}
export function shiftLabel(schedule?: Pick<Schedule, 'normalShift' | 'overtime'> | null) {
  if (!schedule) return '无排班'
  const normal = { none: '', morning: '上午', afternoon: '下午', full: '全天' }[schedule.normalShift]
  return [normal, schedule.overtime ? '加班' : ''].filter(Boolean).join(' + ') || '无排班'
}
export function avatarLayout(count: number, width: number, height: number) {
  const columns = width >= 34 ? 2 : 1
  const rows = Math.min(2, Math.max(1, Math.floor((height + 2) / 18)))
  const capacity = columns * rows
  const counterSpan = count >= 13 && columns === 2 && width < 42 ? 2 : 1
  const visible = count > Math.min(3, capacity) ? Math.max(0, Math.min(3, capacity - counterSpan)) : Math.min(count, 3, capacity)
  return { columns, visible, hidden: count - visible, counterSpan }
}
