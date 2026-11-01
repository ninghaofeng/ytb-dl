import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { videoUrl, options, proxyUrl, redact } from '../src/main/validation';
import { Store, decodeState } from '../src/main/store';
import { Cookies, validateCookies } from '../src/main/cookies';
import { Engine } from '../src/main/engine';
import { run } from '../src/main/process';
import { formatArgs, downloadArgs, type Tools } from '../src/main/arguments';
import { assetName, verifyChecksum, verifyManifest, Updates } from '../src/main/updates';
import type { DownloadOptions, Task } from '../src/shared/types';

const fixture = path.resolve('tests/fixtures/engine.cjs');
const valid = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tTEST\tfake-value\n';
const o: DownloadOptions = { kind: 'video', container: 'original', height: 720, cookie: 'none' };
const tools: Tools = { yt: 'fake', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
const launch: typeof run = (_exe, args, onLine, cwd) => run(process.execPath, [fixture, ...args], onLine, cwd);
async function waitUntil(condition: () => boolean, timeout = 6000): Promise<void> {
  const start = Date.now();
  while (!condition()) { if (Date.now() - start > timeout) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 25)); }
}
async function context() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-test-'));
  const store = new Store(path.join(root, 'data'), path.join(root, '输出 with spaces'));
  const cookies = new Cookies(store, () => 'fake', () => {}, launch);
  await cookies.init();
  return { root, store, cookies };
}
test('official URL allowlist, share text, credentials and argument boundaries', () => {
  assert.equal(videoUrl('看看这个 https://v.douyin.com/Abcd/。'), 'https://v.douyin.com/Abcd/');
  assert.equal(videoUrl('https://www.tiktok.com/@user/video/123'), 'https://www.tiktok.com/@user/video/123');
  for (const invalid of ['file:///tmp/secret', 'https://youtube.com.evil.test/v', 'https://user:pass@youtube.com', 'https://127.0.0.1', '--exec rm']) assert.throws(() => videoUrl(invalid));
  assert.throws(() => options({ ...o, height: '720' }));
  assert.throws(() => options({ ...o, cookie: '--exec' }));
  assert.equal(proxyUrl('socks5://localhost:1080'), 'socks5://localhost:1080');
  assert.throws(() => proxyUrl('http://localhost/path'));
  const task: Task = { id: randomUUID(), url: 'https://youtube.com/watch?v=abc', directory: '/output with spaces', options: o, status: 'queued', progress: 0, speed: '', eta: '', error: '', title: '', file: '', createdAt: '' };
  const args = downloadArgs(task, tools, 'socks5://localhost:1080', '/cookie with space.txt');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), task.url);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('node:' + process.execPath));
  assert.ok(formatArgs({ ...o, kind: 'mp3' }).includes('mp3'));
  assert.match(formatArgs({ ...o, container: 'mp4' })[1]!, /avc1.*height<=720/);
});
test('cookie format validation filters unrelated domains and rejects partial/JSON data', () => {
  const additional = '.example.com\tTRUE\t/\tTRUE\t0\tunrelated\tsecret\n';
  assert.equal(validateCookies(valid + additional), valid);
  assert.throws(() => validateCookies('{"cookies":[]}'));
  assert.throws(() => validateCookies(valid + 'partial\tline'));
  assert.throws(() => validateCookies('# Netscape HTTP Cookie File\n' + additional));
  const output = redact('cookie: secret\nhttps://user:pass@host/a?token=secret\nsocks5://user:pass@host');
  assert.ok(!output.includes('secret'));
  assert.ok(!output.includes('user:pass'));
});
test('state restores interrupted only, validates corrupt state and saves a backup', async () => {
  const { root, store, cookies } = await context();
  try {
    const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch); engine.paused = true;
    engine.enqueue(['https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=b', 'https://youtube.com/watch?v=c'], o);
    store.state.tasks[0]!.status = 'downloading';
    store.state.tasks[1]!.status = 'cancelled';
    store.state.tasks[2]!.status = 'failed';
    store.save();
    const restored = new Store(store.root, store.state.settings.directory);
    assert.deepEqual(restored.state.tasks.map(t => t.status), ['queued', 'cancelled', 'failed']);
    assert.throws(() => decodeState({ ...store.state, schema: 99 }));
    await writeFile(path.join(store.root, 'state.json'), 'corrupt');
    const recovered = new Store(store.root, store.state.settings.directory);
    assert.match(recovered.warning, /备份/);
    assert.ok((await readdir(store.root)).some(f => f.includes('.corrupt')));
  } finally { await cookies.stop(); await rm(root, { recursive: true, force: true }); }
});
test('file watch handles atomic replacement, invalid/deleted files and isolated snapshots', async () => {
  const { root, cookies } = await context();
  try {
    const source = path.join(root, 'export.txt');
    await writeFile(source, valid); await cookies.importFile(source, true);
    await assert.rejects(cookies.importFile(path.join(cookies.root, 'file.txt'), true), /私密副本/);
    const snapshot = await cookies.snapshot('file', randomUUID());
    const replacement = valid.replace('fake-value', 'new-fake-value');
    await writeFile(source + '.new', replacement); await rename(source + '.new', source);
    await waitUntil(() => cookies.info.lastFileSync !== '' && cookies.info.lastFileSync !== new Date(0).toISOString() && cookies.info.file, 1000);
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(await readFile(snapshot, 'utf8'), valid);
    const updated = await cookies.snapshot('file', randomUUID());
    assert.equal(await readFile(updated, 'utf8'), replacement);
    await writeFile(source, 'half written');
    await waitUntil(() => !!cookies.info.fileError);
    await assert.rejects(cookies.snapshot('file', randomUUID()), /同步失败/);
    await writeFile(source, valid); await cookies.sync('file');
    assert.equal(cookies.info.fileError, '');
    await rm(source); await waitUntil(() => !!cookies.info.fileError);
    await cookies.clear();
    assert.equal(cookies.info.watching, false);
    assert.equal(cookies.info.file, false);
    await cookies.removeSnapshot(snapshot); await cookies.removeSnapshot(updated);
  } finally { await cookies.stop(); await rm(root, { recursive: true, force: true }); }
});
test('Chrome sync fixture respects authorization, filters and clears snapshots', async () => {
  const { root, store, cookies } = await context();
  try {
    await assert.rejects(cookies.snapshot('chrome', randomUUID()), /授权/);
    cookies.info.chromeAuthorized = true; store.state.settings.chromeAuthorized = true;
    const filename = await cookies.snapshot('chrome', randomUUID());
    assert.equal(await readFile(filename, 'utf8'), valid);
    assert.ok(cookies.info.lastChromeSync);
    await cookies.revoke();
    await assert.rejects(cookies.snapshot('chrome', randomUUID()), /授权/);
    await cookies.removeSnapshot(filename);
    assert.deepEqual(await readdir(cookies.root), []);
    cookies.info.chromeAuthorized = true;
    cookies.info.chromeProfile = 'Profile 98';
    await assert.rejects(cookies.snapshot('chrome', randomUUID()), /未完整读取/);
    assert.deepEqual(await readdir(cookies.root), []);
  } finally { await cookies.stop(); await rm(root, { recursive: true, force: true }); }
});
test('cancel during Chrome synchronization stops the extraction process', async () => {
  const { root, store, cookies } = await context();
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch);
  try {
    cookies.info.chromeAuthorized = true; cookies.info.chromeProfile = 'Profile 99';
    engine.enqueue(['https://youtube.com/watch?v=chrome-sync'], { ...o, cookie: 'chrome' });
    await waitUntil(() => cookies.busy);
    await engine.cancel(store.state.tasks[0]!.id);
    await waitUntil(() => !engine.busy);
    assert.equal(store.state.tasks[0]!.status, 'cancelled');
    assert.equal(cookies.busy, false);
    assert.deepEqual(await readdir(cookies.root), []);
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }); }
});
test('parallel scheduler enforces configured limit, dedupes and requires final media', async () => {
  const { root, store, cookies } = await context();
  let peak = 0;
  let engine: Engine;
  engine = new Engine(store, () => tools, cookies, () => '', () => {
    peak = Math.max(peak, store.state.tasks.filter(t => ['syncing', 'downloading', 'processing'].includes(t.status)).length);
  }, launch);
  try {
    store.state.settings.concurrency = 2;
    const result = engine.enqueue(['https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=b', 'https://youtube.com/watch?v=a', 'https://youtube.com/watch?v=fail', 'https://youtube.com/watch?v=missing'], o);
    assert.deepEqual(result, { added: 4, duplicates: 1 });
    await waitUntil(() => store.state.tasks.every(t => ['completed', 'failed'].includes(t.status)));
    assert.equal(peak, 2);
    assert.equal(store.state.tasks.filter(t => t.status === 'completed').length, 2);
    const failed = store.state.tasks.find(t => t.url.includes('fail'))!;
    assert.ok(!failed.error.includes('secret'));
    assert.match(store.state.tasks.find(t => t.url.includes('missing'))!.error, /有效文件/);
    const done = store.state.tasks.find(t => t.status === 'completed')!;
    assert.ok((await stat(done.file)).size);
    assert.throws(() => engine.retry(done.id));
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }); }
});
test('cancel and shutdown terminate descendants and distinguish cancelled/interrupted', async () => {
  const { root, store, cookies } = await context();
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch);
  try {
    engine.enqueue(['https://youtube.com/watch?v=slow1'], o);
    await waitUntil(() => store.state.tasks[0]!.progress === 50);
    await new Promise(r => setTimeout(r, 100));
    const files = await readdir(store.state.settings.directory);
    const marker = files.find(f => f.endsWith('.pid'))!;
    const pid = Number(await readFile(path.join(store.state.settings.directory, marker), 'utf8'));
    await engine.cancel(store.state.tasks[0]!.id);
    await waitUntil(() => !engine.busy);
    assert.equal(store.state.tasks[0]!.status, 'cancelled');
    assert.throws(() => process.kill(pid, 0));
    engine.enqueue(['https://youtube.com/watch?v=slow2'], o);
    await waitUntil(() => store.state.tasks[1]!.progress === 50);
    await engine.stop();
    assert.equal(store.state.tasks[1]!.status, 'interrupted');
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }); }
});
test('playlist parses safe text and selects independent tasks', async () => {
  const { root, store, cookies } = await context();
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch); engine.paused = false;
  try {
    engine.parse('https://youtube.com/playlist?list=test', 'none');
    await waitUntil(() => engine.playlist?.status === 'completed');
    assert.equal(engine.entries.length, 2);
    assert.equal(engine.entries[0]!.title, '<script>not html</script>');
    engine.paused = true;
    assert.deepEqual(engine.enqueueEntries([engine.entries[1]!.id], false, o), { added: 1, duplicates: 0 });
    assert.equal(store.state.tasks[0]!.url, 'https://www.youtube.com/watch?v=two');
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }); }
});
test('update asset selection, checksum and signing identity fail closed', async () => {
  assert.equal(assetName('win32', 'arm64'), 'yt-dlp_arm64.exe');
  assert.equal(assetName('darwin', 'x64'), 'yt-dlp_macos');
  assert.throws(() => assetName('linux', 'x64'));
  const data = Buffer.from('test');
  const sums = createHash('sha256').update(data).digest('hex') + '  test.exe\n';
  verifyChecksum(data, sums, 'test.exe');
  assert.throws(() => verifyChecksum(Buffer.from('corrupted'), sums, 'test.exe'));
  assert.throws(() => verifyChecksum(data, sums, 'other.exe'));
  await assert.rejects(verifyManifest(data, Buffer.from('bad'), 'bad key'));
});
test('updates wait for idle, surface failures and retain the current engine', async () => {
  const { root, store, cookies } = await context();
  let busy = true, paused = false;
  const updates = new Updates(store, '/bundled/yt-dlp', '/key', () => '', () => busy, value => { paused = value; }, () => {}, async url => {
    if (url.includes('api.github.com')) return Buffer.from(JSON.stringify({ tag_name: '2026.10.27', assets: [{ name: assetName(process.platform, process.arch), browser_download_url: 'ignored' }] }));
    throw new Error('模拟网络失败');
  });
  try {
    await updates.check();
    assert.equal(updates.info.status, 'available');
    updates.install();
    assert.equal(updates.info.status, 'waiting');
    assert.equal(paused, false);
    busy = false; updates.tick();
    assert.equal(paused, true);
    await waitUntil(() => updates.info.status === 'error');
    await updates.stop();
    assert.equal(paused, false);
    assert.equal(store.state.engine, '');
    assert.match(updates.info.error, /保留旧版本/);
  } finally { await cookies.stop(); await rm(root, { recursive: true, force: true }); }
});
