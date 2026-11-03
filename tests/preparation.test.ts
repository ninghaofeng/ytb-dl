import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cookies } from '../src/main/cookies';
import { Engine } from '../src/main/engine';
import { Formats } from '../src/main/formats';
import { inspectionLifetime, type InspectedSource } from '../src/main/metadata';
import { run } from '../src/main/process';
import { Store } from '../src/main/store';
import type { Tools } from '../src/main/arguments';
import type { CookieMode, PreparationProgress } from '../src/shared/types';

const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
const preset = { kind: 'video', container: 'original', height: 0, cookie: 'none', selection: { video: 'v1', audio: 'a1' }, mergeFormat: 'mkv', subtitles: [{ language: 'en', source: 'manual' }], embedChapters: false } as const;
const jar = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tTEST\tfake-value\n';
async function until(predicate: () => boolean, timeout = 7000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Preparation did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function context(limits = { cookies: 4000, proxy: 4000, subtitles: 4000, starting: 4000 }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-preparation-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  const calls: { args: string[]; input?: string }[] = [];
  const behavior = { hang: '' as '' | 'subtitles' | 'starting', proxy: '', rejectTransfer: false };
  let resolveProxy: (url: string) => string | Promise<string> = () => behavior.proxy;
  const launch: typeof run = (_exe, args, onLine, cwd, input) => {
    calls.push({ args, input });
    const transfer = !args.includes('--dump-json') && !args.includes('-show_chapters') && !args.includes('--list-impersonate-targets');
    if ((behavior.hang === 'subtitles' && args.includes('--dump-json')) || (behavior.hang === 'starting' && transfer)) {
      return run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], onLine, cwd);
    }
    if (behavior.rejectTransfer && transfer) {
      behavior.rejectTransfer = false;
      return run(process.execPath, ['-e', 'console.error("ERROR: Login required");process.exit(1)'], onLine, cwd);
    }
    return run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd, input);
  };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch);
  await cookies.init();
  const formats = new Formats(() => tools, cookies, url => resolveProxy(url), () => {}, () => false, launch);
  const engine = new Engine(store, () => tools, cookies, url => resolveProxy(url), () => {}, launch, limits);
  engine.paused = true;
  async function inspect(name = 'fixture', mode: CookieMode = 'none') {
    const result = await formats.inspect(`https://youtube.com/watch?v=${name}`, mode);
    const selected = formats.selection(result.id, preset.selection, [...preset.subtitles]);
    assert.doesNotMatch(JSON.stringify(result), /private\.invalid|never-render/);
    return selected.source;
  }
  function enqueue(source?: InspectedSource, mode: CookieMode = 'none', url = source?.url || 'https://youtube.com/watch?v=fixture') {
    engine.enqueue([url], { ...preset, cookie: mode, subtitles: [...preset.subtitles] }, source);
    return store.state.tasks.at(-1)!;
  }
  async function finish() {
    engine.paused = false; engine.schedule();
    await until(() => !engine.busy);
    assert.deepEqual(engine.preparations, {});
  }
  return {
    root, store, calls, cookies, formats, engine, behavior, inspect, enqueue, finish,
    setProxy(resolver: typeof resolveProxy) { resolveProxy = resolver; },
    inspections() { return calls.filter(call => call.args.includes('--dump-json')).length; },
    async close() { await formats.cancel(); await engine.stop(); await rm(root, { recursive: true, force: true }); }
  };
}
test('confirmed subtitles reuse one private inspection without persisting signed URLs or headers', async () => {
  const h = await context();
  try {
    const source = await h.inspect();
    assert.match(JSON.stringify(source.raw), /private\.invalid/);
    const task = h.enqueue(source);
    await h.finish();
    assert.equal(task.status, 'completed', task.error);
    assert.equal(h.inspections(), 1);
    assert.equal(h.calls.filter(call => call.args.includes('--load-info-json')).length, 1);
    assert.doesNotMatch(await readFile(path.join(h.store.root, 'state.json'), 'utf8'), /private\.invalid|cookieIdentity|inspectedAt|http_headers/);
    assert.doesNotMatch(JSON.stringify(h.engine.preparations), /private\.invalid/);
  } finally { await h.close(); }
});
test('stale, future-dated, cross-video, changed-Cookie and changed-proxy metadata trigger fresh inspection', async t => {
  for (const reason of ['stale', 'future', 'video', 'cookie', 'proxy'] as const) {
    await t.test(reason, async () => {
      const h = await context();
      try {
        const source = await h.inspect();
        if (reason === 'stale') source.inspectedAt -= inspectionLifetime;
        if (reason === 'future') source.inspectedAt += 60_000;
        if (reason === 'video') source.url = 'https://youtube.com/watch?v=different';
        if (reason === 'cookie') source.cookieIdentity = 'old-revision';
        if (reason === 'proxy') h.behavior.proxy = 'http://127.0.0.1:8080';
        const task = h.enqueue(source, 'none', 'https://youtube.com/watch?v=fixture');
        await h.finish();
        assert.equal(task.status, 'completed', task.error);
        assert.equal(h.inspections(), 2);
      } finally { await h.close(); }
    });
  }
});
test('changed imported Cookies and refreshed Chrome revisions invalidate inspected subtitles', async t => {
  for (const mode of ['file', 'chrome'] as const) {
    await t.test(mode, async () => {
      const h = await context();
      try {
        const filename = path.join(h.root, 'export.txt');
        if (mode === 'file') { await writeFile(filename, jar); await h.cookies.importFile(filename, false); }
        else h.cookies.info.chromeAuthorized = true;
        const source = await h.inspect('fixture', mode);
        if (mode === 'file') { await writeFile(filename, jar.replace('fake-value', 'changed-value')); await h.cookies.importFile(filename, false); }
        else await h.cookies.sync('chrome');
        const task = h.enqueue(source, mode);
        await h.finish();
        assert.equal(task.status, 'completed', task.error);
        assert.equal(h.inspections(), 2);
      } finally { await h.close(); }
    });
  }
});
test('authentication refresh cannot reuse metadata from the previous Chrome revision', async () => {
  const h = await context();
  try {
    h.cookies.info.chromeAuthorized = true;
    const source = await h.inspect('fixture', 'chrome');
    h.behavior.rejectTransfer = true;
    const task = h.enqueue(source, 'chrome');
    await h.finish();
    assert.equal(task.status, 'completed', task.error);
    assert.equal(h.inspections(), 2);
    assert.equal(h.calls.filter(call => call.args.includes('--list-impersonate-targets')).length, 2);
  } finally { await h.close(); }
});
test('only five queued results are retained; retry and restart re-inspect instead of persisting metadata', async () => {
  const h = await context();
  try {
    h.store.state.settings.concurrency = 1;
    for (let index = 0; index < 6; index++) h.enqueue(await h.inspect(`queue${index}`));
    await h.finish();
    assert.ok(h.store.state.tasks.every(task => task.status === 'completed'));
    assert.equal(h.inspections(), 7, 'oldest queued result should be evicted');
    const task = h.store.state.tasks.at(-1)!;
    task.status = 'failed'; h.engine.retry(task.id);
    await until(() => !h.engine.busy);
    assert.equal(task.status, 'completed', task.error);
    assert.equal(h.inspections(), 8);
    const source = await h.inspect('restart');
    h.engine.paused = true;
    const queued = h.enqueue(source);
    const restored = new Store(h.store.root, h.store.state.settings.directory);
    const restarted = new Engine(restored, () => tools, h.cookies, () => '', () => {}, (_exe, args, onLine, cwd, input) => {
      h.calls.push({ args, input });
      return run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd, input);
    });
    try {
      restarted.schedule(); await until(() => !restarted.busy);
      assert.equal(restored.state.tasks.find(task => task.id === queued.id)!.status, 'completed');
      assert.equal(h.inspections(), 10);
    } finally { await restarted.stop(); }
  } finally { await h.close(); }
});
test('each preparation timeout fails explicitly and clears its stage', async t => {
  const stages: PreparationProgress['stage'][] = ['cookies', 'proxy', 'subtitles', 'starting'];
  for (const stage of stages) {
    await t.test(stage, async () => {
      const h = await context({ cookies: 4000, proxy: 4000, subtitles: 4000, starting: 4000, [stage]: 150 });
      try {
        if (stage === 'cookies') { h.cookies.info.chromeAuthorized = true; h.cookies.info.chromeProfile = 'Profile 99'; }
        if (stage === 'proxy') h.setProxy(() => new Promise(() => {}));
        if (stage === 'subtitles' || stage === 'starting') h.behavior.hang = stage;
        const task = h.enqueue(undefined, stage === 'cookies' ? 'chrome' : 'none');
        await h.finish();
        assert.equal(task.status, 'failed');
        assert.match(task.error, /超时/);
        assert.equal(h.calls.filter(call => call.args.includes('--load-info-json')).length, stage === 'starting' ? 1 : 0);
        assert.ok(!(await readdir(h.cookies.root)).some(name => name.endsWith('.txt')));
      } finally { await h.close(); }
    });
  }
});
test('cancel and shutdown interrupt an unresolved proxy and never launch a late download', async t => {
  for (const action of ['cancel', 'stop'] as const) {
    await t.test(action, async () => {
      const h = await context();
      let release!: (proxy: string) => void;
      h.setProxy(() => new Promise(resolve => { release = resolve; }));
      try {
        const task = h.enqueue();
        h.engine.paused = false; h.engine.schedule();
        await until(() => h.engine.preparations[task.id]?.stage === 'proxy');
        if (action === 'cancel') await h.engine.cancel(task.id);
        else await h.engine.stop();
        await until(() => !h.engine.busy);
        assert.equal(task.status, action === 'cancel' ? 'cancelled' : 'interrupted');
        release('');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(h.calls.length, 0);
        assert.deepEqual(h.engine.preparations, {});
      } finally { await h.close(); }
    });
  }
});
test('queued Cookie acquisition can time out or cancel without waiting for another owners Chrome process', async t => {
  for (const action of ['timeout', 'cancel'] as const) {
    await t.test(action, async () => {
      const h = await context({ cookies: action === 'timeout' ? 150 : 4000, proxy: 4000, subtitles: 4000, starting: 4000 });
      h.cookies.info.chromeAuthorized = true; h.cookies.info.chromeProfile = 'Profile 99';
      const manual = h.cookies.sync('chrome');
      const stoppedManual = assert.rejects(manual, /取消|退出|终止/);
      try {
        await until(() => h.cookies.busy);
        const task = h.enqueue(undefined, 'chrome');
        h.engine.paused = false; h.engine.schedule();
        await until(() => h.engine.preparations[task.id]?.stage === 'cookies');
        if (action === 'cancel') await h.engine.cancel(task.id);
        await until(() => task.status === (action === 'cancel' ? 'cancelled' : 'failed'), 800);
        assert.equal(h.calls.length, 1, 'only the unrelated manual extraction should have started');
        assert.equal(h.cookies.busy, true, 'cancelling a queued task must not kill another owner');
        assert.deepEqual(h.engine.preparations, {});
      } finally { await h.close(); await stoppedManual; }
    });
  }
});
test('subtitle and startup cancellation stop owned processes and clear runtime phases', async t => {
  for (const phase of ['subtitles', 'starting'] as const) {
    await t.test(phase, async () => {
      const h = await context();
      try {
        h.behavior.hang = phase;
        const task = h.enqueue();
        h.engine.paused = false; h.engine.schedule();
        await until(() => h.engine.preparations[task.id]?.stage === phase && h.calls.length >= (phase === 'starting' ? 2 : 1));
        await h.engine.cancel(task.id);
        await until(() => !h.engine.busy);
        assert.equal(task.status, 'cancelled');
        assert.deepEqual(h.engine.preparations, {});
      } finally { await h.close(); }
    });
  }
});
test('startup watchdog ends on protocol output and does not limit the actual transfer', async () => {
  const h = await context({ cookies: 4000, proxy: 4000, subtitles: 4000, starting: 700 });
  try {
    const task = h.enqueue(undefined, 'none', 'https://youtube.com/watch?v=transfer-delay');
    const started = Date.now();
    await h.finish();
    assert.ok(Date.now() - started > 700);
    assert.equal(task.status, 'completed', task.error);
  } finally { await h.close(); }
});
