import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApplicationProxy, systemProxyAddress } from '../src/main/proxy';
import { commonArgs } from '../src/main/arguments';

test('system HTTP, HTTPS, SOCKS and direct proxy results are converted without silent fallback', () => {
  for (const [result, expected] of [
    ['DIRECT', ''], ['PROXY 127.0.0.1:7890', 'http://127.0.0.1:7890/'],
    ['HTTPS proxy.test:443', 'https://proxy.test/'],
    ['SOCKS localhost:1080', 'socks5h://localhost:1080'],
    ['SOCKS5 [::1]:1080', 'socks5h://[::1]:1080'], ['SOCKS4 localhost:1080', 'socks4://localhost:1080'],
    ['PROXY localhost:7890; DIRECT', 'http://localhost:7890/'], ['DIRECT; PROXY localhost:7890', '']
  ]) assert.equal(systemProxyAddress(result!), expected);
  for (const invalid of ['', 'INVALID proxy.test:80', 'PROXY', 'PROXY host/path', 'QUIC host:443']) assert.throws(() => systemProxyAddress(invalid));
});

test('manual proxy wins, otherwise each destination resolves using current system rules', async () => {
  const seen: string[] = [];
  const system = async (url: string): Promise<string> => { seen.push(url); return url.includes('youtube') ? 'PROXY localhost:7890' : 'DIRECT'; };
  assert.equal(await resolveApplicationProxy('https://youtube.com/watch?v=a', () => 'socks5://localhost:1080', system), 'socks5://localhost:1080');
  assert.deepEqual(seen, []);
  assert.equal(await resolveApplicationProxy('https://youtube.com/watch?v=a', () => '', system), 'http://localhost:7890/');
  assert.equal(await resolveApplicationProxy('https://github.com', () => '', system), '');
  assert.equal(seen.length, 2);
  await assert.rejects(resolveApplicationProxy('https://youtube.com', () => '', async () => { throw new Error('system resolution failed'); }), /resolution failed/);
  const args = commonArgs({ yt: 'yt', ffmpeg: '/tools/ffmpeg', ffprobe: '/tools/ffprobe', node: 'node' }, '', '');
  assert.equal(args[args.indexOf('--proxy') + 1], '', 'DIRECT must explicitly disable yt-dlp environment proxy discovery');
});
