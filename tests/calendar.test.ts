import test from 'node:test'
import assert from 'node:assert/strict'
import { avatarLayout, contiguousBlocks, monthCells, selectedSlots, shiftLabel, sortedSchedules, type User, type Schedule } from '../web/calendar.js'
test('calendar renders real 4, 5 and 6 week months starting Monday', () => {
  assert.equal(monthCells('2021-02').length, 28)
  assert.equal(monthCells('2026-11').length, 42)
  assert.equal(monthCells('2026-12').length, 35)
  assert.equal(monthCells('2026-11')[6], '2026-11-01')
})
test('non-contiguous morning and overtime leave afternoon empty', () => {
  const record = { normalShift: 'morning', overtime: true } as Schedule
  assert.deepEqual(contiguousBlocks(record), [{ start: 0, end: 0 }, { start: 2, end: 2 }])
  assert.deepEqual(contiguousBlocks({ ...record, normalShift: 'full' }), [{ start: 0, end: 2 }])
})
test('sorting counts full as two segments and ties use registration order', () => {
  const users = [{ id: 'a', registrationSequence: 2 }, { id: 'b', registrationSequence: 1 }, { id: 'c', registrationSequence: 3 }] as User[]
  const records = [{ userId: 'a', normalShift: 'full', overtime: false }, { userId: 'b', normalShift: 'morning', overtime: true }, { userId: 'c', normalShift: 'full', overtime: true }] as Schedule[]
  assert.deepEqual(sortedSchedules(records, users).map(record => record.userId), ['c', 'b', 'a'])
})

test('rest is labeled explicitly, occupies no work slots and sorts after working entries', () => {
  const rest = { userId: 'rest', normalShift: 'rest', overtime: false } as Schedule
  const users = [{ id: 'rest', registrationSequence: 1 }, { id: 'work', registrationSequence: 2 }] as User[]
  assert.deepEqual(selectedSlots(rest), [false, false, false])
  assert.deepEqual(contiguousBlocks(rest), [])
  assert.equal(shiftLabel(rest), '休班')
  assert.equal(shiftLabel(null), '无排班')
  assert.deepEqual(sortedSchedules([rest, { userId: 'work', normalShift: 'none', overtime: true } as Schedule], users).map(record => record.userId), ['work', 'rest'])
})
test('avatars and hidden count fit at most two rows, including narrow +30', () => {
  assert.deepEqual(avatarLayout(5, 40, 34), { columns: 2, visible: 3, hidden: 2, counterSpan: 1 })
  assert.equal(avatarLayout(12, 34, 34).visible, 3)
  const thirty = avatarLayout(30, 34, 34)
  assert.equal(thirty.visible, 2)
  assert.equal(thirty.hidden, 28)
  assert.ok(thirty.visible + thirty.counterSpan <= 4)
  assert.equal(avatarLayout(5, 28, 34).visible, 1)
})
