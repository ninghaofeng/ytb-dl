import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cookies, chromeCache, chromeAuthenticationExpired } from '../src/main/cookies';
import { Store } from '../src/main/store';
import { Formats } from '../src/main/formats';
import { Engine } from '../src/main/engine';
import { run } from '../src/main/process';
import type { Tools } from '../src/main/arguments';

const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
const options = { kind: 'video', container: 'original', height: 0, cookie: 'chrome', selection: { video: 'v1', audio: 'a1' } } as const;
function jar(value: string, expires: number | string = 0): string {
  return `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t${expires}\tTEST\t${value}\n`;
}
async function settled(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Operation did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function context(failure?: (url: string, args: string[], text: string) => string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-chrome-cache-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  store.state.settings.chromeAuthorized = true; store.save();
  const clock = { now: Date.now() };
  const calls = { chrome: 0, sites: [] as string[][], failAt: 0, hangAt: 0, expires: '0' };
  const launch: typeof run = (_exe, args, onLine, cwd, input) => {
    if (args.includes('--list-impersonate-targets')) {
      calls.chrome++;
      if (calls.chrome === calls.hangAt) return run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], onLine, cwd);
      if (calls.chrome === calls.failAt) return run(process.execPath, ['-e', 'console.error("ERROR: Chrome keychain locked");process.exit(1)'], onLine, cwd);
      return run(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2])',
        args[args.indexOf('--cookies') + 1]!, jar(`version-${calls.chrome}`, calls.expires)], onLine, cwd);
    }
    calls.sites.push(args);
    const url = input ? JSON.parse(input).original_url : args.at(-1);
    const text = args.includes('--cookies') ? readFileSync(args[args.indexOf('--cookies') + 1]!, 'utf8') : '';
    const error = failure?.(url || '', args, text);
    if (error) {
      const partial = args.includes('--flat-playlist') ? 'console.log(JSON.stringify({id:"partial",url:"https://youtube.com/watch?v=partial",title:"partial"}));' : '';
      return run(process.execPath, ['-e', `${partial}console.error(process.argv[1]);process.exit(1)`, error], onLine, cwd);
    }
    return run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd, input);
  };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch, () => clock.now);
  await cookies.init();
  return { root, store, clock, calls, launch, cookies, async close() { await cookies.stop(); await rm(root, { recursive: true, force: true }); } };
}
test('cache uses cookie expiry, caps sessions at six hours and removes already-expired entries', () => {
  const now = 1_800_000_000_000;
  assert.equal(chromeCache('Default', jar('session'), now).expiresAt, now + 6 * 3600_000);
  assert.equal(chromeCache('Default', jar('persistent', now / 1000 + 60), now).expiresAt, now + 60_000);
  const mixed = jar('expired', now / 1000 - 1) + jar('session').split('\n').slice(1).join('\n');
  const cache = chromeCache('Default', mixed, now);
  assert.ok(!cache.text.includes('expired'));
  assert.ok(cache.text.includes('session'));
  assert.throws(() => chromeCache('Default', jar('expired', now / 1000), now), /均已过期/);
  assert.throws(() => chromeCache('Default', jar('bad', 1e30), now));
});
test('Chromium microseconds since 1601 are normalized to Unix seconds without rounding cookie expiry', () => {
  const now = 1_800_000_000_000;
  const future = BigInt(now / 1000 + 3600);
  const chromium = (future + 11_644_473_600n) * 1_000_000n + 123_456n;
  const cache = chromeCache('Default', jar('browser', chromium.toString()), now);
  assert.equal(cache.expiresAt, Number(future) * 1000);
  assert.equal(cache.text, jar('browser', future.toString()));
  assert.equal(chromeCache('Default', cache.text, now).expiresAt, cache.expiresAt, 'persisted cache must not be converted twice');
  const expired = (BigInt(now / 1000 - 1) + 11_644_473_600n) * 1_000_000n;
  assert.throws(() => chromeCache('Default', jar('expired', expired.toString()), now), /均已过期/);
  assert.equal(chromeCache('Default', jar('far-future', '253402300799'), now).text, jar('far-future', '253402300799'));
  assert.throws(() => chromeCache('Default', jar('invalid', '9'.repeat(30)), now), /到期时间无效/);
});
test('inspection accepts raw Chromium expiry, persists normalized cookies and does not misreport timestamp errors as keychain failures', async () => {
  const h = await context();
  const formats = new Formats(() => tools, h.cookies, () => '', () => {}, () => false, h.launch);
  try {
    const future = BigInt(Math.floor(h.clock.now / 1000) + 3600);
    h.calls.expires = ((future + 11_644_473_600n) * 1_000_000n).toString();
    const result = await formats.inspect('https://youtube.com/watch?v=expiry-regression', 'chrome');
    assert.ok(result.formats.length);
    assert.equal(h.cookies.info.chromeError, '');
    assert.equal(Date.parse(h.cookies.info.chromeCacheExpiresAt), Number(future) * 1000);
    const persisted = JSON.parse(await readFile(path.join(h.cookies.root, 'chrome-cache.json'), 'utf8'));
    assert.equal(persisted.text, jar('version-1', future.toString()));
    h.calls.expires = '9'.repeat(30);
    await assert.rejects(h.cookies.sync('chrome'), error => {
      assert.match(String(error), /到期时间无效/);
      assert.doesNotMatch(String(error), /钥匙串|Windows 加密|手动导入/);
      return true;
    });
  } finally { await formats.cancel(); await h.close(); }
});
const bundledYt = path.resolve('resources', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, `yt-dlp${process.platform === 'win32' ? '.exe' : ''}`);
test('bundled yt-dlp loads normalized Chromium cookie timestamps without reading a browser or contacting a platform', { skip: !existsSync(bundledYt), timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-cookie-expiry-'));
  try {
    const now = Date.now(), future = BigInt(Math.floor(now / 1000) + 3600);
    const chromium = (future + 11_644_473_600n) * 1_000_000n;
    const filename = path.join(root, 'synthetic.txt');
    await writeFile(filename, jar('synthetic-only', chromium.toString()), { mode: 0o600 });
    const args = ['--ignore-config', '--no-plugin-dirs', '--proxy', '', '--cookies', filename, '--list-impersonate-targets'];
    await run(bundledYt, args).done;
    const cache = chromeCache('Default', await readFile(filename, 'utf8'), now);
    assert.equal(cache.expiresAt, Number(future) * 1000);
    await writeFile(filename, cache.text, { mode: 0o600 });
    await run(bundledYt, args).done;
    assert.equal(chromeCache('Default', await readFile(filename, 'utf8'), now).expiresAt, cache.expiresAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('explicit login errors refresh, but bot, age, access and network failures do not', () => {
  for (const error of ['Login required', 'You need to log in', 'Please sign in', 'The provided YouTube account cookies are no longer valid', 'Session expired', 'Authentication is required']) {
    assert.equal(chromeAuthenticationExpired(new Error(error)), true, error);
  }
  for (const error of ['Sign in to confirm you’re not a bot', 'Please sign in to confirm you are not a robot', 'Please log in to complete human verification', 'Login required: CAPTCHA', 'Sign in to confirm your age', 'Login required for age-restricted video', 'Private video', 'HTTP Error 403', 'HTTP Error 429', 'read ETIMEDOUT', 'This video is members-only', 'Proxy authentication required', 'HTTP Error 407: Authentication required']) {
    assert.equal(chromeAuthenticationExpired(new Error(error)), false, error);
  }
});
test('parallel snapshots read Chrome once, preserve private permissions and do not extend expiry', async () => {
  const h = await context();
  try {
    const files = await Promise.all(Array.from({ length: 5 }, () => h.cookies.snapshot('chrome', randomUUID())));
    assert.equal(h.calls.chrome, 1);
    assert.equal(new Set(files).size, 5);
    const expiry = h.cookies.info.chromeCacheExpiresAt;
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(h.cookies.root, 'chrome-cache.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(h.cookies.root)).mode & 0o777, 0o700);
    }
    h.clock.now += 6 * 3600_000 - 1;
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    assert.equal(h.calls.chrome, 1);
    assert.equal(h.cookies.info.chromeCacheExpiresAt, expiry);
    h.clock.now += 2;
    await h.cookies.withSnapshot('chrome', randomUUID(), async file => { assert.match(await readFile(file, 'utf8'), /version-2/); });
    assert.equal(h.calls.chrome, 2);
    assert.match(await readFile(files[0]!, 'utf8'), /version-1/, 'running snapshots remain immutable');
    for (const file of files) await h.cookies.removeSnapshot(file);
    assert.deepEqual(await readdir(h.cookies.root), ['chrome-cache.json']);
  } finally { await h.close(); }
});
test('cache survives restart and manual refresh forces a new extraction', async () => {
  const h = await context();
  let restored: Cookies | undefined;
  try {
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    const expiry = h.cookies.info.chromeCacheExpiresAt;
    await h.cookies.stop();
    const store = new Store(h.store.root, h.store.state.settings.directory);
    restored = new Cookies(store, () => tools.yt, () => {}, h.launch, () => h.clock.now);
    await restored.init();
    assert.equal(restored.info.chromeCacheExpiresAt, expiry);
    await restored.withSnapshot('chrome', randomUUID(), async () => {});
    assert.equal(h.calls.chrome, 1);
    await restored.sync('chrome');
    assert.equal(h.calls.chrome, 2);
    await restored.revoke();
    assert.deepEqual(await readdir(restored.root), []);
    await assert.rejects(restored.snapshot('chrome', randomUUID()), /授权/);
  } finally { await restored?.stop(); await h.close(); }
});
test('switching profiles clears cache while reauthorizing the same profile retains it', async () => {
  const h = await context();
  try {
    h.cookies.profiles = async () => ['Default', 'Profile 1'];
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    await h.cookies.authorize('Default');
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    assert.equal(h.calls.chrome, 1);
    await assert.rejects(h.cookies.withSnapshot('chrome', randomUUID(), async () => {
      await h.cookies.authorize('Profile 1');
      throw new Error('Login required');
    }), /Login required/);
    assert.equal(h.calls.chrome, 1, 'a running operation must not retry under a newly selected profile');
    assert.deepEqual(await readdir(h.cookies.root), []);
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    assert.equal(h.calls.chrome, 2);
    assert.equal(JSON.parse(await readFile(path.join(h.cookies.root, 'chrome-cache.json'), 'utf8')).profile, 'Profile 1');
  } finally { await h.close(); }
});
test('late failures of the old cache reuse the newer cache without causing a third Chrome read', async () => {
  const h = await context();
  let both!: () => void, refreshed!: () => void;
  const ready = new Promise<void>(resolve => { both = resolve; });
  const fresh = new Promise<void>(resolve => { refreshed = resolve; });
  let arrived = 0;
  try {
    const work = (late: boolean) => h.cookies.withSnapshot('chrome', randomUUID(), async file => {
      const text = await readFile(file, 'utf8');
      if (text.includes('version-1')) {
        if (++arrived === 2) both();
        await ready;
        if (late) await fresh;
        throw new Error('Login required');
      }
      refreshed();
      return text;
    });
    const results = await Promise.all([work(false), work(true)]);
    assert.ok(results.every(text => text.includes('version-2')));
    assert.equal(h.calls.chrome, 2);
    assert.deepEqual(await readdir(h.cookies.root), ['chrome-cache.json']);
  } finally { await h.close(); }
});
test('authentication retry is bounded, refresh failure never reuses old cookies, and cancellation prevents retry', async () => {
  const h = await context();
  try {
    let attempts = 0;
    await assert.rejects(h.cookies.withSnapshot('chrome', randomUUID(), async () => { attempts++; throw new Error('Session expired'); }), /自动刷新.*一次/);
    assert.equal(attempts, 2);
    assert.equal(h.calls.chrome, 2);
    assert.deepEqual(await readdir(h.cookies.root), []);
    await h.cookies.withSnapshot('chrome', randomUUID(), async () => {});
    h.calls.failAt = h.calls.chrome + 1;
    await assert.rejects(h.cookies.withSnapshot('chrome', randomUUID(), async () => { throw new Error('Login required'); }), /keychain locked/);
    assert.deepEqual(await readdir(h.cookies.root), []);
    const id = randomUUID(), before = h.calls.chrome;
    await assert.rejects(h.cookies.withSnapshot('chrome', id, async () => {
      await h.cookies.cancelSnapshot(id);
      throw new Error('Login required');
    }), /Login required/);
    assert.equal(h.calls.chrome, before + 1);
  } finally { await h.close(); }
});
test('corrupt persisted cache is removed with a non-sensitive error and can be rebuilt', async () => {
  const h = await context();
  let restored: Cookies | undefined;
  try {
    await writeFile(path.join(h.cookies.root, 'chrome-cache.json'), '{"text":"private-fake" broken}');
    restored = new Cookies(h.store, () => tools.yt, () => {}, h.launch, () => h.clock.now);
    await restored.init();
    assert.match(restored.info.chromeError, /缓存无效/);
    assert.ok(!restored.info.chromeError.includes('private-fake'));
    assert.deepEqual(await readdir(h.cookies.root), []);
    await restored.withSnapshot('chrome', randomUUID(), async () => {});
    assert.equal(restored.info.chromeError, '');
  } finally { await restored?.stop(); await h.close(); }
});
test('format inspection, subtitle metadata, downloads and playlists share the cache and bounded refresh', async () => {
  const h = await context((url, args, text) => {
    const stale = url.includes('inspect-login') ? 'version-1' : url.includes('download-login') ? 'version-2' : url.includes('transfer-login') ? 'version-3' : url.includes('playlist-login') ? 'version-4' : '';
    return stale && text.includes(stale) ? 'ERROR: Login required' : '';
  });
  const formats = new Formats(() => tools, h.cookies, () => '', () => {}, () => false, h.launch);
  const engine = new Engine(h.store, () => tools, h.cookies, () => '', () => {}, h.launch);
  try {
    await formats.inspect('https://youtube.com/watch?v=inspect-login', 'chrome');
    assert.equal(h.calls.chrome, 2);
    engine.enqueue(['https://youtube.com/watch?v=download-login'], { ...options, subtitles: [{ language: 'en', source: 'manual' }] });
    await settled(() => ['completed', 'failed'].includes(h.store.state.tasks[0]!.status));
    assert.equal(h.store.state.tasks[0]!.status, 'completed', h.store.state.tasks[0]!.error);
    assert.equal(h.calls.chrome, 3);
    engine.enqueue(['https://youtube.com/watch?v=transfer-login'], options);
    await settled(() => ['completed', 'failed'].includes(h.store.state.tasks[1]!.status));
    assert.equal(h.store.state.tasks[1]!.status, 'completed', h.store.state.tasks[1]!.error);
    assert.equal(h.calls.chrome, 4);
    engine.parse('https://youtube.com/playlist?list=playlist-login', 'chrome');
    await settled(() => engine.playlist?.status !== 'running');
    assert.equal(engine.playlist!.status, 'completed', engine.playlist!.error);
    assert.equal(engine.entries.length, 2, 'partial first attempt must not be duplicated');
    assert.equal(h.calls.chrome, 5);
    assert.deepEqual(await readdir(h.cookies.root), ['chrome-cache.json']);
  } finally { await formats.cancel(); await engine.stop(); await h.close(); }
});
test('network/verification errors and manually imported cookies never trigger Chrome refresh', async () => {
  const h = await context(url => url.includes('bot-check') ? 'ERROR: Sign in to confirm you are not a bot' : '');
  const formats = new Formats(() => tools, h.cookies, () => '', () => {}, () => false, h.launch);
  try {
    await assert.rejects(formats.inspect('https://youtube.com/watch?v=bot-check', 'chrome'), /not a bot/);
    assert.equal(h.calls.chrome, 1);
    let attempts = 0;
    await assert.rejects(h.cookies.withSnapshot('chrome', randomUUID(), async () => { attempts++; throw new Error('read ETIMEDOUT'); }), /ETIMEDOUT/);
    assert.equal(attempts, 1); assert.equal(h.calls.chrome, 1);
    const source = path.join(h.root, 'manual.txt'); await writeFile(source, jar('imported')); await h.cookies.importFile(source, false);
    await assert.rejects(h.cookies.withSnapshot('file', randomUUID(), async () => { throw new Error('Login required'); }), /Login required/);
    assert.equal(h.calls.chrome, 1);
  } finally { await formats.cancel(); await h.close(); }
});
test('automatic refresh retains inspection timeout and cancellation cleanup', async () => {
  const h = await context(() => 'ERROR: Login required');
  h.calls.hangAt = 2;
  const formats = new Formats(() => tools, h.cookies, () => '', () => {}, () => false, h.launch, { cookies: 500, proxy: 100, metadata: 1000 });
  try {
    await assert.rejects(formats.inspect('https://youtube.com/watch?v=refresh-timeout', 'chrome'), /同步 Cookie 超时/);
    assert.equal(h.calls.chrome, 2);
    assert.equal(h.cookies.busy, false);
    assert.equal(formats.busy, false);
    assert.deepEqual(await readdir(h.cookies.root), []);
  } finally { await formats.cancel(); await h.close(); }
});
