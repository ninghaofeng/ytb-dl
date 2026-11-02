import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { run } from '../src/main/process';
import { downloadArgs, type Tools } from '../src/main/arguments';
import type { Task } from '../src/shared/types';
import { verifyManifest, Updates, BUNDLED_YT_VERSION, assetName } from '../src/main/updates';
import { Store } from '../src/main/store';
import { sourceFormats } from '../src/main/formats';

const toolRoot = path.resolve('resources', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';
const tools: Tools = { yt: path.join(toolRoot, `yt-dlp${suffix}`), ffmpeg: path.join(toolRoot, `ffmpeg${suffix}`), ffprobe: path.join(toolRoot, `ffprobe${suffix}`), node: path.join(toolRoot, `node${suffix}`) };
const available = existsSync(tools.yt) && existsSync(tools.ffmpeg);

test('exact source video and audio IDs merge without re-encoding or fallback', { skip: !available, timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-source-streams-'));
  let server: http.Server | undefined;
  try {
    const video = path.join(root, 'video.mp4'), audio = path.join(root, 'audio.flac');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=5:duration=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]).done;
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a', 'flac', audio]).done;
    const files = new Map([['/video.mp4', await readFile(video)], ['/audio.flac', await readFile(audio)]]);
    server = http.createServer((request, response) => {
      const data = files.get(request.url || '');
      if (!data) { response.writeHead(404); response.end(); return; }
      const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
      response.writeHead(start ? 206 : 200, {
        'Content-Type': request.url?.endsWith('mp4') ? 'video/mp4' : 'audio/flac',
        'Content-Length': data.length - start, 'Accept-Ranges': 'bytes',
        ...(start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {})
      });
      response.end(request.method === 'HEAD' ? undefined : data.subarray(start));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const metadata = {
      id: 'local-source', title: 'source streams', extractor: 'generic', extractor_key: 'Generic',
      webpage_url: 'https://youtube.com/watch?v=local-source',
      formats: [
        { format_id: 'chosen-video', url: `${base}/video.mp4`, ext: 'mp4', vcodec: 'avc1.64000a', acodec: 'none', width: 128, height: 72, fps: 5 },
        { format_id: 'chosen-audio', url: `${base}/audio.flac`, ext: 'flac', vcodec: 'none', acodec: 'flac', asr: 44100, audio_channels: 1 }
      ]
    };
    assert.deepEqual(sourceFormats(metadata).formats.map(f => f.type), ['video', 'audio']);
    const info = path.join(root, 'metadata.json'); await writeFile(info, JSON.stringify(metadata));
    let inspected = false;
    await run(tools.yt, ['--ignore-config', '--proxy', '', '--skip-download', '--dump-json', '--load-info-json', info], line => {
      if (!line.startsWith('{')) return;
      const actual = sourceFormats(JSON.parse(line));
      assert.deepEqual(actual.formats.map(f => f.id).sort(), ['chosen-audio', 'chosen-video']);
      assert.equal(actual.formats.find(f => f.id === 'chosen-audio')!.audioCompression, 'lossless');
      inspected = true;
    }).done;
    assert.ok(inspected, 'real yt-dlp must emit selectable format metadata before downloading');
    const task: Task = {
      id: randomUUID(), url: metadata.webpage_url, title: metadata.title, directory: root,
      options: { kind: 'video', container: 'original', height: 0, cookie: 'none', selection: { video: 'chosen-video', audio: 'chosen-audio' } },
      status: 'queued', progress: 0, speed: '', eta: '', error: '', file: '', createdAt: ''
    };
    let output = '';
    const args = [...downloadArgs(task, tools, '', '').slice(0, -2), '--proxy', '', '--load-info-json', info];
    await run(tools.yt, args, line => { if (line.startsWith('FILE:')) output = JSON.parse(line.slice(5)); }).done;
    assert.ok(output.endsWith('.mkv'), output);
    let probe = '';
    await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', output], line => { probe += line; }).done;
    assert.deepEqual(JSON.parse(probe).streams.map((s: { codec_name: string }) => s.codec_name), ['h264', 'flac']);
    async function packetHash(file: string, stream: string): Promise<string> {
      let hash = '';
      await run(tools.ffmpeg, ['-v', 'error', '-i', file, '-map', stream, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], line => { hash += line; }).done;
      assert.match(hash, /^SHA256=/);
      return hash;
    }
    assert.equal(await packetHash(output, '0:v:0'), await packetHash(video, '0:v:0'), 'encoded video packets must be unchanged');
    assert.equal(await packetHash(output, '0:a:0'), await packetHash(audio, '0:a:0'), 'encoded audio packets must be unchanged');
    await assert.rejects(run(tools.yt, [...args.slice(0, args.indexOf('-f') + 1), 'unavailable-video+chosen-audio', ...args.slice(args.indexOf('-f') + 2)]).done, /Requested format is not available/);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});

test('real bundled media tools: Range resume, protocol, MP3 and final file', { skip: !available, timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-range-'));
  let server: http.Server | undefined;
  try {
    const source = path.join(root, 'source.wav');
    await run(tools.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:a', 'pcm_s16le', source]).done;
    const data = await readFile(source);
    const ranges: number[] = [];
    server = http.createServer((request, response) => {
      const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
      if (start) ranges.push(start);
      response.writeHead(start ? 206 : 200, {
        'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': data.length - start,
        ...(start ? { 'Content-Range': `bytes ${start}-${data.length - 1}/${data.length}` } : {})
      });
      if (request.method === 'HEAD') { response.end(); return; }
      let offset = start;
      const timer = setInterval(() => {
        const end = Math.min(offset + 8192, data.length);
        response.write(data.subarray(offset, end)); offset = end;
        if (offset >= data.length) { clearInterval(timer); response.end(); }
      }, 15);
      response.on('close', () => clearInterval(timer));
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const task: Task = { id: randomUUID(), url: `http://127.0.0.1:${address.port}/source.wav`, title: '', directory: root, options: { kind: 'mp3', container: 'original', height: 0, cookie: 'none' }, status: 'queued', progress: 0, speed: '', eta: '', error: '', file: '', createdAt: '' };
    const args = ['--proxy', '', ...downloadArgs(task, tools, '', '')];
    let observedProgress = false;
    const partial = run(tools.yt, args, line => { if (line.startsWith('DL:')) observedProgress = true; });
    let ended = false, partialError = '';
    const partialDone = partial.done.catch(error => { partialError = String(error); }).finally(() => { ended = true; });
    const deadline = Date.now() + 100_000;
    let partSize = 0;
    while (!ended && partSize < 64 * 1024 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      const part = (await readdir(root)).find(f => f.endsWith('.part'));
      if (part) partSize = (await stat(path.join(root, part))).size;
    }
    await partial.stop(); await partialDone;
    assert.ok(partSize >= 64 * 1024 && partSize < data.length, `must interrupt a real partial download: ${partialError}`);
    let finalFile = '';
    let processing = false;
    await run(tools.yt, args, line => {
      if (line.startsWith('DL:')) { JSON.parse(line.slice(3)); observedProgress = true; }
      if (line.startsWith('PP:') || line.startsWith('STAGE:')) processing = true;
      if (line.startsWith('FILE:')) finalFile = JSON.parse(line.slice(5));
    }).done;
    assert.ok(ranges.some(start => start > 0), 'server must observe a nonzero Range request');
    assert.ok(observedProgress);
    assert.ok(processing, 'must observe postprocessing progress');
    assert.ok(finalFile.endsWith('.mp3'));
    assert.ok((await stat(finalFile)).size > 0);
    let probe = '';
    await run(tools.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', finalFile], line => { probe += line; }).done;
    assert.equal(JSON.parse(probe).streams[0].codec_name, 'mp3');
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(root, { recursive: true, force: true });
  }
});
test('real cookie-save lifecycle exports jar without network and rejects tampered signature', { skip: !available, timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-cookie-cli-'));
  try {
    const file = path.join(root, 'cookies.txt');
    const fake = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tTEST\tfake-value\n';
    await writeFile(file, fake);
    await run(tools.yt, ['--ignore-config', '--cookies', file, '--list-impersonate-targets']).done;
    assert.match(await readFile(file, 'utf8'), /fake-value/);
    const manifest = await readFile(path.join(toolRoot, 'yt-dlp-SHA2-256SUMS.txt'));
    const key = await readFile('resources/public.key', 'utf8');
    await assert.rejects(verifyManifest(manifest, Buffer.from('not a signature'), key));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('official signed binary installs transactionally, rolls back and rejects corruption', { skip: !available, timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-update-'));
  try {
    const store = new Store(path.join(root, 'data'), path.join(root, 'output'));
    let busy = true, paused = false, corrupt = false;
    const updates = new Updates(store, tools.yt, path.resolve('resources/public.key'), () => '', () => busy, value => { paused = value; }, () => {}, async url => {
      if (url.includes('api.github.com')) return Buffer.from(JSON.stringify({ tag_name: BUNDLED_YT_VERSION, assets: [{ name: assetName(process.platform, process.arch) }] }));
      if (url.endsWith('SHA2-256SUMS')) return readFile(path.join(toolRoot, 'yt-dlp-SHA2-256SUMS.txt'));
      if (url.endsWith('SHA2-256SUMS.sig')) return readFile(path.join(toolRoot, 'yt-dlp-SHA2-256SUMS.sig.txt'));
      return corrupt ? Buffer.from('corrupted') : readFile(tools.yt);
    });
    await updates.init();
    // Simulate the UI version of an older bundled engine; serve an actual signed release as the upgrade.
    updates.info.current = '2026.10.25';
    await updates.check(); updates.install();
    assert.equal(updates.info.status, 'waiting');
    busy = false; updates.tick();
    assert.equal(paused, true);
    await updates.stop();
    assert.equal(updates.info.status, 'idle', updates.info.error);
    assert.equal(store.state.engine, BUNDLED_YT_VERSION);
    assert.equal(paused, false);
    assert.deepEqual(await readFile(updates.yt()), await readFile(tools.yt));
    await updates.rollback();
    assert.equal(store.state.engine, '');
    assert.equal(updates.yt(), tools.yt);
    corrupt = true; updates.info.current = '2026.10.25';
    await updates.check(); updates.install(); await updates.stop();
    assert.equal(updates.info.status, 'error');
    assert.match(updates.info.error, /校验失败/);
    assert.equal(store.state.engine, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
