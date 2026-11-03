import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceFormats, compression, validateSelection, Formats } from '../src/main/formats';
import { options, streamSelection } from '../src/main/validation';
import { formatArgs, type Tools } from '../src/main/arguments';
import { Store } from '../src/main/store';
import { Cookies } from '../src/main/cookies';
import { Engine } from '../src/main/engine';
import { run } from '../src/main/process';

const row = { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 60, url: 'https://private.invalid/?token=secret' };
const audio = { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, asr: 48000, audio_channels: 2, url: 'https://private.invalid/' };
const preset = { kind: 'video', container: 'original', height: 0, cookie: 'none' } as const;
test('real format metadata preserves source codecs, unknowns, estimates and excludes protected or non-media entries', () => {
  const result = sourceFormats({ title: '<script>safe text</script>', formats: [
    { ...row, filesize_approx: 100 }, audio,
    { ...audio, format_id: 'lossless', acodec: 'flac', filesize: 200, filesize_approx: 300 },
    { ...row, format_id: 'mystery', vcodec: 'new-codec', fps: NaN, height: null },
    { ...row, format_id: 'missing-codecs', vcodec: undefined, acodec: undefined },
    { ...row, format_id: 'drm', has_drm: true },
    { ...row, format_id: 'image', vcodec: 'none', acodec: 'none' },
    { ...row, format_id: 'storyboard', protocol: 'mhtml' },
    { ...row, format_id: 'unsafe+best' }, { ...row, format_id: 'no-url', url: undefined },
    row
  ] });
  assert.equal(result.formats.length, 5);
  assert.equal(result.formats[0]!.type, 'video');
  assert.equal(result.formats[0]!.videoCompression, 'lossy');
  assert.equal(result.formats[0]!.size, 100);
  assert.equal(result.formats[0]!.approximateSize, true);
  assert.equal(result.formats[1]!.type, 'audio');
  assert.equal(result.formats[1]!.sampleRate, 48000);
  assert.equal(result.formats[1]!.audioBitrate, 128);
  assert.equal(result.formats[2]!.audioCompression, 'lossless');
  assert.equal(result.formats[2]!.size, 200);
  assert.equal(result.formats[2]!.approximateSize, false);
  assert.equal(result.formats[3]!.fps, null);
  assert.equal(result.formats[3]!.videoCompression, 'unknown');
  assert.equal(result.formats[4]!.type, 'combined');
  assert.equal(result.formats[4]!.audioCodec, 'unknown');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('private.invalid'));
  assert.throws(() => sourceFormats({ title: 'empty', formats: [] }), /没有可选择/);
  assert.throws(() => sourceFormats({ title: 'playlist', _type: 'playlist', entries: [] }), /播放列表/);
  assert.equal(sourceFormats({ title: 'direct', ...row }).formats.length, 1);
  for (const codec of ['pcm_s16le', 'alac', 'ffv1']) assert.equal(compression(codec), 'lossless');
  for (const codec of ['av01.0.08M.08', 'vp09.00.51.08', 'opus']) assert.equal(compression(codec), 'lossy');
  assert.equal(compression('dts'), 'unknown');
});
test('exact source selections reject expression injection, wrong tracks and incompatible legacy options', () => {
  const { formats } = sourceFormats({ title: 'test', formats: [row, audio, { ...row, format_id: '18', acodec: 'aac' }] });
  assert.deepEqual(validateSelection(formats, { video: '137', audio: '140' }), { video: '137', audio: '140' });
  assert.deepEqual(formatArgs({ ...preset, selection: { video: '137', audio: '140' } }), ['-f', '137+140', '--merge-output-format', 'mkv']);
  for (const mergeFormat of ['mkv', 'mov', 'mp4'] as const) {
    const validated = options({ ...preset, selection: { video: '137', audio: '140' }, mergeFormat });
    assert.deepEqual(formatArgs(validated), ['-f', '137+140', '--merge-output-format', mergeFormat]);
  }
  assert.throws(() => options({ ...preset, selection: { video: '137', audio: '140' }, mergeFormat: 'avi' }));
  assert.throws(() => options({ ...preset, selection: { audio: '140' }, mergeFormat: 'mp4' }));
  assert.throws(() => validateSelection(formats, { combined: '18' }), /不再提供/);
  for (const selection of [{ combined: '18' }, { video: '137' }, { audio: '140' }]) {
    const args = formatArgs({ ...preset, selection });
    assert.equal(args.length, 2);
    assert.ok(!args.includes('-x'));
    assert.ok(!args.includes('--audio-format'));
  }
  for (const selection of [{}, { video: '137/best' }, { video: '137+140' }, { audio: '--exec' }, { combined: '18', audio: '140' }, { video: '137', audio: '137' }, { audio: '140', shell: 'true' }]) assert.throws(() => streamSelection(selection));
  assert.throws(() => validateSelection(formats, { video: '140' }), /不匹配/);
  assert.throws(() => validateSelection(formats, { audio: 'unknown' }), /不匹配/);
  for (const extra of [{ kind: 'mp3' }, { container: 'mp4' }, { height: 720 }]) assert.throws(() => options({ ...preset, selection: { video: '137' }, ...extra }));
});
test('best shortcut follows yt-dlp quality ordering rather than format ID, byte size or merged-stream quality', () => {
  const parsed = sourceFormats({ title: 'quality order', formats: [
    { ...row, format_id: '9999', filesize: 5000000 },
    { ...audio, format_id: '9999a', filesize: 5000000 },
    { ...row, format_id: 'best-video', height: 2160, filesize: 100 },
    { ...audio, format_id: 'best-audio', acodec: 'opus', filesize: 50 },
    { ...row, format_id: 'merged', acodec: 'aac', height: 4320 }
  ] });
  assert.deepEqual(parsed.best, { video: 'best-video', audio: 'best-audio' });
  assert.deepEqual(sourceFormats({ title: 'audio only', formats: [audio] }).best, { audio: '140' });
});
test('inspection uses Cookie/proxy, does not download, validates video-specific choices and persists exact selections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-formats-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  const calls: string[][] = [];
  const launch: typeof run = (_exe, args, onLine, cwd) => {
    calls.push(args);
    return run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd);
  };
  const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch);
  const inspector = new Formats(() => tools, cookies, () => 'socks5://localhost:1080', () => {}, () => false, launch);
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch);
  engine.paused = true;
  try {
    await cookies.init();
    const source = path.join(root, 'export.txt');
    await writeFile(source, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tTEST\tfake-value\n');
    await cookies.importFile(source, false);
    const first = await inspector.inspect('https://youtube.com/watch?v=one', 'file');
    assert.equal(store.state.tasks.length, 0);
    assert.equal(first.formats.length, 10);
    assert.ok(calls[0]!.includes('--skip-download'));
    assert.ok(calls[0]!.includes('--no-playlist'));
    assert.ok(calls[0]!.includes('--cookies'));
    assert.ok(calls[0]!.includes('socks5://localhost:1080'));
    assert.ok(!calls[0]!.includes('-o'));
    const selected = inspector.selection(first.id, { video: 'v1', audio: 'flac' });
    engine.enqueue([selected.url], { ...preset, cookie: selected.cookie, selection: selected.selection, mergeFormat: 'mov' });
    const restored = new Store(store.root, store.state.settings.directory);
    assert.deepEqual(restored.state.tasks[0]!.options.selection, { video: 'v1', audio: 'flac' });
    assert.equal(restored.state.tasks[0]!.options.mergeFormat, 'mov');
    const second = await inspector.inspect('https://youtube.com/watch?v=two', 'none');
    assert.throws(() => inspector.selection(first.id, { audio: 'a1' }), /失效/);
    assert.throws(() => inspector.selection(second.id, { video: 'v1' }), /不匹配/);
    assert.equal(inspector.selection(second.id, { audio: 'a2' }).selection.audio, 'a2');
    const busy = inspector.inspect('https://youtube.com/watch?v=inspect-slow', 'none');
    const rejected = assert.rejects(busy);
    assert.throws(() => inspector.inspect('https://youtube.com/watch?v=one', 'none'), /正在解析/);
    const deadline = Date.now() + 3000;
    while (!calls.some(args => args.at(-1)?.includes('inspect-slow'))) {
      if (Date.now() > deadline) throw new Error('Inspector process did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await inspector.cancel(); await rejected;
    assert.equal(inspector.busy, false);
    assert.throws(() => inspector.selection(second.id, { audio: 'a2' }), /失效/);
    await assert.rejects(inspector.inspect('https://youtube.com/watch?v=inspect-fail', 'none'), /format extraction failed/);
    assert.equal(inspector.busy, false);
    assert.deepEqual((await readdir(cookies.root)).filter(f => f.startsWith('task-')), []);
    const blocked = new Formats(() => tools, cookies, () => '', () => {}, () => true, launch);
    assert.throws(() => blocked.inspect('https://youtube.com/watch?v=one', 'none'), /正在解析/);
    cookies.info.chromeAuthorized = true; cookies.info.chromeProfile = 'Profile 99';
    const chrome = inspector.inspect('https://youtube.com/watch?v=one', 'chrome');
    const chromeRejected = assert.rejects(chrome);
    while (!cookies.busy) await new Promise(resolve => setTimeout(resolve, 10));
    await inspector.cancel(); await chromeRejected;
    assert.equal(inspector.busy, false);
    assert.equal(cookies.busy, false);
  } finally { await inspector.cancel(); await engine.stop(); await rm(root, { recursive: true, force: true }); }
});

test('merge failures retain the chosen container and explain no-transcoding behavior', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-merge-failure-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  const launch: typeof run = (_exe, args, onLine, cwd) => run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd);
  const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch);
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch);
  try {
    await cookies.init();
    engine.enqueue(['https://youtube.com/watch?v=merge-fail'], { ...preset, selection: { video: 'v1', audio: 'a1' }, mergeFormat: 'mov' });
    const deadline = Date.now() + 3000;
    while (store.state.tasks[0]!.status !== 'failed') {
      if (Date.now() > deadline) throw new Error('Merge failure was not reported');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(store.state.tasks[0]!.error, /合并为 MOV 失败/);
    assert.match(store.state.tasks[0]!.error, /不会自动转码/);
    assert.match(store.state.tasks[0]!.error, /改选 MKV/);
    assert.equal(store.state.tasks[0]!.options.mergeFormat, 'mov');
  } finally { await engine.stop(); await rm(root, { recursive: true, force: true }); }
});

