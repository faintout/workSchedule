import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import { shanghaiToday } from '../web/calendar.js';
import viteConfig from '../vite.config.js';

test('client always renders grouped details while visible-page synchronization uses administrator settings', async t => {
  const vite = await createServer({
    ...viteConfig, configFile: false, root: fileURLToPath(new URL('../', import.meta.url)), logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, open: false },
  });
  t.after(() => vite.close());
  const App = (await vite.ssrLoadModule('/web/App.vue')).default;
  const storage = new Map<string, string>();
  const listeners = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const requests: string[] = [];
  const storageReads: string[] = [];
  const settingsPayloads: Record<string, unknown>[] = [];
  let nextTimer = 0;
  let failSave = false;
  let finishMount: (() => void) | undefined;
  const users = ['张三', '李四'].map((displayName, index) => ({ id: `person-${index}`, displayName, originalName: displayName, registrationSequence: index + 1, colorIndex: index, color: '#20B5DF', deletedAt: null }));
  const date = shanghaiToday().slice(0, 7) + '-07';
  let remote = { users, schedules: [
    { userId: users[0].id, date, normalShift: 'full', overtime: true, version: 1 },
    { userId: users[1].id, date, normalShift: 'rest', overtime: false, version: 2 },
  ], holidays: [], holidayStatus: 'ready', homeTitle: '团队排班', defaultDisplayMode: 'normal', syncIntervalMinutes: 0.5 };
  let session: { user: typeof users[number] | null; admin: boolean } = { user: null, admin: false };
  const browserDocument = { visibilityState: 'visible', addEventListener(name: string, callback: () => void) { listeners.set(name, callback); if (name === 'visibilitychange') finishMount?.(); }, removeEventListener: (name: string) => listeners.delete(name) };
  const globals = {
    localStorage: { getItem(key: string) { storageReads.push(key); return storage.get(key) ?? null; }, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    window: { innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    location: { pathname: '/' }, document: browserDocument,
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name); });
  }
  t.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => {
    requests.push(input);
    if (input === '/api/session') return Response.json(session);
    if (input === '/api/admin/settings') {
      if (failSave) return Response.json({ message: '保存失败' }, { status: 400 });
      const settings = JSON.parse(String(options?.body));
      settingsPayloads.push(settings);
      remote = { ...remote, ...settings };
      return Response.json(settings);
    }
    return Response.json(remote);
  });
  t.mock.method(globalThis, 'setInterval', (callback: () => void, milliseconds: number) => { timers.set(++nextTimer, { callback, milliseconds }); return nextTimer; });
  t.mock.method(globalThis, 'clearInterval', (id: number) => timers.delete(id));
  const renderer = createRenderer({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  const mount = async () => {
    const ready = new Promise<void>(resolve => { finishMount = resolve; });
    // Mount the real setup and lifecycle without requiring a browser DOM.
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

  await t.test('preview, member and admin render both groups despite old display preferences', async () => {
    for (const [user, admin, mode, style] of [[null, false, 'false', 'horizontal'], [users[0], false, 'true', 'vertical'], [users[0], true, 'true', 'horizontal']] as const) {
      session = { user, admin };
      storage.set('schedule.detailMode', mode); storage.set('schedule.detailStyle', style);
      storageReads.length = 0;
      const { app, state, render } = await mount();
      try {
        const html = render();
        assert.match(html, /class="day-group-label">上班/);
        assert.match(html, /class="day-group-label">休息/);
        assert.equal((html.match(/class="detail-person"/g) ?? []).length, 2);
        assert.match(html, /aria-label="查看人员"/);
        assert.doesNotMatch(html, /展示方式|display-mode|horizontal-details|class="avatars"|class="extra"/);
        assert.equal(storageReads.includes('schedule.detailMode'), false);
        assert.equal(storageReads.includes('schedule.detailStyle'), false);
        assert.equal(timers.size, 1);
        assert.equal([...timers.values()][0].milliseconds, 30_000);
        if (admin) {
          await state.changeTab('settings');
          const settingsHtml = render();
          assert.match(settingsHtml, /自动同步间隔/);
          assert.doesNotMatch(settingsHtml, /默认展示方式|display-mode/);
        }
      } finally { app.unmount(); storage.clear(); }
    }
    session = { user: null, admin: false };
  });

  await t.test('decimal interval replaces one timer, hidden pages skip requests, and foreground refreshes immediately', async () => {
    const { app, state } = await mount();
    try {
      const originalTimer = nextTimer;
      remote = { ...remote, syncIntervalMinutes: 1.25 };
      await state.loadMonth(); await flush();
      assert.equal(timers.size, 1);
      assert.equal(timers.has(originalTimer), false);
      assert.equal([...timers.values()][0].milliseconds, 75_000);
      const unchangedTimer = nextTimer;
      await state.loadMonth(); await flush();
      assert.equal(nextTimer, unchangedTimer);
      const before = requests.length;
      browserDocument.visibilityState = 'hidden';
      [...timers.values()][0].callback(); await flush();
      assert.equal(requests.length, before);
      browserDocument.visibilityState = 'visible';
      [...timers.values()][0].callback(); await flush();
      assert.deepEqual(requests.slice(before), ['/api/session', '/api/month?month=' + state.month]);
      const beforeForeground = requests.length;
      listeners.get('visibilitychange')!(); await flush();
      assert.deepEqual(requests.slice(beforeForeground), ['/api/session', '/api/month?month=' + state.month]);
    } finally { app.unmount(); }
    assert.equal(timers.size, 0);
    assert.equal(listeners.has('visibilitychange'), false);
  });

  await t.test('settings drafts and failed saves do not change behavior; successful saves apply immediately', async () => {
    session = { user: users[0], admin: true };
    const { app, state } = await mount();
    try {
      await state.changeTab('settings');
      const oldTitle = state.data.homeTitle;
      const oldTimer = nextTimer;
      state.homeTitle = '新的团队标题'; state.syncIntervalMinutes = 0.75;
      await flush();
      assert.equal(state.data.homeTitle, oldTitle);
      assert.equal(nextTimer, oldTimer);
      failSave = true;
      await state.saveSettings(); await flush();
      assert.equal(state.data.homeTitle, oldTitle);
      assert.equal(nextTimer, oldTimer);
      failSave = false;
      await state.saveSettings(); await flush();
      assert.equal(state.data.homeTitle, '新的团队标题');
      assert.equal(timers.size, 1);
      assert.equal([...timers.values()][0].milliseconds, 45_000);
      assert.deepEqual(settingsPayloads.at(-1), { homeTitle: '新的团队标题', syncIntervalMinutes: 0.75 });
    } finally { app.unmount(); storage.clear(); }
  });
});
