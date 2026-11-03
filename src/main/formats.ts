import { randomUUID } from 'node:crypto';
import type { Compression, CookieMode, FormatInspection, InspectionProgress, SourceFormat, StreamSelection } from '../shared/types';
import { commonArgs, type Tools } from './arguments';
import { formatId, streamSelection, videoUrl } from './validation';
import type { Cookies } from './cookies';
import { run, type Running } from './process';
import type { ProxyResolver } from './proxy';
import { sourceChapters, sourceSubtitles, validateSubtitles, type InspectedSource } from './metadata';

export function compression(codec: string): Compression {
  if (/^(flac|alac|pcm(?:_|$)|ffv1|huffyuv|utvideo|rawvideo)/i.test(codec)) return 'lossless';
  if (/^(avc1|h264|hev1|hvc1|hevc|av01|av1|vp0?[89]|mpeg[24]|mp4v|prores|mjpeg|aac|mp4a|mp3|opus|vorbis|ac-?3|e-?ac-?3)/i.test(codec)) return 'lossy';
  return 'unknown';
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
function label(value: unknown): string { return typeof value === 'string' ? value.slice(0, 500) : ''; }
export function sourceFormats(value: unknown): Pick<FormatInspection, 'title' | 'formats' | 'best' | 'chapters' | 'subtitles'> {
  const raw = record(value);
  if (!raw || typeof raw.title !== 'string' || raw._type === 'playlist' || raw.entries) throw new Error('未返回单视频格式，请先解析播放列表并选择条目。');
  const rows: unknown[] = Array.isArray(raw.formats) ? raw.formats : [raw];
  const formats: SourceFormat[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const f = record(row);
    if (!f || f.has_drm || !formatId(f.format_id) || f.protocol === 'mhtml' || f.ext === 'mhtml' ||
        (!f.url && !Array.isArray(f.fragments))) continue;
    const video = label(f.vcodec) || 'unknown', audio = label(f.acodec) || 'unknown';
    // Missing codec metadata is not evidence that a stream has no audio or video.
    if ((video === 'none' && audio === 'none') || ids.has(f.format_id)) continue;
    ids.add(f.format_id);
    const size = positive(f.filesize);
    formats.push({
      id: f.format_id, type: video === 'none' ? 'audio' : audio === 'none' ? 'video' : 'combined',
      ext: label(f.ext) || '未知', videoCodec: video, audioCodec: audio,
      videoCompression: compression(video), audioCompression: compression(audio),
      width: positive(f.width), height: positive(f.height), fps: positive(f.fps),
      videoBitrate: positive(f.vbr), audioBitrate: positive(f.abr), totalBitrate: positive(f.tbr),
      sampleRate: positive(f.asr), channels: positive(f.audio_channels), language: label(f.language),
      dynamicRange: label(f.dynamic_range), size: size || positive(f.filesize_approx), approximateSize: !size
    });
  }
  if (!formats.length) throw new Error('没有可选择的非 DRM 音视频格式；可能需要登录、更新引擎，或此视频只有不可识别的格式。');
  // yt-dlp orders formats from worst to best using its extractor-specific quality rules.
  const ranked = [...formats].reverse();
  const video = ranked.find(f => f.type === 'video'), audio = ranked.find(f => f.type === 'audio');
  return { title: raw.title.slice(0, 1000), formats, best: { ...(video ? { video: video.id } : {}), ...(audio ? { audio: audio.id } : {}) },
    chapters: sourceChapters(raw), subtitles: sourceSubtitles(raw) };
}
export function validateSelection(formats: SourceFormat[], value: unknown): StreamSelection {
  const selection = streamSelection(value);
  if (selection.combined) throw new Error('不再提供音视频合一流下载，请分别选择视频和音频后合并。');
  for (const type of ['video', 'audio', 'combined'] as const) {
    if (selection[type] && !formats.some(f => f.id === selection[type] && f.type === type)) throw new Error('所选格式不属于当前视频或流类型不匹配，请重新解析。');
  }
  return selection;
}
export class Formats {
  info: InspectionProgress | null = null;
  private work?: Promise<FormatInspection>;
  private process?: Running;
  private owner = '';
  private cancelled = false;
  private interrupt?: (error: Error) => void;
  private current?: { result: FormatInspection; cookie: CookieMode; source: InspectedSource };
  get busy(): boolean { return !!this.work; }
  constructor(private tools: () => Tools, private cookies: Cookies, private proxy: ProxyResolver, private changed: () => void, private blocked: () => boolean, private launch: typeof run = run, private limits = { cookies: 120_000, proxy: 20_000, metadata: 120_000 }) {}
  private async stage<T>(stage: InspectionProgress['stage'], operation: () => Promise<T>, stop?: (pending: Promise<T>) => Promise<void>): Promise<T> {
    const messages = {
      cookies: '同步 Cookie 超时。请检查 Chrome 钥匙串授权弹窗；可改用导出的 cookies.txt。不会自动改为无 Cookie。',
      proxy: '系统代理解析超时。请检查系统代理/PAC，或在设置中手动指定代理。',
      metadata: '读取平台格式超时。请检查代理是否可访问 YouTube/目标平台，以及登录或人机验证状态。'
    };
    const timeoutMs = this.limits[stage];
    this.info = { stage, startedAt: Date.now(), timeoutMs }; this.changed();
    let timer: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      this.interrupt = reject;
      timer = setTimeout(() => reject(new Error(messages[stage])), timeoutMs);
    });
    const pending = Promise.resolve().then(operation);
    try { return await Promise.race([pending, interrupted]); }
    catch (error) {
      if (stop) await stop(pending);
      if (stage === 'metadata' && error instanceof Error && error.message === messages.metadata) {
        const detail = this.process?.diagnostics();
        if (detail) throw new Error(`${error.message}\n引擎诊断：${detail}`);
      }
      throw error;
    } finally { clearTimeout(timer); this.interrupt = undefined; }
  }
  inspect(url: string, cookie: CookieMode): Promise<FormatInspection> {
    if (this.busy || this.blocked()) throw new Error('正在解析、退出或安装更新，请稍后再试。');
    const validated = videoUrl(url);
    if (!['none', 'file', 'chrome'].includes(cookie)) throw new Error('Cookie 来源无效。');
    this.current = undefined;
    this.owner = randomUUID();
    this.cancelled = false;
    this.work = this.inspectRun(validated, cookie);
    this.changed();
    return this.work;
  }
  private async inspectRun(url: string, mode: CookieMode): Promise<FormatInspection> {
    try {
      const inspected = await this.cookies.withSnapshot(mode, this.owner, async cookie => {
        if (this.cancelled) throw new Error('已取消格式解析。');
        const cookieIdentity = await this.cookies.snapshotIdentity(mode, cookie);
        const proxy = await this.stage('proxy', async () => this.proxy(url));
        if (this.cancelled) throw new Error('已取消格式解析。');
        let metadata: ReturnType<typeof sourceFormats> | undefined;
        let raw: Record<string, unknown> | undefined;
        await this.stage('metadata', async () => {
          this.process = this.launch(this.tools().yt, [...commonArgs(this.tools(), proxy, cookie), '--no-playlist', '--skip-download', '--dump-json', '--', url], line => {
            if (!line.startsWith('{')) return;
            if (metadata) throw new Error('格式解析意外返回多个视频，请先解析播放列表。');
            const parsed = JSON.parse(line) as Record<string, unknown>;
            metadata = sourceFormats(parsed);
            raw = parsed;
          });
          await this.process.done;
        }, async () => { await this.process?.stop(); });
        if (this.cancelled) throw new Error('已取消格式解析。');
        if (!metadata || !raw) throw new Error('引擎未返回视频格式。');
        return { result: { id: this.owner, url, ...metadata }, source: { url, cookieIdentity, proxy, inspectedAt: Date.now(), raw } };
      }, () => this.stage('cookies', () => this.cookies.snapshot(mode, this.owner), async pending => {
        if (mode !== 'none') await this.cookies.cancelSnapshot(this.owner);
        const late = await pending.catch(() => '');
        await this.cookies.removeSnapshot(late);
      }));
      this.current = { ...inspected, cookie: mode };
      return inspected.result;
    } finally {
      this.process = undefined; this.work = undefined; this.info = null; this.changed();
    }
  }
  selection(id: string, value: unknown, subtitles: unknown = []): { url: string; cookie: CookieMode; selection: StreamSelection; subtitles: ReturnType<typeof validateSubtitles>; source: InspectedSource } {
    if (this.busy || !this.current || this.current.result.id !== id) throw new Error('格式列表已失效，请重新解析当前视频。');
    return { url: this.current.result.url, cookie: this.current.cookie, selection: validateSelection(this.current.result.formats, value), subtitles: validateSubtitles(this.current.result.subtitles, subtitles), source: this.current.source };
  }
  async cancel(): Promise<void> {
    this.cancelled = true; this.current = undefined;
    this.interrupt?.(new Error('已取消格式解析。'));
    if (this.work) await this.cookies.cancelSnapshot(this.owner);
    // The caller of inspect receives the original extraction or cancellation error.
    await this.work?.catch(() => {});
  }
}
