<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from './Modal.vue'
import ScheduleDialog from './ScheduleDialog.vue'
import { api, ApiError } from './api'
import { avatarLayout, monthCells, shanghaiToday, shiftLabel, sortedSchedules, userBackground, type Holiday, type Schedule, type User } from './calendar'
type DisplayMode = 'normal' | 'horizontal' | 'vertical' | 'grouped'
interface HomeSettings { homeTitle: string; syncIntervalMinutes: number }
interface MonthData extends HomeSettings { users: User[]; schedules: Schedule[]; holidays: Holiday[]; holidayStatus: 'pending' | 'ready' }
interface Log { id: number; actorName: string; action: string; targetName: string; date: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; occurredAt: string }
const version = __APP_VERSION__
const currentUser = ref<User | null>(null)
const admin = ref(false)
const month = ref(shanghaiToday().slice(0, 7))
const data = ref<MonthData>({ users: [], schedules: [], holidays: [], holidayStatus: 'pending', homeTitle: '团队排班', syncIntervalMinutes: 0.5 })
const onlyMine = ref(localStorage.getItem('schedule.onlyMine') === 'true')
const selectedUserId = ref('')
const personFilter = computed({
  get: () => selectedUserId.value || (!admin.value && onlyMine.value ? currentUser.value?.id || '' : ''),
  set(value: string) { selectedUserId.value = value; onlyMine.value = !admin.value && !!currentUser.value && value === currentUser.value.id },
})
const displayMode = ref<DisplayMode>('grouped')
const detailMode = computed(() => displayMode.value !== 'normal')
const filterMine = computed(() => !admin.value && !!currentUser.value && personFilter.value === currentUser.value.id)
const cells = computed(() => monthCells(month.value))
const holidayMap = computed(() => new Map(data.value.holidays.map(day => [day.date, day])))
const calendarRows = computed(() => Array.from({ length: cells.value.length / 7 }, (_, week) => cells.value.slice(week * 7, week * 7 + 7).some(date => date && holidayText(date)) ? 84 : 64))
const calendarStyle = computed(() => ({ gridTemplateRows: calendarRows.value.map(height => `minmax(${height}px, 1fr)`).join(' '), minHeight: `${calendarRows.value.reduce((sum, height) => sum + height, 0) + (calendarRows.value.length - 1) * 2}px` }))
const userMap = computed(() => new Map(data.value.users.map(user => [user.id, user])))
const byDate = computed(() => {
  const result = new Map<string, Schedule[]>()
  for (const entry of sortedSchedules(data.value.schedules, data.value.users)) { if (personFilter.value && entry.userId !== personFilter.value) continue; const entries = result.get(entry.date) || []; entries.push(entry); result.set(entry.date, entries) }
  return result
})
const detailByDate = computed(() => new Map([...byDate.value].map(([date, entries]) => [date, [
  { type: 'work', label: '上班', entries: entries.filter(entry => entry.normalShift !== 'rest') },
  { type: 'rest', label: '休息', entries: entries.filter(entry => entry.normalShift === 'rest') },
].filter(group => group.entries.length)])))
const myDates = computed(() => new Map(data.value.schedules.filter(entry => entry.userId === currentUser.value?.id).map(entry => [entry.date, entry])))
const selectedDate = ref<string | null>(null)
const calendar = ref<HTMLElement>()
const viewportHeight = ref(window.innerHeight)
const scheduleDialog = ref<InstanceType<typeof ScheduleDialog>>()
const avatarWidth = ref(34)
const modal = ref<'identity' | 'admin' | 'month' | 'rename' | null>(null)
const tab = ref('calendar')
const name = ref('')
const candidates = ref<User[] | null>(null)
const password = ref('')
const pickedMonth = ref(month.value)
const error = ref('')
const busy = ref(false)
const connected = ref(false)
const adminUsers = ref<User[]>([])
const newName = ref('')
const renamingUser = ref<User | null>(null)
const renameName = ref('')
const renameAsAdmin = ref(false)
const homeTitle = ref('')
const syncIntervalMinutes = ref(0.5)
const settingsNotice = ref('')
const logDate = ref(shanghaiToday())
const logPage = ref(1)
const logData = ref<{ logs: Log[]; total: number; pageSize: number }>({ logs: [], total: 0, pageSize: 30 })
let requestNumber = 0
let identityRequestNumber = 0
let usersRequestNumber = 0
let identityAttempt = 0
let timer: ReturnType<typeof setInterval> | undefined
let observer: ResizeObserver
watch(onlyMine, value => localStorage.setItem('schedule.onlyMine', String(value)))
watch(() => data.value.users, users => { if (selectedUserId.value && !users.some(user => user.id === selectedUserId.value)) selectedUserId.value = '' })
watch(displayMode, () => { void nextTick(fitAvatars) })
watch(() => data.value.syncIntervalMinutes, () => { if (timer) restartSyncTimer() })
watch(logDate, () => { logPage.value = 1; if (tab.value === 'logs') void loadLogs() })
function message(cause: unknown) { error.value = cause instanceof Error ? cause.message : '网络连接失败，请重试' }
function rememberIdentity() { if (currentUser.value) localStorage.setItem('schedule.user', JSON.stringify(currentUser.value)); else localStorage.removeItem('schedule.user') }
async function refreshIdentity() {
  const number = ++identityRequestNumber
  const session = await api<{ user: User | null; admin: boolean }>('/session')
  if (number !== identityRequestNumber) return
  currentUser.value = session.user; admin.value = session.admin; connected.value = true; rememberIdentity()
  if (!session.admin) tab.value = 'calendar'
}
async function loadMonth(target = month.value) {
  const number = ++requestNumber
  try {
    const result = await api<MonthData>(`/month?month=${target}`)
    if (number !== requestNumber) return
    data.value = result; month.value = target; error.value = ''
  } catch (cause) { if (number === requestNumber) { message(cause); if (cause instanceof ApiError && cause.status === 401) await refreshIdentity() } }
}
async function refresh() {
  try { await refreshIdentity(); await loadMonth(); if (tab.value === 'users') await loadUsers(); if (tab.value === 'logs') await loadLogs() } catch (cause) { message(cause) }
}
function fitAvatars() { const area = calendar.value?.querySelector<HTMLElement>('.avatars'); if (area) avatarWidth.value = area.clientWidth }
function fitViewport() { viewportHeight.value = window.innerHeight }
function restartSyncTimer() { clearInterval(timer); timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, data.value.syncIntervalMinutes * 60_000) }
onMounted(async () => {
  window.addEventListener('resize', fitViewport)
  if (location.pathname === '/admin') modal.value = 'admin'
  await refresh()
  if (admin.value && modal.value === 'admin') modal.value = null
  await nextTick(); observer = new ResizeObserver(fitAvatars); if (calendar.value) observer.observe(calendar.value); fitAvatars()
  restartSyncTimer()
  document.addEventListener('visibilitychange', foreground)
})
onBeforeUnmount(() => { observer?.disconnect(); clearInterval(timer); document.removeEventListener('visibilitychange', foreground); window.removeEventListener('resize', fitViewport) })
watch(cells, () => nextTick(fitAvatars))
watch(calendar, value => { if (observer) { observer.disconnect(); if (value) observer.observe(value); fitAvatars() } })
function foreground() { if (document.visibilityState === 'visible') void refresh() }
function moveMonth(amount: number) {
  const [year, number] = month.value.split('-').map(Number)
  const date = new Date(Date.UTC(year, number - 1 + amount, 1))
  void loadMonth(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`)
}
function layout(date: string) { return avatarLayout(byDate.value.get(date)?.length ?? 0, avatarWidth.value, 34) }
function holidayText(date: string) { const day = holidayMap.value.get(date); return day?.type === 4 ? `班 ${day.name || '补班'}` : day && [2, 3].includes(day.type) ? `休 ${day.name || '放假'}` : '' }
function isWeekend(date: string) { const day = holidayMap.value.get(date); return day?.type !== 4 && ([0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()) || !!day && [2, 3].includes(day.type)) }
function openDate(date: string) { selectedDate.value = date }
async function closeDate() { const date = selectedDate.value; selectedDate.value = null; await nextTick(); calendar.value?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus() }
async function findIdentity() {
  const attempt = ++identityAttempt
  busy.value = true; error.value = ''
  try {
    const result = await api<{ users: User[] }>('/identity/candidates', 'POST', { name: name.value.trim() })
    if (attempt !== identityAttempt || modal.value !== 'identity') return
    candidates.value = result.users; if (!result.users.length) await establishIdentity()
  } catch (cause) { if (attempt === identityAttempt && modal.value === 'identity') message(cause) } finally { if (attempt === identityAttempt) busy.value = false }
}
async function establishIdentity(userId?: string) {
  const attempt = identityAttempt
  busy.value = true; error.value = ''
  try {
    const result = await api<{ user: User }>('/identity', 'POST', { name: name.value.trim(), userId })
    if (attempt !== identityAttempt || modal.value !== 'identity') return
    currentUser.value = result.user; rememberIdentity(); modal.value = null; candidates.value = null; name.value = ''; await loadMonth(); await nextTick(); scheduleDialog.value?.startEdit(result.user.id)
  } catch (cause) { if (attempt === identityAttempt) message(cause) } finally { if (attempt === identityAttempt) busy.value = false }
}
function requestIdentity() { identityAttempt++; busy.value = false; error.value = ''; candidates.value = null; name.value = ''; modal.value = 'identity' }
async function loginAdmin() {
  busy.value = true; error.value = ''
  try { await api('/admin/login', 'POST', { password: password.value }); password.value = ''; modal.value = null; admin.value = true; await refresh() } catch (cause) { message(cause) } finally { busy.value = false }
}
async function logoutAdmin() {
  try { await api('/admin/logout', 'POST'); admin.value = false; tab.value = 'calendar'; history.replaceState({}, '', '/'); await refresh() } catch (cause) { message(cause) }
}
function closeModal() {
  if (modal.value === 'identity') { identityAttempt++; busy.value = false }
  modal.value = null; error.value = ''; password.value = ''
}
async function changeTab(value: string) { tab.value = value; error.value = ''; if (value === 'users') await loadUsers(); if (value === 'logs') await loadLogs(); if (value === 'settings') { homeTitle.value = data.value.homeTitle; syncIntervalMinutes.value = data.value.syncIntervalMinutes; settingsNotice.value = '' } }
async function saveSettings() {
  busy.value = true; error.value = ''; settingsNotice.value = ''
  try { const result = await api<HomeSettings>('/admin/settings', 'PUT', { homeTitle: homeTitle.value, syncIntervalMinutes: syncIntervalMinutes.value }); requestNumber++; Object.assign(data.value, result); homeTitle.value = result.homeTitle; syncIntervalMinutes.value = result.syncIntervalMinutes; settingsNotice.value = '参数配置已保存' } catch (cause) { message(cause) } finally { busy.value = false }
}
async function loadUsers() {
  const number = ++usersRequestNumber
  try { const result = await api<{ users: User[] }>('/admin/users'); if (number === usersRequestNumber) adminUsers.value = result.users } catch (cause) { if (number === usersRequestNumber) message(cause) }
}
function openRename(user: User, asAdmin = false) { renamingUser.value = user; renameName.value = user.originalName; renameAsAdmin.value = asAdmin; error.value = ''; modal.value = 'rename' }
async function saveRename() {
  busy.value = true; error.value = ''
  try {
    const result = await api<{ user: User }>(renameAsAdmin.value ? `/admin/users/${renamingUser.value!.id}` : '/identity', 'PUT', { name: renameName.value.trim() })
    requestNumber++; identityRequestNumber++; usersRequestNumber++
    if (currentUser.value?.id === result.user.id) { currentUser.value = result.user; rememberIdentity() }
    data.value.users = data.value.users.map(user => user.id === result.user.id ? result.user : user)
    adminUsers.value = adminUsers.value.map(user => user.id === result.user.id ? result.user : user)
    modal.value = null; await refresh()
  } catch (cause) { message(cause) } finally { busy.value = false }
}
async function addUser() {
  busy.value = true; error.value = ''
  try {
    const existing = (await api<{ users: User[] }>('/identity/candidates', 'POST', { name: newName.value.trim() })).users
    if (existing.length && !window.confirm(`已有${existing.map(user => user.displayName).join('、')}。创建另一位同名用户？`)) return
    await api('/admin/users', 'POST', { name: newName.value.trim() }); newName.value = ''; await loadUsers(); await loadMonth()
  } catch (cause) { message(cause) } finally { busy.value = false }
}
async function deleteUser(user: User) {
  busy.value = true; error.value = ''
  try {
    const preview = await api<{ futureCount: number; firstDate: string | null; lastDate: string | null }>(`/admin/users/${user.id}/deletion-preview`)
    if (!window.confirm(`删除${user.displayName}的账号？将删除明天起 ${preview.futureCount} 条排班${preview.firstDate ? `（${preview.firstDate} 至 ${preview.lastDate}）` : ''}，保留今天及历史排班。`)) return
    await api(`/admin/users/${user.id}`, 'DELETE'); await loadUsers(); await refresh()
  } catch (cause) { message(cause) } finally { busy.value = false }
}
async function loadLogs() { try { logData.value = await api(`/admin/logs?date=${logDate.value}&page=${logPage.value}`) } catch (cause) { message(cause) } }
async function pageLogs(amount: number) { logPage.value += amount; await loadLogs() }
const time = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
function describeLog(log: Log) {
  if (log.action === 'user.create') return `添加了用户 ${log.targetName}`
  if (log.action === 'user.rename') return `将 ${log.before?.displayName} 改名为 ${log.after?.displayName}`
  if (log.action === 'user.delete' || log.action === 'user.disable') return `${log.action === 'user.delete' ? '删除了' : '停用了'} ${log.targetName}，删除 ${log.after?.futureCount ?? 0} 条未来排班${log.after?.firstDate ? `（${log.after.firstDate} 至 ${log.after.lastDate}）` : ''}`
  return `${log.targetName} · ${log.date} · ${shiftLabel(log.before as unknown as Schedule)} → ${shiftLabel(log.after as unknown as Schedule)}`
}
async function refreshHolidays() { busy.value = true; try { await api(`/admin/holidays/${month.value.slice(0, 4)}/refresh`, 'POST'); await loadMonth() } catch (cause) { message(cause) } finally { busy.value = false } }
</script>
<template>
  <main class="app-shell" :class="{ 'calendar-view': tab === 'calendar', 'detail-view': tab === 'calendar' && detailMode }" :style="{ '--viewport-height': `${viewportHeight}px` }">
    <header class="app-heading">
      <div><h1>{{ data.homeTitle || '团队排班' }}</h1><span v-if="!connected" class="muted">正在连接…</span></div>
      <button v-if="admin" class="text-button" @click="logoutAdmin">退出管理</button>
    </header>
    <div v-if="tab === 'calendar'" class="identity-toolbar"><span v-if="currentUser && !admin" class="welcome"><span class="welcome-label">欢迎</span><button class="welcome-name" :style="{ background: userBackground(currentUser) }" :aria-label="`修改我的名称：${currentUser.displayName}`" aria-haspopup="dialog" :disabled="busy" @click="openRename(currentUser)">{{ currentUser.displayName }}</button></span><div class="calendar-filters"><select v-model="personFilter" class="person-filter" aria-label="查看人员"><option value="">全部人员</option><option v-for="user in data.users" :key="user.id" :value="user.id">{{ user.displayName }}{{ user.id === currentUser?.id && !admin ? '（我）' : '' }}{{ user.deletedAt ? '（已删除）' : '' }}</option></select></div></div>
    <nav v-if="admin" class="admin-tabs" aria-label="管理功能"><span class="mode-tag">管理模式</span><button v-for="item in [{ id: 'calendar', label: '排班日历' }, { id: 'users', label: '用户管理' }, { id: 'logs', label: '操作日志' }, { id: 'settings', label: '参数配置' }]" :key="item.id" :class="{ active: tab === item.id }" @click="changeTab(item.id)">{{ item.label }}</button></nav>
    <template v-if="tab === 'calendar'">
      <div class="month-navigation"><button class="icon-button" aria-label="上个月" @click="moveMonth(-1)">‹</button><button class="month-title" @click="pickedMonth = month; modal = 'month'"><span>{{ month.slice(0, 4) }} 年</span><strong>{{ Number(month.slice(5)) }} 月</strong></button><button class="icon-button" aria-label="下个月" @click="moveMonth(1)">›</button><button class="text-button current-month" @click="loadMonth(shanghaiToday().slice(0, 7))">回到本月</button></div>
      <div v-if="admin" class="calendar-toolbar"><span v-if="data.holidayStatus !== 'ready'" class="muted">该年法定节假日待更新</span><button class="text-button" :disabled="busy" @click="refreshHolidays">刷新节假日</button></div>
      <div class="weekdays"><span v-for="day in ['一', '二', '三', '四', '五', '六', '日']" :key="day">{{ day }}</span></div>
      <div ref="calendar" class="calendar" :class="{ 'detailed-calendar': detailMode, 'horizontal-details': displayMode === 'horizontal', 'grouped-details': displayMode === 'grouped' }" :style="detailMode ? undefined : calendarStyle" :aria-label="month + '月历'">
        <template v-for="(date, index) in cells" :key="date || index">
          <button v-if="date" class="day" :data-date="date" :class="{ weekend: isWeekend(date), 'has-mine': ['morning', 'afternoon', 'full'].includes(myDates.get(date)?.normalShift || '') || myDates.get(date)?.overtime, 'has-rest': myDates.get(date)?.normalShift === 'rest', selected: selectedDate === date }" :aria-label="date + '，' + (byDate.get(date)?.map(entry => userMap.get(entry.userId)!.displayName + ' ' + shiftLabel(entry)).join('，') || '暂无排班')" aria-haspopup="dialog" :aria-expanded="selectedDate === date" @click="openDate(date)">
            <span class="number-row"><span class="day-number" :class="{ today: date === shanghaiToday() }">{{ Number(date.slice(-2)) }}</span><span v-if="myDates.get(date)?.normalShift === 'rest'" class="rest-badge">休</span><span v-else-if="myDates.get(date)?.overtime" class="overtime-badge">加</span></span>
            <span v-if="holidayText(date)" class="holiday" :class="{ makeup: holidayMap.get(date)?.type === 4 }">{{ holidayText(date) }}</span>
            <span v-if="detailMode" class="day-details"><span v-for="group in detailByDate.get(date)" :key="group.type" class="day-group" :class="group.type" :aria-label="group.label + '人员'"><span v-if="displayMode === 'grouped'" class="day-group-label">{{ group.label }}</span><span class="detail-avatars"><span v-for="entry in group.entries" :key="entry.userId" class="detail-person"><span class="avatar" :style="{ background: userBackground(userMap.get(entry.userId)!) }" :title="userMap.get(entry.userId)!.displayName + ' · ' + shiftLabel(entry)">{{ [...userMap.get(entry.userId)!.originalName].slice(-1)[0] }}</span></span></span></span></span>
            <span v-else class="avatars" :style="{ gridTemplateColumns: `repeat(${layout(date).columns}, minmax(0, 1fr))` }"><span v-for="entry in (byDate.get(date) || []).slice(0, layout(date).visible)" :key="entry.userId" class="avatar" :style="{ background: userBackground(userMap.get(entry.userId)!) }">{{ [...userMap.get(entry.userId)!.originalName].slice(-1)[0] }}</span><span v-if="layout(date).hidden" class="extra" :style="{ gridColumn: `span ${layout(date).counterSpan}` }">+{{ layout(date).hidden }}</span></span>
          </button><span v-else class="blank-day" aria-hidden="true"></span>
        </template>
      </div>
      <footer class="calendar-footer"><span><i class="legend-self"></i>我的上班</span><span><i class="overtime-badge">加</i>我的加班</span><span><i class="rest-badge">休</i>我的休班</span><span class="muted">点击日期查看详情</span><span class="version">v{{ version }}</span></footer>
    </template>
    <section v-if="admin && tab === 'users'" class="management"><h2>用户管理</h2><form class="inline-form" @submit.prevent="addUser"><label class="field">姓名<input v-model="newName" maxlength="10" placeholder="1–10 个中文或英文字母" required></label><button class="primary" :disabled="busy">添加用户</button></form><ul class="user-list"><li v-for="user in adminUsers" :key="user.id"><span><i class="dot" :style="{ background: user.color }"></i>{{ user.displayName }}</span><div class="user-actions"><button :disabled="busy" :aria-label="`修改名称：${user.displayName}`" @click="openRename(user, true)">改名</button><button class="danger" :disabled="busy" @click="deleteUser(user)">删除</button></div></li></ul></section>
    <section v-if="admin && tab === 'logs'" class="management"><h2>操作日志</h2><label class="field">查询日期<input v-model="logDate" type="date" required></label><p class="muted">按上海时间显示，最近操作在前。</p><ol class="log-list"><li v-for="log in logData.logs" :key="log.id"><strong>{{ log.actorName }} · {{ time(log.occurredAt) }}</strong><p>{{ describeLog(log) }}</p></li></ol><p v-if="!logData.logs.length" class="muted">当天暂无操作记录</p><div class="pagination"><button :disabled="logPage === 1" @click="pageLogs(-1)">上一页</button><span>{{ logPage }} / {{ Math.max(1, Math.ceil(logData.total / logData.pageSize)) }}</span><button :disabled="logPage * logData.pageSize >= logData.total" @click="pageLogs(1)">下一页</button></div></section>
    <section v-if="admin && tab === 'settings'" class="management"><h2>参数配置</h2><form class="identity-form" @submit.prevent="saveSettings"><label class="field">首页左侧标题<input v-model="homeTitle" placeholder="团队排班" required :disabled="busy"></label><p class="muted">1–40 个字，保存后对所有人显示。</p><label class="field">自动同步间隔（分钟）<input v-model.number="syncIntervalMinutes" type="number" min="0" step="any" required :disabled="busy"></label><p class="muted">请输入大于 0 的分钟数，支持小数。页面可见时自动同步，默认 0.5 分钟（30 秒）。</p><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存设置' }}</button></form><p v-if="settingsNotice" class="notice" role="status">{{ settingsNotice }}</p></section>
    <div v-if="error && !modal" class="error global-error" role="alert">{{ error }} <button class="text-button" @click="refresh">重试</button></div>
  </main>
  <ScheduleDialog v-if="selectedDate" ref="scheduleDialog" :date="selectedDate" :users="data.users" :schedules="data.schedules" :current-user="currentUser" :admin="admin" :only-mine="filterMine" :filter-user-id="personFilter" :holiday="holidayMap.get(selectedDate)" @close="closeDate" @saved="loadMonth()" @login="requestIdentity" />
  <Modal v-if="modal === 'identity'" title="确认你的姓名" @close="closeModal">
    <p class="muted">输入姓名，新设备可认领已有成员。</p>
    <form v-if="candidates === null" class="identity-form" @submit.prevent="findIdentity"><label class="field">姓名<input v-model="name" maxlength="10" placeholder="1–10 个中文或英文字母" autocomplete="name" required :disabled="busy"></label><button class="primary" :disabled="busy">{{ busy ? '正在确认…' : '继续' }}</button></form>
    <div v-else><p>已有同名成员，请确认：</p><ul class="candidate-list"><li v-for="user in candidates" :key="user.id"><span><i class="dot" :style="{ background: user.color }"></i>{{ user.displayName }}</span><button :disabled="busy" @click="establishIdentity(user.id)">这是我</button></li></ul><div class="actions"><button class="primary" :disabled="busy" @click="establishIdentity()">创建另一位同名用户</button><button :disabled="busy" @click="candidates = null">返回</button></div></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </Modal>
  <Modal v-if="modal === 'rename'" :title="renameAsAdmin ? '修改用户名称' : '修改我的名称'" :can-close="!busy" @close="closeModal">
    <p class="muted"><template v-if="renameAsAdmin">正在修改：{{ renamingUser?.displayName }}。 </template>同名时自动添加数字后缀。</p>
    <form class="identity-form" @submit.prevent="saveRename"><label class="field">姓名<input v-model="renameName" maxlength="10" placeholder="1–10 个中文或英文字母" autocomplete="name" required :disabled="busy"></label><div class="actions"><button class="primary" :disabled="busy">{{ busy ? '保存中…' : '保存名称' }}</button><button type="button" :disabled="busy" @click="closeModal">取消</button></div></form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </Modal>
  <Modal v-if="modal === 'admin'" title="管理员登录" @close="closeModal"><form class="identity-form" @submit.prevent="loginAdmin"><label class="field">管理员密码<input v-model="password" type="password" minlength="6" autocomplete="current-password" required :disabled="busy"></label><button class="primary" :disabled="busy">{{ busy ? '登录中…' : '进入管理' }}</button></form><p v-if="error" class="error" role="alert">{{ error }}</p></Modal>
  <Modal v-if="modal === 'month'" title="选择年月" @close="closeModal"><form class="identity-form" @submit.prevent="modal = null; loadMonth(pickedMonth)"><label class="field">年月<input v-model="pickedMonth" type="month" min="1900-01" max="2100-12" required></label><button class="primary">查看月份</button></form></Modal>
</template>
