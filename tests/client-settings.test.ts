import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createRenderer, nextTick, ssrContextKey } from 'vue';
import viteConfig from '../vite.config.js';

test('client display preferences and visible-page synchronization use saved administrator settings', async t => {
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
  let nextTimer = 0;
  let failSave = false;
  let finishMount: (() => void) | undefined;
  let remote = { users: [], schedules: [], holidays: [], holidayStatus: 'ready', homeTitle: '团队排班', defaultDisplayMode: 'normal', syncIntervalMinutes: 0.5 };
  const browserDocument = { visibilityState: 'visible', addEventListener(name: string, callback: () => void) { listeners.set(name, callback); if (name === 'visibilitychange') finishMount?.(); }, removeEventListener: (name: string) => listeners.delete(name) };
  const globals = {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
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
    if (input === '/api/session') return Response.json({ user: null, admin: false });
    if (input === '/api/admin/settings') {
      if (failSave) return Response.json({ message: '保存失败' }, { status: 400 });
      const settings = JSON.parse(String(options?.body));
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
    return { app, state: vm.$.setupState };
  };

  await t.test('unset preference follows changed server defaults without creating a personal preference', async () => {
    const { app, state } = await mount();
    try {
      assert.equal(state.displayMode, 'normal');
      assert.equal(timers.size, 1);
      assert.equal([...timers.values()][0].milliseconds, 30_000);
      remote = { ...remote, defaultDisplayMode: 'horizontal' };
      await state.loadMonth(); await flush();
      assert.equal(state.displayMode, 'horizontal');
      remote = { ...remote, defaultDisplayMode: 'vertical' };
      await state.loadMonth(); await flush();
      assert.equal(state.displayMode, 'vertical');
      remote = { ...remote, defaultDisplayMode: 'grouped' };
      await state.loadMonth(); await flush();
      assert.equal(state.displayMode, 'grouped');
      assert.equal(storage.size, 0);
      state.displayMode = 'vertical';
      assert.equal(storage.get('schedule.detailMode'), 'true');
      assert.equal(storage.get('schedule.detailStyle'), 'vertical');
    } finally { app.unmount(); storage.clear(); }
  });

  await t.test('explicit normal choice overrides administrator detail mode and survives remount', async () => {
    const first = await mount();
    try {
      first.state.displayMode = 'normal';
      await flush();
      assert.equal(storage.get('schedule.detailMode'), 'false');
    } finally { first.app.unmount(); }
    const restored = await mount();
    try { assert.equal(restored.state.displayMode, 'normal'); }
    finally { restored.app.unmount(); storage.clear(); }
  });

  await t.test('legacy normal and detail preferences retain their original meaning', async () => {
    for (const [mode, style, expected] of [['false', null, 'normal'], ['true', 'vertical', 'vertical'], ['true', null, 'horizontal']]) {
      storage.set('schedule.detailMode', mode!);
      if (style) storage.set('schedule.detailStyle', style);
      const { app, state } = await mount();
      try { assert.equal(state.displayMode, expected); }
      finally { app.unmount(); storage.clear(); }
    }
  });

  await t.test('grouped display is remembered and overrides changed administrator defaults', async () => {
    const first = await mount();
    try {
      first.state.displayMode = 'grouped';
      await flush();
      assert.equal(storage.get('schedule.detailMode'), 'true');
      assert.equal(storage.get('schedule.detailStyle'), 'grouped');
      remote = { ...remote, defaultDisplayMode: 'normal' };
      await first.state.loadMonth(); await flush();
      assert.equal(first.state.displayMode, 'grouped');
    } finally { first.app.unmount(); }
    const restored = await mount();
    try { assert.equal(restored.state.displayMode, 'grouped'); }
    finally { restored.app.unmount(); storage.clear(); }
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
    remote = { ...remote, defaultDisplayMode: 'vertical' };
    const { app, state } = await mount();
    try {
      await state.changeTab('settings');
      const oldMode = state.displayMode;
      const oldTimer = nextTimer;
      state.defaultDisplayMode = 'normal'; state.syncIntervalMinutes = 0.75;
      await flush();
      assert.equal(state.displayMode, oldMode);
      assert.equal(nextTimer, oldTimer);
      failSave = true;
      await state.saveSettings(); await flush();
      assert.equal(state.displayMode, oldMode);
      assert.equal(nextTimer, oldTimer);
      failSave = false;
      await state.saveSettings(); await flush();
      assert.equal(state.displayMode, 'normal');
      assert.equal(timers.size, 1);
      assert.equal([...timers.values()][0].milliseconds, 45_000);
      assert.equal(storage.size, 0);
    } finally { app.unmount(); }
  });
});