test('inspection timeouts identify the stalled stage, stop extraction and allow a fresh attempt', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-inspection-timeout-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  const processes: ReturnType<typeof run>[] = [];
  const launch: typeof run = (_exe, args, onLine, cwd) => {
    const process = run(globalThis.process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd);
    processes.push(process); return process;
  };
  const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch);
  const limits = { cookies: 200, proxy: 50, metadata: 200 };
  const phases: string[] = [];
  const inspector = new Formats(() => tools, cookies, () => '', () => { if (inspector.info) phases.push(inspector.info.stage); }, () => false, launch, limits);
  const stalledProxy = new Formats(() => tools, cookies, () => new Promise<string>(() => {}), () => {}, () => false, launch, limits);
  try {
    await cookies.init();
    await assert.rejects(inspector.inspect('https://youtube.com/watch?v=inspect-slow', 'none'), /读取平台格式超时/);
    assert.deepEqual([...new Set(phases)], ['cookies', 'proxy', 'metadata']);
    assert.equal(inspector.busy, false);
    assert.equal(inspector.info, null);
    const child = processes.at(-1)!.child;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    await inspector.inspect('https://youtube.com/watch?v=one', 'none');
    await assert.rejects(stalledProxy.inspect('https://youtube.com/watch?v=one', 'none'), /系统代理解析超时/);
    assert.equal(stalledProxy.busy, false);
    const pending = stalledProxy.inspect('https://youtube.com/watch?v=one', 'none');
    const cancelled = assert.rejects(pending, /已取消/);
    await stalledProxy.cancel(); await cancelled;
    assert.equal(stalledProxy.busy, false);
    cookies.info.chromeAuthorized = true; cookies.info.chromeProfile = 'Profile 99';
    await assert.rejects(inspector.inspect('https://youtube.com/watch?v=one', 'chrome'), /同步 Cookie 超时/);
    assert.equal(cookies.busy, false);
    assert.equal(inspector.busy, false);
    assert.deepEqual(await readdir(cookies.root), []);
    assert.equal(store.state.tasks.length, 0, 'timeout must never enqueue or retry without Cookie');
  } finally { await inspector.cancel(); await stalledProxy.cancel(); await cookies.stop(); await rm(root, { recursive: true, force: true }); }
});
