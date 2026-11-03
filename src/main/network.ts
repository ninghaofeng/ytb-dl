import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ProxyResolver } from './proxy';

export async function download(url: string, proxy: string | ProxyResolver = '', maxBytes = 512 * 1024 * 1024, redirects = 0): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      !['github.com', 'api.github.com', 'raw.githubusercontent.com', 'nodejs.org', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(parsed.hostname)) throw new Error('拒绝非可信更新/资源地址。');
  if (redirects > 6) throw new Error('下载重定向过多。');
  const address = typeof proxy === 'function' ? await proxy(url) : proxy;
  const agent = address ? (/^socks/.test(address) ? new SocksProxyAgent(address) : new HttpsProxyAgent(address)) : undefined;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent: agent || false, headers: {
      'User-Agent': 'ytb-dl-ui/0.1',
      'Accept': parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream'
    } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), proxy, maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        const detail = response.statusCode === 415 ? '服务器不支持请求的响应格式' :
          response.statusCode === 429 || response.statusCode === 403 ? '可能是限流或访问被拒绝' :
          response.statusCode === 404 ? '资源不存在' : '请检查网络或服务状态';
        reject(new Error(`下载服务返回 HTTP ${response.statusCode}（${detail}）。`));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) response.destroy(new Error('下载资源超出允许大小。'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks)));
    });
    const deadline = setTimeout(() => request.destroy(new Error('下载总时限已到，请检查网络或代理后重试。')), 10 * 60_000);
    request.setTimeout(45_000, () => request.destroy(new Error('连接超时，请检查网络或代理。')));
    request.once('error', reject);
    request.once('close', () => { clearTimeout(deadline); agent?.destroy(); });
  });
}
