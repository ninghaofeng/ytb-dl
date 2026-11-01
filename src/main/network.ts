import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export async function download(url: string, proxy = '', maxBytes = 512 * 1024 * 1024, redirects = 0): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      !['github.com', 'api.github.com', 'raw.githubusercontent.com', 'nodejs.org', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(parsed.hostname)) throw new Error('拒绝非可信更新/资源地址。');
  if (redirects > 6) throw new Error('下载重定向过多。');
  const agent = proxy ? (/^socks/.test(proxy) ? new SocksProxyAgent(proxy) : new HttpsProxyAgent(proxy)) : undefined;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { agent, headers: { 'User-Agent': 'ytb-dl-ui/0.1', 'Accept': 'application/octet-stream' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), proxy, maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`下载服务返回 HTTP ${response.statusCode}（可能是限流或资源不存在）。`));
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
