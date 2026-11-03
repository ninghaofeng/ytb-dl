import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceChapters, sourceSubtitles, prepareSubtitleMetadata, validateSubtitles, verifyEmbedded, subtitleName } from '../src/main/metadata';
import { options, subtitleSelection } from '../src/main/validation';
import { sourceFormats, Formats } from '../src/main/formats';
import { downloadArgs, type Tools } from '../src/main/arguments';
import { Engine } from '../src/main/engine';
import { Store } from '../src/main/store';
import { Cookies } from '../src/main/cookies';
import { run } from '../src/main/process';
import type { SubtitleSelection, Task } from '../src/shared/types';

const preset = { kind: 'video', container: 'original', height: 0, cookie: 'none', selection: { video: 'v1', audio: 'a1' }, mergeFormat: 'mkv' } as const;
const selected: SubtitleSelection[] = [{ language: 'en', source: 'manual' }, { language: 'en', source: 'automatic' }, { language: 'zh-Hans', source: 'manual' }];
const raw = {
  title: 'source', formats: [{ format_id: 'v1', vcodec: 'h264', acodec: 'none', url: 'https://private.invalid/video' }],
  chapters: [{ start_time: 0, end_time: 2, title: 'Opening' }, { start_time: 2, end_time: 4, title: 'Ending' }],
  subtitles: {
    en: [{ ext: 'json3', url: 'https://private.invalid/?token=hidden' }, { ext: 'vtt', name: '<English>', url: 'https://private.invalid/manual', http_headers: { Authorization: 'hidden' } }],
    'zh-Hans': [{ ext: 'srt', data: '1\n00:00:00,000 --> 00:00:01,000\nmanual' }],
    live_chat: [{ ext: 'vtt', url: 'https://private.invalid/chat' }],
    '../invalid': [{ ext: 'srt', url: 'https://private.invalid/' }],
    fr: [{ ext: 'json3', url: 'https://private.invalid/' }]
  },
  automatic_captions: { en: [{ ext: 'vtt', name: 'English', url: 'https://private.invalid/automatic' }] }
};
test('inspection exposes safe chapter and subtitle metadata without URLs, headers or subtitle content', () => {
  const result = sourceFormats(raw);
  assert.equal(result.chapters.length, 2);
  assert.equal(result.subtitles.length, 3);
  assert.deepEqual(result.subtitles.map(track => [track.language, track.source]), [['en', 'manual'], ['zh-Hans', 'manual'], ['en', 'automatic']]);
  assert.deepEqual(result.subtitles[0]!.formats, ['vtt']);
  assert.ok(!JSON.stringify(result).includes('private.invalid'));
  assert.ok(!JSON.stringify(result).includes('Authorization'));
  assert.ok(!JSON.stringify(result).includes('00:00'));
  assert.deepEqual(sourceChapters({ chapters: [{ start_time: -1, end_time: 2 }, { start_time: 0, end_time: NaN }, { start_time: 1, end_time: 1 }] }), []);
  assert.deepEqual(sourceSubtitles({}), []);
});
test('subtitle selections preserve both sources and reject invalid, duplicate, unavailable and audio-only choices', () => {
  const available = sourceSubtitles(raw);
  assert.deepEqual(validateSubtitles(available, selected), selected);
  const value = options({ ...preset, embedChapters: true, subtitles: selected });
  assert.deepEqual(value.subtitles, selected);
  assert.equal(value.embedChapters, true);
  for (const invalid of [null, {}, [{ language: '.*', source: 'manual' }], [{ language: 'en', source: 'other' }], [{ language: 'en', source: ['manual'] }], [...selected, selected[0]], [{ ...selected[0], url: 'secret' }]]) {
    assert.throws(() => subtitleSelection(invalid));
  }
  assert.throws(() => validateSubtitles(available, [{ language: 'zh-Hans', source: 'automatic' }]), /不可用/);
  assert.throws(() => options({ ...preset, embedChapters: 'true' }), /章节/);
  assert.throws(() => options({ ...preset, selection: { audio: 'a1' }, mergeFormat: undefined, subtitles: selected }), /仅音频/);
  assert.equal(options(preset).embedChapters, undefined, 'legacy tasks must not acquire new defaults');
});
test('download metadata selects exact subtitle sources, uses distinct keys and never exposes private fields to renderer', () => {
  const prepared = prepareSubtitleMetadata(raw, selected);
  const tracks = prepared.subtitles as Record<string, { url?: string; data?: string; name: string }[]>;
  assert.equal(Object.keys(tracks).length, 3);
  assert.equal(Object.values(tracks)[0]![0]!.url, 'https://private.invalid/manual');
  assert.equal(Object.values(tracks)[1]![0]!.url, 'https://private.invalid/automatic');
  assert.deepEqual(Object.values(tracks).map(entries => entries[0]!.name), selected.map(subtitleName));
  assert.deepEqual(prepared.automatic_captions, {});
  assert.equal(prepared.webpage_url, undefined);
  assert.throws(() => prepareSubtitleMetadata({ ...raw, automatic_captions: {} }, selected), /不可用/);
});
test('embedding verification requires actual selected tracks and complete chapter titles and timings', () => {
  const chapters = sourceChapters(raw);
  const probe = { streams: selected.map(track => ({ codec_type: 'subtitle', tags: { title: subtitleName(track) } })), chapters: raw.chapters.map(chapter => ({ ...chapter, tags: { title: chapter.title } })) };
  verifyEmbedded(probe, selected, chapters);
  assert.throws(() => verifyEmbedded({ ...probe, streams: probe.streams.slice(1) }, selected, chapters), /未成功内挂/);
  assert.throws(() => verifyEmbedded({ ...probe, chapters: [] }, selected, chapters), /章节/);
  assert.throws(() => verifyEmbedded({ ...probe, chapters: [{ tags: { title: 'Opening' } }, probe.chapters[1]] }, selected, chapters), /章节/);
  verifyEmbedded({}, [], []);
  const task = { id: 'fixture-task', directory: '/tmp', url: 'https://youtube.com/watch?v=fixture', options: { ...preset, embedChapters: true, subtitles: selected } } as Task;
  const tools: Tools = { yt: 'yt', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
  const args = downloadArgs(task, tools, '', '');
  assert.ok(args.includes('--embed-chapters'));
  assert.ok(args.includes('--embed-subs'));
  assert.ok(args.includes('--no-embed-info-json'));
  assert.ok(!args.includes('--recode-video'));
  assert.ok(downloadArgs({ ...task, options: { ...task.options, embedChapters: false } }, tools, '', '').includes('--no-embed-chapters'));
});
test('process passes private metadata via stdin and propagates the full input', async () => {
  const input = JSON.stringify({ secret: 'private value', text: '字幕' });
  let output = '';
  await run(process.execPath, ['-e', 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>console.log(input))'], line => { output += line; }, undefined, input).done;
  assert.equal(output, input);
});
test('engine persists choices, validates source availability again and verifies embedded tracks before success', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-metadata-'));
  const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
  const calls: { args: string[]; input?: string }[] = [];
  const launch: typeof run = (_exe, args, onLine, cwd, input) => {
    calls.push({ args, input });
    return run(process.execPath, [path.resolve('tests/fixtures/engine.cjs'), ...args], onLine, cwd, input);
  };
  const tools: Tools = { yt: 'fixture', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: process.execPath };
  const cookies = new Cookies(store, () => tools.yt, () => {}, launch);
  const inspector = new Formats(() => tools, cookies, () => '', () => {}, () => false, launch);
  const engine = new Engine(store, () => tools, cookies, () => '', () => {}, launch);
  try {
    await cookies.init();
    const inspection = await inspector.inspect('https://youtube.com/watch?v=fixture', 'none');
    assert.deepEqual(inspector.selection(inspection.id, preset.selection, selected).subtitles, selected);
    assert.throws(() => inspector.selection(inspection.id, preset.selection, [{ language: 'fr', source: 'manual' }]), /不可用/);
    for (const url of ['fixture', 'missing-subs', 'subs-disappeared']) {
      engine.enqueue([`https://youtube.com/watch?v=${url}`], { ...preset, embedChapters: true, subtitles: selected });
      const task = store.state.tasks.at(-1)!;
      const deadline = Date.now() + 5000;
      while (!['completed', 'failed'].includes(task.status)) {
        if (Date.now() > deadline) throw new Error('Task did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (url === 'fixture') assert.equal(task.status, 'completed', task.error);
      else { assert.equal(task.status, 'failed'); assert.match(task.error, /未成功内挂|不可用/); }
    }
    assert.ok(calls.some(call => call.input && call.args.includes('--load-info-json')));
    assert.ok(calls.some(call => call.args.includes('-show_chapters')));
    assert.deepEqual(new Store(store.root, store.state.settings.directory).state.tasks[0]!.options.subtitles, selected);
  } finally { await inspector.cancel(); await engine.stop(); await rm(root, { recursive: true, force: true }); }
});
