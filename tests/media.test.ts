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

const toolRoot = path.resolve('resources', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`);
const suffix = process.platform === 'win32' ? '.exe' : '';
const tools: Tools = { yt: path.join(toolRoot, `yt-dlp${suffix}`), ffmpeg: path.join(toolRoot, `ffmpeg${suffix}`), ffprobe: path.join(toolRoot, `ffprobe${suffix}`), node: path.join(toolRoot, `node${suffix}`) };
const available = existsSync(tools.yt) && existsSync(tools.ffmpeg);

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
