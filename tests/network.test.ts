import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { download } from '../src/main/network';

test('update metadata requests JSON while resource downloads and redirects use destination-specific Accept headers', async t => {
  const calls: { url: string; accept: unknown }[] = [];
  t.mock.method(https, 'get', (url: string, options: https.RequestOptions, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string | undefined> }) => void) => {
    const headers = options.headers;
    assert.ok(headers && 'Accept' in headers);
    calls.push({ url, accept: headers.Accept });
    const request = Object.assign(new EventEmitter(), {
      setTimeout() { return request; },
      destroy(error: Error) { request.emit('error', error); request.emit('close'); return request; }
    });
    queueMicrotask(() => {
      const redirect = url.endsWith('/redirect');
      const response = Object.assign(new PassThrough(), {
        statusCode: redirect ? 302 : 200,
        headers: redirect ? { location: 'https://release-assets.githubusercontent.com/binary' } : {}
      });
      callback(response);
      response.end(redirect ? '' : url.includes('api.github.com') ? '{"tag_name":"2026.10.26"}' : 'binary');
      response.once('end', () => request.emit('close'));
    });
    return request;
  });
  const data = await download('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest');
  assert.equal(JSON.parse(data.toString()).tag_name, '2026.10.26');
  assert.equal((await download('https://github.com/download')).toString(), 'binary');
  const resolved: string[] = [];
  await download('https://api.github.com/redirect', async url => { resolved.push(url); return ''; });
  assert.deepEqual(resolved, ['https://api.github.com/redirect', 'https://release-assets.githubusercontent.com/binary']);
  assert.deepEqual(calls.map(call => call.accept), [
    'application/vnd.github+json', 'application/octet-stream', 'application/vnd.github+json', 'application/octet-stream'
  ]);
});

test('HTTP 415 is reported as an unsupported response format, not a missing resource or rate limit', async t => {
  t.mock.method(https, 'get', (_url: string, _options: https.RequestOptions, callback: (response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    const request = Object.assign(new EventEmitter(), {
      setTimeout() { return request; },
      destroy(error: Error) { request.emit('error', error); request.emit('close'); return request; }
    });
    queueMicrotask(() => {
      const response = Object.assign(new PassThrough(), { statusCode: 415, headers: {} });
      callback(response); response.end();
      response.once('end', () => request.emit('close'));
    });
    return request;
  });
  await assert.rejects(download('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'), /HTTP 415（服务器不支持请求的响应格式）/);
});
