import type { DownloadOptions, Settings, StreamSelection } from '../shared/types';

const domains = ['youtube.com', 'youtu.be', 'douyin.com', 'iesdouyin.com', 'tiktok.com'];
export function videoUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('请输入有效的视频链接。');
  const match = value.match(/https?:\/\/[^\s<>"\u3000]+/i);
  if (!match) throw new Error('未找到视频链接；可以粘贴包含链接的分享文字。');
  const url = new URL(match[0].replace(/[，。！？、；）】]+$/u, ''));
  if (!domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`)) ||
      url.username || url.password || (url.port && url.port !== '443' && url.port !== '80')) {
    throw new Error('仅支持 YouTube、抖音和 TikTok 的官方链接。');
  }
  return url.toString();
}
export function options(value: unknown): DownloadOptions {
  if (!value || typeof value !== 'object') throw new Error('下载选项无效。');
  const v = value as Record<string, unknown>;
  if (!['video', 'mp3'].includes(String(v.kind)) || !['original', 'mp4'].includes(String(v.container)) ||
      ![0, 360, 480, 720, 1080, 1440, 2160].includes(Number(v.height)) ||
      typeof v.height !== 'number' || !['none', 'file', 'chrome'].includes(String(v.cookie))) {
    throw new Error('下载格式、画质或 Cookie 来源无效。');
  }
  const selection = v.selection === undefined ? undefined : streamSelection(v.selection);
  if (selection && (v.kind !== 'video' || v.container !== 'original' || v.height !== 0)) throw new Error('精确格式选择不能与 MP3 转码、画质上限或预设容器混用。');
  if (v.mergeFormat !== undefined && (!['mkv', 'mov', 'mp4'].includes(String(v.mergeFormat)) ||
      typeof v.mergeFormat !== 'string' || !selection?.video || !selection.audio)) throw new Error('合并格式必须是 MKV、MOV 或 MP4，且须分别选择视频和音频。');
  return { kind: v.kind as DownloadOptions['kind'], container: v.container as DownloadOptions['container'], height: v.height, cookie: v.cookie as DownloadOptions['cookie'], ...(selection ? { selection } : {}), ...(v.mergeFormat !== undefined ? { mergeFormat: v.mergeFormat as DownloadOptions['mergeFormat'] } : {}) };
}
export function formatId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(value);
}
export function streamSelection(value: unknown): StreamSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择真实的音视频格式。');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['video', 'audio', 'combined'].includes(k)) ||
      Object.values(v).some(id => !formatId(id)) ||
      (!v.video && !v.audio && !v.combined) || (v.combined && (v.video || v.audio)) ||
      (v.video && v.video === v.audio)) throw new Error('音视频格式选择无效，不能混用合一流与独立流。');
  return { ...(v.video ? { video: v.video as string } : {}), ...(v.audio ? { audio: v.audio as string } : {}), ...(v.combined ? { combined: v.combined as string } : {}) };
}
export function settings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('设置无效。');
  const v = value as Record<string, unknown>;
  if (typeof v.directory !== 'string' || !v.directory || v.directory.length > 4096 ||
      typeof v.concurrency !== 'number' || !Number.isInteger(v.concurrency) || v.concurrency < 1 || v.concurrency > 5 ||
      typeof v.checkUpdates !== 'boolean' || typeof v.chromeProfile !== 'string' ||
      typeof v.chromeAuthorized !== 'boolean' || typeof v.watchCookies !== 'boolean') throw new Error('设置无效；并发数须为 1–5。');
  return { directory: v.directory, concurrency: v.concurrency, checkUpdates: v.checkUpdates, chromeProfile: v.chromeProfile, chromeAuthorized: v.chromeAuthorized, watchCookies: v.watchCookies };
}
export function proxyUrl(value: string): string {
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol) || !url.hostname ||
      (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('代理须为 HTTP/HTTPS/SOCKS 地址，不能含路径。');
  return url.toString();
}
export function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]')
    .replace(/(?:socks\w*):\/\/[^\s"'<>]+/gi, '[代理已隐藏]')
    .replace(/\b(cookie|authorization|token|password)\s*[:=][^\n]*/gi, '$1 [敏感信息已隐藏]')
    .slice(-6000);
}
export function errorMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
