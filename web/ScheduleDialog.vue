<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from './Modal.vue'
import { api, ApiError } from './api'
import { contiguousBlocks, selectedSlots, shiftLabel, sortedSchedules, userBackground, weekdays, type Holiday, type Schedule, type User } from './calendar'
const props = defineProps<{ date: string; users: User[]; schedules: Schedule[]; currentUser: User | null; admin: boolean; onlyMine: boolean; holiday?: Holiday }>()
const emit = defineEmits<{ close: []; saved: []; login: [] }>()
const title = computed(() => `${props.date.replace(/^(\d+)-(\d+)-(\d+)$/, (_, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)} · ${weekdays[new Date(props.date + 'T00:00:00Z').getUTCDay()]}`)
const people = ref<HTMLElement>()
const columnWidth = ref(34)
const hasMoreLeft = ref(false)
const hasMoreRight = ref(false)
const editing = ref(false)
const editingUserId = ref('')
const original = ref<Schedule>()
const checks = ref([false, false, false, false])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const frozen = ref<Schedule[]>([])
const entries = computed(() => editing.value ? frozen.value : sortedSchedules(props.schedules.filter(entry => entry.date === props.date && (!props.onlyMine || entry.userId === props.currentUser?.id)), props.users))
const workingEntries = computed(() => entries.value.filter(entry => entry.normalShift !== 'rest'))
const restEntries = computed(() => entries.value.filter(entry => entry.normalShift === 'rest'))
const userMap = computed(() => new Map(props.users.map(user => [user.id, user])))
const detailUsers = computed(() => entries.value.map(entry => userMap.value.get(entry.userId)!))
const activeUsers = computed(() => props.users.filter(user => !user.deletedAt))
const editedUser = computed(() => userMap.value.get(editingUserId.value))
const emptySelection = computed(() => !checks.value.some(Boolean))
const canAdd = computed(() => !props.admin || activeUsers.value.length > 0)
let observer: ResizeObserver
function locateOwn() {
  const area = people.value
  if (!area) return
  const index = workingEntries.value.findIndex(entry => entry.userId === props.currentUser?.id)
  if (index < 0) return
  const left = index * (columnWidth.value + 3)
  if (left < area.scrollLeft) area.scrollLeft = left
  else if (left + columnWidth.value > area.scrollLeft + area.clientWidth) area.scrollLeft = left + columnWidth.value - area.clientWidth
  updateOverflow()
}
function updateOverflow() {
  const area = people.value
  if (!area) return
  hasMoreLeft.value = area.scrollLeft > 1
  hasMoreRight.value = area.scrollWidth - area.clientWidth - area.scrollLeft > 1
}
function scrollPeople(direction: number) {
  if (people.value) people.value.scrollLeft += direction * (people.value.clientWidth - columnWidth.value)
}
function fit() {
  const width = people.value?.clientWidth ?? 250
  const columns = Math.max(1, Math.min(7, workingEntries.value.length))
  columnWidth.value = (width - (columns - 1) * 3) / columns
  void nextTick(updateOverflow)
}
onMounted(async () => { await nextTick(); observer = new ResizeObserver(fit); observer.observe(people.value!); fit(); await nextTick(); locateOwn() })
onBeforeUnmount(() => observer?.disconnect())
watch(entries, () => { void nextTick(fit) })
watch(() => props.currentUser?.id, async () => { editing.value = false; await nextTick(); fit(); await nextTick(); locateOwn() })
function addSchedule() {
  if (!props.admin && !props.currentUser) { emit('login'); return }
  startEdit(props.admin ? props.currentUser?.id || activeUsers.value[0]!.id : props.currentUser!.id)
}
function startEdit(userId: string) {
  if (busy.value) return
  if (!props.admin && userId !== props.currentUser?.id) return
  frozen.value = [...entries.value]
  editing.value = true; editingUserId.value = userId; error.value = ''; notice.value = ''
  loadSelection()
}
defineExpose({ startEdit })
function loadSelection() {
  original.value = props.schedules.find(entry => entry.userId === editingUserId.value && entry.date === props.date)
  checks.value = [...selectedSlots(original.value), original.value?.normalShift === 'rest']
}
function selectOption(index: number) {
  if (!checks.value[index]) return
  if (index === 3) checks.value = [false, false, false, true]
  else checks.value[3] = false
}
async function save(remove = false) {
  if (busy.value || (!original.value && (remove || emptySelection.value))) return
  if ((remove || emptySelection.value) && !window.confirm(`删除${editedUser.value?.displayName}在${props.date}的排班？`)) return
  busy.value = true; error.value = ''
  try {
    const normalShift = checks.value[3] ? 'rest' : checks.value[0] && checks.value[1] ? 'full' : checks.value[0] ? 'morning' : checks.value[1] ? 'afternoon' : 'none'
    const path = `/schedules/${editingUserId.value}/${props.date}`
    const deleting = remove || emptySelection.value
    await api(path, deleting ? 'DELETE' : 'PUT', deleting ? { version: original.value!.version } : { normalShift, overtime: checks.value[2], version: original.value?.version ?? null })
    editing.value = false; notice.value = deleting ? '排班已删除' : '排班已保存'; emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试'
    if (cause instanceof ApiError && cause.status === 409) { error.value = '排班已被其他人修改，请取消编辑并重新加载后再保存。'; emit('saved') }
  } finally { busy.value = false }
}
function blockStyle(entry: Schedule, start: number, end: number) {
  const heights = [120, 120, 60]
  const normalHeight = heights.slice(start, Math.min(end + 1, 2)).reduce((sum, height) => sum + height, 0)
  const height = heights.slice(start, end + 1).reduce((sum, part) => sum + part, 0)
  return { gridRow: `${start + 2} / ${end + 3}`, background: userBackground(userMap.value.get(entry.userId)!), '--name-height': `${normalHeight || height}px` }
}
</script>
<template>
  <Modal :title="title" @close="emit('close')">
    <p class="detail-meta">{{ holiday?.type === 4 ? '补班 · ' + holiday.name : holiday && [2, 3].includes(holiday.type) ? '休假 · ' + holiday.name : '' }}{{ onlyMine ? '仅我的排班 · ' : '' }}{{ workingEntries.length }} 人上班 · {{ restEntries.length }} 人休班</p>
    <div v-if="detailUsers.length" class="members" aria-label="当天排班人员"><span v-for="user in detailUsers" :key="user.id" class="member"><i class="dot" :style="{ background: userBackground(user) }"></i>{{ user.displayName }}<span v-if="user.id === currentUser?.id" class="me-tag">我</span><span v-if="user.deletedAt" class="muted">已删除</span></span></div>
    <div v-show="workingEntries.length || !restEntries.length" class="matrix">
      <div class="axis"><span></span><span>上午</span><span>下午</span><span>加班</span></div>
      <div class="matrix-body" :class="{ 'more-left': hasMoreLeft, 'more-right': hasMoreRight }">
        <div ref="people" class="people-scroll" role="region" aria-label="排班时段，可左右滚动" tabindex="0" @scroll="updateOverflow">
          <div class="people" :style="{ '--column-width': columnWidth + 'px' }">
            <article v-for="entry in workingEntries" :key="entry.userId" class="person-column" :class="{ 'is-me': entry.userId === currentUser?.id }" :aria-label="userMap.get(entry.userId)!.displayName">
              <div class="column-heading">{{ entry.userId === currentUser?.id ? '我' : '' }}</div>
              <span v-for="row in 3" :key="row" class="lane" :style="{ gridRow: row + 1 }" aria-hidden="true"></span>
              <component :is="admin || entry.userId === currentUser?.id ? 'button' : 'div'" v-for="block in contiguousBlocks(entry)" :key="block.start" type="button" class="shift-block" :class="{ 'overtime-only': block.start === 2 }" :style="blockStyle(entry, block.start, block.end)" :aria-label="userMap.get(entry.userId)!.displayName + '，' + shiftLabel(entry) + (admin || entry.userId === currentUser?.id ? '，编辑排班' : '')" @click="startEdit(entry.userId)">
                <span class="block-label"><span class="block-name">{{ userMap.get(entry.userId)!.displayName }}</span></span>
              </component>
            </article>
            <p v-if="!workingEntries.length" class="empty-detail">{{ restEntries.length ? '当天无人上班' : '当天暂无排班' }}</p>
          </div>
        </div>
        <button v-if="hasMoreLeft" type="button" class="scroll-edge scroll-left" aria-label="向左查看更多排班" @click="scrollPeople(-1)">‹</button>
        <button v-if="hasMoreRight" type="button" class="scroll-edge scroll-right" aria-label="向右查看更多排班" @click="scrollPeople(1)">›</button>
      </div>
    </div>
    <p v-if="hasMoreLeft || hasMoreRight" class="scroll-hint">左右滑动查看更多人员</p>
    <div v-if="restEntries.length" class="rest-members" aria-label="当天休班人员"><span class="rest-heading">休班</span><div class="rest-people"><component :is="admin || entry.userId === currentUser?.id ? 'button' : 'span'" v-for="entry in restEntries" :key="entry.userId" type="button" class="rest-person welcome-name" :style="{ background: userBackground(userMap.get(entry.userId)!) }" :aria-label="userMap.get(entry.userId)!.displayName + '，休班' + (admin || entry.userId === currentUser?.id ? '，编辑排班' : '')" @click="startEdit(entry.userId)">{{ userMap.get(entry.userId)!.displayName }}<span v-if="userMap.get(entry.userId)!.deletedAt" class="muted">已删除</span></component></div></div>
    <form v-if="editing" class="schedule-form" @submit.prevent="save()">
      <label v-if="admin && !editedUser?.deletedAt" class="field">排班人员<select v-model="editingUserId" :disabled="busy" @change="loadSelection"><option v-for="user in activeUsers" :key="user.id" :value="user.id">{{ user.displayName }}</option></select></label>
      <p v-else class="edit-person">{{ editedUser?.displayName }}{{ editedUser?.deletedAt ? '（已删除，仅修正历史）' : '的排班' }}</p>
      <fieldset :disabled="busy"><legend>选择排班</legend><div class="checks"><label v-for="(label, index) in ['上午', '下午', '加班', '休班']" :key="label" :class="{ 'rest-option': index === 3 }"><input v-model="checks[index]" type="checkbox" @change="selectOption(index)">{{ label }}</label></div></fieldset>
      <div class="actions"><button class="primary" :disabled="busy || (!original && emptySelection)">{{ busy ? '保存中…' : original && emptySelection ? '删除排班' : '保存' }}</button><button type="button" :disabled="busy" @click="editing = false; error = ''">取消</button><button v-if="original" type="button" class="danger push-right" :disabled="busy" @click="save(true)">删除</button></div>
    </form>
    <div v-else-if="canAdd" class="actions"><button class="primary" @click="addSchedule">{{ admin ? '添加排班' : schedules.some(entry => entry.date === date && entry.userId === currentUser?.id) ? '编辑我的排班' : '添加我的排班' }}</button></div>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="notice" class="notice" role="status">{{ notice }}</p>
  </Modal>
</template>
