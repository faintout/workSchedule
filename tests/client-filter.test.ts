import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import type { Schedule, User } from '../web/calendar.js';
import viteConfig from '../vite.config.js';

test('person selection filters work and rest without changing identity or editing permissions', async t => {
  const vite = await createServer({
    ...viteConfig, configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, open: false },
  });
  t.after(() => vite.close());
  const App = (await vite.ssrLoadModule('/web/App.vue')).default;
  const Dialog = (await vite.ssrLoadModule('/web/ScheduleDialog.vue')).default;
  const users: User[] = ['张三', '李四', '王五'].map((name, index) => ({
    id: `user-${index}`, originalName: name, displayName: name, registrationSequence: index + 1,
    colorIndex: index, color: '#20B5DF', deletedAt: null,
  }));
  const [self, other, unscheduled] = users;
  const schedules: Schedule[] = [self, other].flatMap((user, index) => [
    { userId: user.id, date: '2026-11-02', normalShift: index ? 'full' : 'morning', overtime: false, version: index + 1 },
    { userId: user.id, date: '2026-11-03', normalShift: 'rest', overtime: false, version: index + 3 },
  ]);
  let remote = { users, schedules, holidays: [], holidayStatus: 'ready', homeTitle: '团队排班', syncIntervalMinutes: 0.5 };
  let session: { user: User | null; admin: boolean } = { user: null, admin: false };
  const storage = new Map<string, string>();
  const requests: { path: string; method: string }[] = [];
  let finishMount: (() => void) | undefined;
  const globals = {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    location: { pathname: '/' },
    document: { visibilityState: 'visible', addEventListener(name: string) { if (name === 'visibilitychange') finishMount?.(); }, removeEventListener() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    requests.push({ path, method: options?.method ?? 'GET' });
    return Response.json(path === '/api/session' ? session : remote);
  });
  t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  const renderer = createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  const mount = async () => {
    const ready = new Promise<void>(resolve => { finishMount = resolve; });
    const app = renderer.createApp({ ...App, render: () => null });
    app.provide(ssrContextKey, {});
    const vm = app.mount({});
    await ready; finishMount = undefined; await nextTick();
    return { app, state: vm.$.setupState };
  };

  for (const [role, user, admin] of [['preview', null, false], ['administrator', self, true], ['member', self, false]] as const) {
    await t.test(`${role} can select all, another person, or a person without schedules`, async () => {
      session = { user, admin };
      const { app, state } = await mount();
      try {
        assert.equal(state.personFilter, '');
        assert.equal(state.byDate.get('2026-11-02').length, 2);
        assert.equal(state.byDate.get('2026-11-03').length, 2);
        const identity = state.currentUser;
        const before = requests.length;
        state.personFilter = other.id; await flush();
        assert.deepEqual([...state.byDate.values()].flat().map((entry: Schedule) => entry.userId), [other.id, other.id]);
        assert.deepEqual(state.detailByDate.get('2026-11-02').map((group: { type: string }) => group.type), ['work']);
        assert.deepEqual(state.detailByDate.get('2026-11-03').map((group: { type: string }) => group.type), ['rest']);
        assert.equal(state.currentUser, identity);
        assert.equal(state.admin, admin);
        state.personFilter = unscheduled.id; await flush();
        assert.equal(state.byDate.size, 0);
        state.personFilter = self.id; await flush();
        assert.deepEqual([...state.byDate.values()].flat().map((entry: Schedule) => entry.userId), [self.id, self.id]);
        assert.equal(state.filterMine, role === 'member');
        state.personFilter = ''; await flush();
        assert.equal([...state.byDate.values()].flat().length, schedules.length);
        assert.equal(requests.length, before);
      } finally { app.unmount(); storage.clear(); }
    });
  }

  await t.test('saved only-mine preference restores through the dropdown and choosing another person clears it', async () => {
    session = { user: self, admin: false };
    storage.set('schedule.onlyMine', 'true');
    const first = await mount();
    try {
      assert.equal(first.state.personFilter, self.id);
      assert.equal(first.state.filterMine, true);
      first.state.personFilter = other.id; await flush();
      assert.equal(storage.get('schedule.onlyMine'), 'false');
      first.state.personFilter = self.id; await flush();
      assert.equal(storage.get('schedule.onlyMine'), 'true');
    } finally { first.app.unmount(); }
    const restored = await mount();
    try {
      assert.equal(restored.state.personFilter, self.id);
      assert.deepEqual([...restored.state.byDate.values()].flat().map((entry: Schedule) => entry.userId), [self.id, self.id]);
      session = { user: self, admin: true };
      await restored.state.refreshIdentity(); await flush();
      assert.equal(restored.state.personFilter, '');
      assert.equal(restored.state.filterMine, false);
    } finally { restored.app.unmount(); storage.clear(); }
  });

  await t.test('rename preserves the selected ID and a missing user resets selection to all', async () => {
    session = { user: null, admin: false };
    const { app, state } = await mount();
    try {
      state.personFilter = other.id; await flush();
      remote = { ...remote, users: users.map(user => user.id === other.id ? { ...user, displayName: '赵六' } : user) };
      await state.loadMonth(); await flush();
      assert.equal(state.personFilter, other.id);
      assert.equal(state.userMap.get(other.id).displayName, '赵六');
      assert.equal([...state.byDate.values()].flat().length, 2);
      remote = { ...remote, users: users.filter(user => user.id !== other.id), schedules: schedules.filter(entry => entry.userId !== other.id) };
      await state.loadMonth(); await flush();
      assert.equal(state.personFilter, '');
      assert.deepEqual([...state.byDate.values()].flat().map((entry: Schedule) => entry.userId), [self.id, self.id]);
    } finally { app.unmount(); storage.clear(); }
  });

  await t.test('date details follow the selected person while edit permissions still use the signed-in identity', async () => {
    for (const [user, admin] of [[null, false], [self, false], [self, true]] as const) {
      const app = renderer.createApp({ ...Dialog, render: () => null }, { date: '2026-11-02', users, schedules, currentUser: user, admin, onlyMine: false, filterUserId: other.id });
      app.provide(ssrContextKey, {});
      const vm = app.mount({});
      await flush();
      const state = vm.$.setupState;
      try {
        assert.deepEqual(state.entries.map((entry: Schedule) => entry.userId), [other.id]);
        assert.equal(state.workingEntries.length, 1);
        state.startEdit(other.id);
        assert.equal(state.editing, admin);
        assert.equal(vm.$.props.currentUser, user);
        state.editing = false;
        vm.$.props.date = '2026-11-03'; await flush();
        assert.equal(state.workingEntries.length, 0);
        assert.deepEqual(state.restEntries.map((entry: Schedule) => entry.userId), [other.id]);
        vm.$.props.filterUserId = unscheduled.id; await flush();
        assert.equal(state.entries.length, 0);
        vm.$.props.filterUserId = ''; await flush();
        assert.equal(state.restEntries.length, 2);
      } finally { app.unmount(); }
    }
  });
  assert.ok(requests.every(request => request.method === 'GET'));
});
