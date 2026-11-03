import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Chapter, CookieMode, DownloadOptions, Playlist, PlaylistEntry, PreparationProgress, Task } from '../shared/types';
import { commonArgs, downloadArgs, type Tools } from './arguments';
import { run, type Running } from './process';
import { options, videoUrl, errorMessage } from './validation';
import type { Store } from './store';
import type { Cookies } from './cookies';
import type { ProxyResolver } from './proxy';
import { inspectionLifetime, prepareSubtitleMetadata, sourceChapters, verifyEmbedded, type InspectedSource } from './metadata';

interface TaskSlot { process?: Running; cancelled: boolean; interrupt?: (error: Error) => void }

export class Engine {
  playlist: Playlist | null = null;
  entries: PlaylistEntry[] = [];
  readonly preparations: Record<string, PreparationProgress> = {};
  private running = new Map<string, TaskSlot>();
  private sources = new Map<string, InspectedSource>();
  private parser?: Running;
  private parseWork?: Promise<void>;
  private parseCancelled = false;
  private stopping = false;
  paused = false;
  constructor(readonly store: Store, private tools: () => Tools, private cookies: Cookies, private proxy: ProxyResolver, private changed: () => void, private launch: typeof run = run, private limits = { cookies: 120_000, proxy: 20_000, subtitles: 120_000, starting: 120_000 }) {}
  get busy(): boolean { return this.running.size > 0 || !!this.parseWork || this.cookies.busy; }
  enqueue(urls: string[], input: DownloadOptions, source?: InspectedSource): { added: number; duplicates: number } {
    if (!Array.isArray(urls) || !urls.length) throw new Error('请输入至少一个视频链接。');
    const o = options(input);
    const validated = urls.map(videoUrl);
    const key = (url: string, directory: string, value: DownloadOptions): string => JSON.stringify([url, directory, value]);
    const known = new Set(this.store.state.tasks.filter(t => !['failed', 'cancelled'].includes(t.status)).map(t => key(t.url, t.directory, t.options)));
    let added = 0, duplicates = 0;
    for (const url of validated) {
      const identity = key(url, this.store.state.settings.directory, o);
      if (known.has(identity)) { duplicates++; continue; }
      known.add(identity);
      const task: Task = { id: randomUUID(), url, title: url, directory: this.store.state.settings.directory, options: { ...o }, status: 'queued', progress: 0, speed: '', eta: '', error: '', file: '', createdAt: new Date().toISOString() };
      this.store.state.tasks.push(task);
      if (source && o.subtitles?.length && source.url === url) {
        this.sources.set(task.id, source);
        if (this.sources.size > 5) this.sources.delete(this.sources.keys().next().value!);
      }
      added++;
    }
    this.persist();
    this.schedule();
    return { added, duplicates };
  }
  private persist(): void { this.store.save(); this.changed(); }
  schedule(): void {
    if (this.stopping || this.paused) return;
    while (this.running.size < this.store.state.settings.concurrency) {
      const task = this.store.state.tasks.find(t => t.status === 'queued' && !this.running.has(t.id));
      if (!task) break;
      const slot = { process: undefined as Running | undefined, cancelled: false };
      this.running.set(task.id, slot);
      void this.execute(task, slot).catch(e => {
        this.store.warning = `任务状态保存失败：${errorMessage(e)}。已暂停调度，请检查磁盘并重启。`;
        this.paused = true;
        this.changed();
      });
    }
  }
  private async stage<T>(t: Task, slot: TaskSlot, stage: PreparationProgress['stage'], operation: () => Promise<T>, stop?: (pending: Promise<T>) => Promise<void>): Promise<T> {
    const messages = { cookies: '准备 Cookie 超时，请检查 Chrome 授权或尝试手动刷新缓存。', proxy: '解析系统代理超时，请检查 PAC 或手动设置代理。', subtitles: '读取字幕信息超时，请检查平台访问和登录状态。', starting: '下载引擎启动或读取下载地址超时，请检查网络、代理或重新解析。' };
    const timeoutMs = this.limits[stage];
    this.preparations[t.id] = { stage, startedAt: Date.now(), timeoutMs }; this.changed();
    let timer: NodeJS.Timeout | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      slot.interrupt = reject;
      timer = setTimeout(() => reject(new Error(messages[stage])), timeoutMs);
    });
    const pending = Promise.resolve().then(() => {
      if (slot.cancelled || this.stopping) throw new Error('任务准备已取消。');
      return operation();
    });
    try { return await Promise.race([pending, interrupted]); }
    catch (error) {
      if (stop) await stop(pending);
      throw error;
    } finally {
      clearTimeout(timer); slot.interrupt = undefined;
      delete this.preparations[t.id]; this.changed();
    }
  }
  private async execute(t: Task, slot: TaskSlot): Promise<void> {
    const source = this.sources.get(t.id); this.sources.delete(t.id);
    let reused = false;
    try {
      t.status = 'syncing';
      t.error = '';
      this.persist();
      await mkdir(t.directory, { recursive: true });
      await this.cookies.withSnapshot(t.options.cookie, t.id, async cookie => {
        reused = false;
        const proxy = await this.stage(t, slot, 'proxy', async () => this.proxy(t.url));
        if (slot.cancelled || this.stopping) return;
        let metadata: Record<string, unknown> | undefined;
        const subtitles = t.options.subtitles;
        if (subtitles?.length) {
          await this.stage(t, slot, 'subtitles', async () => {
            const age = source ? Date.now() - source.inspectedAt : Infinity;
            if (source && source.url === t.url && source.proxy === proxy && age >= 0 && age < inspectionLifetime &&
                source.cookieIdentity === await this.cookies.snapshotIdentity(t.options.cookie, cookie)) {
              metadata = prepareSubtitleMetadata(source.raw, subtitles);
              reused = true;
              return;
            }
            let raw: unknown;
            const inspect = this.launch(this.tools().yt, [...commonArgs(this.tools(), proxy, cookie), '--no-playlist', '--skip-download', '--dump-json', '--', t.url], line => {
              if (!line.startsWith('{')) return;
              if (raw !== undefined) throw new Error('字幕解析意外返回多个视频。');
              raw = JSON.parse(line);
            });
            slot.process = inspect;
            await inspect.done;
            metadata = prepareSubtitleMetadata(raw, subtitles);
          }, async () => { await slot.process?.stop(); });
          if (slot.cancelled || this.stopping) return;
        }
        let chapters: Chapter[] = [];
        const args = downloadArgs(t, this.tools(), proxy, cookie);
        let proc: Running | undefined;
        await this.stage(t, slot, 'starting', async () => {
          let ready!: () => void;
          const started = new Promise<void>(resolve => { ready = resolve; });
          proc = this.launch(this.tools().yt, metadata ? [...args.slice(0, -2), '--load-info-json', '-'] : args, line => {
            if (/^(STAGE:|DL:|PP:|INFO:|FILE:)/.test(line)) ready();
            if ((line.startsWith('INFO:') || line.startsWith('DL:')) && t.status === 'syncing') t.status = 'downloading';
            if (line.startsWith('STAGE:')) {
              t.status = 'processing';
              this.persist();
            } else if (line.startsWith('DL:') || line.startsWith('PP:')) {
              const p = JSON.parse(line.slice(3)) as Record<string, unknown>;
              if (line.startsWith('PP:')) t.status = 'processing';
              const downloaded = Number(p.downloaded_bytes), total = Number(p.total_bytes || p.total_bytes_estimate);
              if (Number.isFinite(total) && total > 0 && Number.isFinite(downloaded)) t.progress = Math.min(100, Math.max(0, downloaded / total * 100));
              t.speed = typeof p._speed_str === 'string' ? p._speed_str.trim() : '';
              t.eta = typeof p._eta_str === 'string' ? p._eta_str.trim() : '';
              this.changed();
            } else if (line.startsWith('INFO:')) {
              const info = JSON.parse(line.slice(5)) as Record<string, unknown>;
              if (typeof info.title === 'string') t.title = info.title;
              if (t.options.embedChapters) chapters = sourceChapters(info);
              this.persist();
            } else if (line.startsWith('FILE:')) {
              const filename: unknown = JSON.parse(line.slice(5));
              if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
                  path.dirname(path.resolve(filename)) !== path.resolve(t.directory)) throw new Error('引擎返回了无效的输出路径。');
              t.file = filename;
            }
          }, undefined, metadata ? JSON.stringify(metadata) : undefined);
          slot.process = proc;
          await Promise.race([started, proc.done]);
        }, async () => { await slot.process?.stop(); });
        if (!proc) throw new Error('下载引擎未启动。');
        await proc.done;
        if (slot.cancelled || this.stopping) return;
        if (!t.file || !(await stat(t.file)).isFile() || (await stat(t.file)).size === 0) throw new Error('引擎未生成有效文件，不能标记下载成功。');
        if (chapters.length || t.options.subtitles?.length) {
          t.status = 'processing'; this.persist();
          let probe = '';
          const verify = this.launch(this.tools().ffprobe, ['-v', 'error', '-show_streams', '-show_chapters', '-of', 'json', t.file], line => { probe += line; });
          slot.process = verify;
          await verify.done;
          if (slot.cancelled || this.stopping) return;
          verifyEmbedded(JSON.parse(probe), t.options.subtitles || [], chapters);
        }
      }, () => {
        t.status = 'syncing'; t.file = ''; t.progress = 0; t.speed = ''; t.eta = '';
        this.persist();
        return this.stage(t, slot, 'cookies', () => this.cookies.snapshot(t.options.cookie, t.id), async pending => {
          await this.cookies.cancelSnapshot(t.id);
          await this.cookies.removeSnapshot(await pending.catch(() => ''));
        });
      });
      if (slot.cancelled || this.stopping) return;
      t.status = 'completed';
      t.progress = 100;
    } catch (e) {
      if (!slot.cancelled && !this.stopping) {
        const message = errorMessage(e);
        const merging = t.options.selection?.video && t.options.selection.audio && (t.status === 'processing' || /postprocessing|merger|muxer/i.test(message));
        t.status = 'failed';
        t.error = message + (merging ? ` 合并为 ${(t.options.mergeFormat || 'mkv').toUpperCase()} 失败，不会自动转码或更换编码。若容器不兼容，请改选 MKV 后重新创建任务。` : '') +
          (t.options.subtitles?.length ? ' 字幕下载或内挂失败时不会报告成功；容器不兼容请改用 MKV，不会自动切换容器。' : '') +
          (reused ? ' 如下载地址已失效，请重新解析视频后创建任务。' : '') +
          (t.options.cookie !== 'none' ? ' 若提示登录或 Cookie 过期，请在 Chrome 重新登录，再同步/重新导出后重试。' : '');
      }
    } finally {
      if (this.stopping) t.status = 'interrupted';
      else if (slot.cancelled) t.status = 'cancelled';
      delete this.preparations[t.id];
      this.running.delete(t.id);
      this.persist();
      this.schedule();
    }
  }
  async cancel(id: string): Promise<void> {
    const t = this.task(id);
    const slot = this.running.get(id);
    if (slot) {
      slot.cancelled = true;
      slot.interrupt?.(new Error('任务准备已取消。'));
      await this.cookies.cancelSnapshot(id);
      if (slot.process) await slot.process.stop();
    } else if (t.status === 'queued') { t.status = 'cancelled'; this.sources.delete(id); }
    this.persist();
  }
  retry(id: string): void {
    const t = this.task(id);
    if (!['failed', 'cancelled', 'interrupted'].includes(t.status) || this.running.has(id)) throw new Error('只能重试失败、取消或中断的任务。');
    t.status = 'queued'; t.error = ''; t.file = '';
    this.persist(); this.schedule();
  }
  task(id: string): Task {
    const t = this.store.state.tasks.find(t => t.id === id);
    if (!t) throw new Error('未找到任务。');
    return t;
  }
  clearFinished(): void {
    this.store.state.tasks = this.store.state.tasks.filter(t => !['completed', 'failed', 'cancelled'].includes(t.status) || this.running.has(t.id));
    this.persist();
  }
  parse(url: string, cookie: CookieMode): void {
    if (this.parseWork || this.paused || this.stopping) throw new Error('正在解析或更新，请稍后再试。');
    const validated = videoUrl(url);
    if (!['none', 'chrome', 'file'].includes(cookie)) throw new Error('Cookie 来源无效。');
    this.entries = [];
    this.playlist = { id: randomUUID(), status: 'running', count: 0, error: '' };
    this.parseCancelled = false;
    this.parseWork = this.parseRun(validated, cookie);
    this.changed();
  }
  private async parseRun(url: string, mode: CookieMode): Promise<void> {
    const list = this.playlist!;
    try {
      await this.cookies.withSnapshot(mode, list.id, async cookie => {
        this.entries = []; list.count = 0; list.error = ''; this.changed();
        const proxy = await this.proxy(url);
        if (this.parseCancelled || this.stopping) return;
        this.parser = this.launch(this.tools().yt, [...commonArgs(this.tools(), proxy, cookie), '--flat-playlist', '--lazy-playlist', '--skip-download', '--dump-json', '--yes-playlist', '--', url], line => {
          if (!line.startsWith('{')) return;
          const raw = JSON.parse(line) as Record<string, unknown>;
          const candidate = raw.webpage_url || raw.url || (raw.ie_key === 'Youtube' ? `https://www.youtube.com/watch?v=${raw.id}` : '');
          if (typeof candidate !== 'string' || typeof raw.id !== 'string') throw new Error('播放列表条目缺少有效链接。');
          const entry: PlaylistEntry = { id: `${list.id}:${this.entries.length}`, url: videoUrl(candidate), title: typeof raw.title === 'string' ? raw.title : raw.id };
          this.entries.push(entry);
          list.count = this.entries.length;
          if (list.count % 20 === 0) this.changed();
        });
        await this.parser.done;
        if (!this.entries.length) throw new Error('未发现可下载条目；此平台可能不支持该播放列表。');
      });
      list.status = 'completed';
    } catch (e) { list.status = 'failed'; list.error = `${errorMessage(e)} 已解析条目可单独选择下载，结果不是完整列表。`; }
    finally {
      if (this.parseCancelled || this.stopping) list.status = 'cancelled';
      this.parser = undefined; this.parseWork = undefined; this.changed();
    }
  }
  async stopParse(): Promise<void> {
    this.parseCancelled = true;
    if (this.parseWork && this.playlist) await this.cookies.cancelSnapshot(this.playlist.id);
    if (this.parser) await this.parser.stop();
    await this.parseWork;
  }
  enqueueEntries(ids: string[], all: boolean, o: DownloadOptions): { added: number; duplicates: number } {
    return this.enqueue(this.selectedEntries(ids, all).map(e => e.url), o);
  }
  selectedEntries(ids: string[], all: boolean): PlaylistEntry[] {
    if (!this.playlist || this.playlist.status === 'running') throw new Error('请等待解析完成或停止解析后选择。');
    const requested = new Set(ids);
    const selected = all ? this.entries : this.entries.filter(e => requested.has(e.id));
    if (!selected.length) throw new Error('请勾选要下载的条目。');
    return selected;
  }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const slot of this.running.values()) slot.interrupt?.(new Error('程序退出，已停止任务准备。'));
    await this.cookies.stop();
    await this.stopParse();
    for (const slot of this.running.values()) if (slot.process) await slot.process.stop();
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 30));
    this.sources.clear();
    this.store.save();
  }
}
