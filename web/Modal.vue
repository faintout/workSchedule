<script lang="ts">
const dialogs: HTMLElement[] = []
let nextDialogId = 0
let bodyState: { overflow: string; position: string; top: string; width: string; scrollY: number } | undefined
const focusSelector = 'button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'
function focusable(element: HTMLElement) { return Array.from(element.querySelectorAll<HTMLElement>(focusSelector)).filter(item => item.getClientRects().length > 0) }
function focusFirst(element: HTMLElement) { (focusable(element)[0] || element).focus({ preventScroll: true }) }
function updateStack() { dialogs.forEach((element, index) => element.setAttribute('aria-hidden', String(index !== dialogs.length - 1))) }
</script>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
const props = withDefaults(defineProps<{ title: string; canClose?: boolean }>(), { canClose: true })
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLElement>()
const dialogId = ++nextDialogId
let previousFocus: HTMLElement | null = null
function isTop() { return !!dialog.value && dialogs[dialogs.length - 1] === dialog.value }
function keydown(event: KeyboardEvent) {
  if (!isTop()) return
  if (event.key === 'Escape' && props.canClose) { event.preventDefault(); emit('close'); return }
  if (event.key !== 'Tab') return
  const items = focusable(dialog.value!)
  const first = items[0]
  const last = items[items.length - 1]
  if (!first) { event.preventDefault(); dialog.value!.focus(); return }
  if (!dialog.value!.contains(document.activeElement) || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
    event.preventDefault(); (event.shiftKey ? last : first).focus()
  }
}
function focusin(event: FocusEvent) { if (isTop() && !dialog.value!.contains(event.target as Node)) focusFirst(dialog.value!) }
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!dialogs.length) {
    const { overflow, position, top, width } = document.body.style
    bodyState = { overflow, position, top, width, scrollY: window.scrollY }
    Object.assign(document.body.style, { overflow: 'hidden', position: 'fixed', top: `-${window.scrollY}px`, width: '100%' })
  }
  dialogs.push(dialog.value!)
  document.addEventListener('keydown', keydown)
  document.addEventListener('focusin', focusin)
  await nextTick()
  if (isTop()) { focusFirst(dialog.value!); updateStack() }
})
onBeforeUnmount(() => {
  const wasTop = isTop()
  document.removeEventListener('keydown', keydown)
  document.removeEventListener('focusin', focusin)
  const index = dialogs.indexOf(dialog.value!)
  if (index !== -1) dialogs.splice(index, 1)
  updateStack()
  if (!dialogs.length && bodyState) {
    const { scrollY, ...styles } = bodyState
    Object.assign(document.body.style, styles); window.scrollTo(0, scrollY); bodyState = undefined
  }
  if (wasTop) {
    const top = dialogs[dialogs.length - 1]
    if (previousFocus?.isConnected && (!top || top.contains(previousFocus))) previousFocus.focus({ preventScroll: true })
    else if (top) focusFirst(top)
  }
})
</script>
<template>
  <Teleport to="body">
    <div class="modal-overlay" :style="{ zIndex: 1000 + dialogId }" @click.self="canClose && emit('close')">
      <div ref="dialog" class="modal" role="dialog" aria-modal="true" :aria-labelledby="`modal-title-${dialogId}`" tabindex="-1">
        <div class="dialog-card">
          <header class="dialog-heading"><h2 :id="`modal-title-${dialogId}`">{{ title }}</h2><button v-if="canClose" class="icon-button" aria-label="关闭弹框" @click="emit('close')">×</button></header>
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>
