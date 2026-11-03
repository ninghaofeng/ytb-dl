import { proxyUrl } from './validation';

export type ProxyResolver = (url: string) => string | Promise<string>;

export function systemProxyAddress(result: string): string {
  const first = result.split(';')[0]?.trim();
  if (first === 'DIRECT') return '';
  const match = first?.match(/^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/);
  if (!match) throw new Error('系统代理返回了不支持的配置，请检查系统代理或手动指定代理。');
  const schemes: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS4: 'socks4', SOCKS5: 'socks5h' };
  return proxyUrl(`${schemes[match[1]!]}://${match[2]}`);
}

export async function resolveApplicationProxy(url: string, manual: () => string, system: (url: string) => Promise<string>): Promise<string> {
  const override = manual();
  if (override) return proxyUrl(override);
  return systemProxyAddress(await system(url));
}
