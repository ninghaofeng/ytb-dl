import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadResource } from '../scripts/resource-download';

const url = 'https://nodejs.org/dist/example/node.tar.gz';
test('resource download retries transient failures and forwards proxy and size limits', async () => {
  let attempts = 0;
  const delays: number[] = [], warnings: string[] = [];
  const result = await downloadResource(url, 'http://localhost:7890', 1024, async (source, proxy, size) => {
    assert.equal(source, url); assert.equal(proxy, 'http://localhost:7890'); assert.equal(size, 1024);
    if (++attempts < 3) throw Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' });
    return Buffer.from('verified later');
  }, async delay => { delays.push(delay); }, message => { warnings.push(message); });
  assert.equal(result.toString(), 'verified later');
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(warning => warning.includes('nodejs.org/dist/example/node.tar.gz')));
});
test('exhausted retries identify the resource without exposing proxy credentials', async () => {
  let attempts = 0;
  await assert.rejects(downloadResource(url, 'http://user:secret@localhost:7890', undefined, async () => {
    attempts++;
    throw Object.assign(new Error('read ETIMEDOUT http://user:secret@localhost:7890'), { code: 'ETIMEDOUT' });
  }, async () => {}, () => {}), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /nodejs.org\/dist\/example\/node.tar.gz/);
    assert.match(error.message, /已尝试 3 次/);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(attempts, 3);
});
test('permanent errors are not retried and temporary HTTP errors are retried', async () => {
  for (const message of ['下载服务返回 HTTP 404', '拒绝非可信更新/资源地址。', 'certificate has expired', '下载资源超出允许大小。']) {
    let attempts = 0;
    await assert.rejects(downloadResource(url, '', undefined, async () => { attempts++; throw new Error(message); }, async () => { assert.fail('must not delay'); }));
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  await downloadResource(url, '', undefined, async () => {
    if (++attempts === 1) throw new Error('下载服务返回 HTTP 503（可能是限流或资源不存在）。');
    return Buffer.from('ok');
  }, async () => {}, () => {});
  assert.equal(attempts, 2);
});
