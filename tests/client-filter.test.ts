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
    const render = () => {
      const chunks: string[] = [];
      App.ssrRender(vm, (html: string) => chunks.push(html), vm.$, {}, vm.$.props, vm.$.setupState, {}, {});
      return chunks.join('');
    };
    return { app, state: vm.$.setupState, render };
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

  for (const [role, user, admin] of [['preview', null, false], ['administrator', self, true], ['member', self, false]] as const) {
    await t.test(`${role} can combine work and rest checkboxes with the person selection`, async () => {
      session = { user, admin };
      const previous = remote;
      remote = { ...remote, schedules: [...schedules,
        { userId: self.id, date: '2026-11-04', normalShift: 'none', overtime: true, version: 5 },
        { userId: other.id, date: '2026-11-04', normalShift: 'rest', overtime: false, version: 6 },
      ] };
      const { app, state, render } = await mount();
      const entries = () => [...state.byDate.values()].flat() as Schedule[];
      const checkbox = (html: string, label: string) => {
        const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)];
        const found = labels.find(match => match[1].replace(/<[^>]*>/g, '').replace(/\s/g, '') === label);
        assert.ok(found, `${role} has a ${label} label`);
        assert.match(found[1], /<input\b[^>]*type="checkbox"/);
        return found[1].match(/<input\b[^>]*>/)![0];
      };
      try {
        const identity = state.currentUser;
        const before = requests.length;
        assert.equal(state.showWork, true);
        assert.equal(state.showRest, true);
        assert.equal(entries().length, 6);
        assert.equal(state.myDates.size, user ? 3 : 0);
        assert.match(checkbox(render(), '上班'), /\bchecked\b/);
        assert.match(checkbox(render(), '休息'), /\bchecked\b/);

        state.showRest = false; await flush();
        assert.equal(entries().length, 3);
        assert.ok(entries().every(entry => entry.normalShift !== 'rest'));
        assert.equal(state.myDates.size, user ? 2 : 0);
        assert.equal(state.myDates.has('2026-11-03'), false);
        assert.equal(state.byDate.get('2026-11-04')[0].overtime, true);
        assert.match(render(), /class="day-group-label">上班/);
        assert.doesNotMatch(render(), /class="day-group-label">休息/);
        assert.doesNotMatch(checkbox(render(), '休息'), /\bchecked\b/);

        state.showWork = false; await flush();
        assert.equal(state.byDate.size, 0);
        assert.equal(state.detailByDate.size, 0);
        assert.equal(state.myDates.size, 0);
        assert.doesNotMatch(render(), /class="detail-person"|class="day-group-label"/);

        state.showRest = true; await flush();
        assert.equal(entries().length, 3);
        assert.ok(entries().every(entry => entry.normalShift === 'rest'));
        assert.deepEqual([...state.myDates.keys()], user ? ['2026-11-03'] : []);
        assert.doesNotMatch(render(), /class="day-group-label">上班/);
        assert.match(render(), /class="day-group-label">休息/);
        assert.doesNotMatch(checkbox(render(), '上班'), /\bchecked\b/);
        state.personFilter = other.id; await flush();
        assert.equal(entries().length, 2);
        assert.ok(entries().every(entry => entry.userId === other.id && entry.normalShift === 'rest'));
        assert.deepEqual([...state.myDates.keys()], user ? ['2026-11-03'] : [], 'person filtering preserves the signed-in user highlight');

        state.showWork = true; await flush();
        assert.equal(entries().length, 3);
        assert.ok(entries().every(entry => entry.userId === other.id));
        state.personFilter = ''; await flush();
        assert.equal(entries().length, 6);
        assert.equal(state.currentUser, identity);
        assert.equal(state.admin, admin);
        assert.equal(requests.length, before);
      } finally { app.unmount(); storage.clear(); remote = previous; }
    });
  }

  await t.test('status preferences survive remounts, role changes and month loads in the same browser', async () => {
    storage.clear();
    session = { user: null, admin: false };
    const first = await mount();
    try {
      assert.deepEqual([first.state.showWork, first.state.showRest], [true, true], 'first visit shows both statuses');
    } finally { first.app.unmount(); }
    try {
      for (const [showWork, showRest] of [[true, true], [true, false], [false, true], [false, false]] as const) {
        session = { user: null, admin: false };
        const selected = await mount();
        try {
          selected.state.showWork = !showWork; selected.state.showRest = !showRest; await flush();
          selected.state.showWork = showWork; selected.state.showRest = showRest; await flush();
        } finally { selected.app.unmount(); }
        for (const [user, admin] of [[null, false], [self, false], [self, true]] as const) {
          session = { user, admin };
          const restored = await mount();
          const expectSelection = () => {
            assert.deepEqual([restored.state.showWork, restored.state.showRest], [showWork, showRest]);
            const entries = [...restored.state.byDate.values()].flat() as Schedule[];
            assert.equal(entries.length, (showWork ? 2 : 0) + (showRest ? 2 : 0));
            assert.ok(entries.every(entry => entry.normalShift === 'rest' ? showRest : showWork));
          };
          try {
            expectSelection();
            await restored.state.loadMonth('2026-12'); await flush();
            assert.equal(restored.state.month, '2026-12');
            expectSelection();
            session = admin ? { user: null, admin: false } : { user: self, admin: true };
            await restored.state.refreshIdentity(); await flush();
            assert.equal(restored.state.admin, session.admin);
            expectSelection();
          } finally { restored.app.unmount(); }
        }
      }
    } finally { storage.clear(); session = { user: null, admin: false }; }
  });

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

  await t.test('date details respect status selection and can still edit a hidden existing schedule', async () => {
    const date = '2026-11-04';
    const daySchedules: Schedule[] = [
      { userId: self.id, date, normalShift: 'full', overtime: true, version: 7 },
      { userId: other.id, date, normalShift: 'rest', overtime: false, version: 8 },
      { userId: unscheduled.id, date, normalShift: 'none', overtime: true, version: 9 },
    ];
    for (const [user, admin] of [[null, false], [self, false], [self, true]] as const) {
      const app = renderer.createApp({ ...Dialog, render: () => null }, { date, users, schedules: daySchedules, currentUser: user, admin, onlyMine: false, filterUserId: '' });
      app.provide(ssrContextKey, {});
      const vm = app.mount({});
      await flush();
      const state = vm.$.setupState;
      try {
        assert.equal(state.entries.length, 3, 'omitted status props default to both selected');
        vm.$.props.showWork = false; await flush();
        assert.equal(state.workingEntries.length, 0);
        assert.deepEqual(state.restEntries.map((entry: Schedule) => entry.userId), [other.id]);
        assert.deepEqual(state.detailUsers.map((user: User) => user.id), [other.id]);
        state.startEdit(self.id); await flush();
        assert.equal(state.editing, !!user || admin);
        if (state.editing) {
          assert.equal(state.original.version, 7);
          assert.deepEqual([...state.checks], [true, true, true, false]);
          state.editing = false; await flush();
        }
        vm.$.props.showRest = false; await flush();
        assert.equal(state.entries.length, 0);
        vm.$.props.showWork = true; await flush();
        assert.deepEqual(state.workingEntries.map((entry: Schedule) => entry.userId), [self.id, unscheduled.id]);
        assert.equal(state.restEntries.length, 0);
        state.startEdit(other.id); await flush();
        assert.equal(state.editing, admin);
        if (admin) {
          assert.equal(state.original.version, 8);
          assert.deepEqual([...state.checks], [false, false, false, true]);
        }
      } finally { app.unmount(); }
    }
  });
  assert.ok(requests.every(request => request.method === 'GET'));
});
