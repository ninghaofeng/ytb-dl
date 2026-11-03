import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CookieMode, DownloadOptions, Playlist, PlaylistEntry, Task } from '../shared/types';
import { commonArgs, downloadArgs, type Tools } from './arguments';
import { run, type Running } from './process';
import { options, videoUrl, errorMessage } from './validation';
import type { Store } from './store';
import type { Cookies } from './cookies';
import type { ProxyResolver } from './proxy';

export class Engine {
  playlist: Playlist | null = null;
  entries: PlaylistEntry[] = [];
  private running = new Map<string, { process?: Running; cancelled: boolean }>();
  private parser?: Running;
  private parseWork?: Promise<void>;
  private parseCancelled = false;
  private stopping = false;
  paused = false;
  constructor(readonly store: Store, private tools: () => Tools, private cookies: Cookies, private proxy: ProxyResolver, private changed: () => void, private launch: typeof run = run) {}
  get busy(): boolean { return this.running.size > 0 || !!this.parseWork || this.cookies.busy; }
  enqueue(urls: string[], input: DownloadOptions): { added: number; duplicates: number } {
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
      this.store.state.tasks.push({ id: randomUUID(), url, title: url, directory: this.store.state.settings.directory, options: { ...o }, status: 'queued', progress: 0, speed: '', eta: '', error: '', file: '', createdAt: new Date().toISOString() });
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
  private async execute(t: Task, slot: { process?: Running; cancelled: boolean }): Promise<void> {
    let cookie = '';
    try {
      t.status = 'syncing';
      t.error = '';
      this.persist();
      await mkdir(t.directory, { recursive: true });
      cookie = await this.cookies.snapshot(t.options.cookie, t.id);
      const proxy = await this.proxy(t.url);
      if (slot.cancelled || this.stopping) return;
      t.status = 'downloading';
      this.persist();
      const proc = this.launch(this.tools().yt, downloadArgs(t, this.tools(), proxy, cookie), line => {
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
          this.persist();
        } else if (line.startsWith('FILE:')) {
          const filename: unknown = JSON.parse(line.slice(5));
          if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
              path.dirname(path.resolve(filename)) !== path.resolve(t.directory)) throw new Error('引擎返回了无效的输出路径。');
          t.file = filename;
        }
      });
      slot.process = proc;
      await proc.done;
      if (slot.cancelled || this.stopping) return;
      if (!t.file || !(await stat(t.file)).isFile() || (await stat(t.file)).size === 0) throw new Error('引擎未生成有效文件，不能标记下载成功。');
      t.status = 'completed';
      t.progress = 100;
    } catch (e) {
      if (!slot.cancelled && !this.stopping) {
        const message = errorMessage(e);
        const merging = t.options.selection?.video && t.options.selection.audio && (t.status === 'processing' || /postprocessing|merger|muxer/i.test(message));
        t.status = 'failed';
        t.error = message + (merging ? ` 合并为 ${(t.options.mergeFormat || 'mkv').toUpperCase()} 失败，不会自动转码或更换编码。若容器不兼容，请改选 MKV 后重新创建任务。` : '') + (t.options.cookie !== 'none' ? ' 若提示登录或 Cookie 过期，请在 Chrome 重新登录，再同步/重新导出后重试。' : '');
      }
    } finally {
      if (this.stopping) t.status = 'interrupted';
      else if (slot.cancelled) t.status = 'cancelled';
      try { await this.cookies.removeSnapshot(cookie); }
      catch (e) { t.error = `Cookie 临时文件清理失败：${errorMessage(e)}`; }
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
      if (slot.process) await slot.process.stop();
      else await this.cookies.cancelSnapshot(id);
    } else if (t.status === 'queued') t.status = 'cancelled';
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
    let cookie = '';
    const list = this.playlist!;
    try {
      cookie = await this.cookies.snapshot(mode, list.id);
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
      list.status = 'completed';
    } catch (e) { list.status = 'failed'; list.error = `${errorMessage(e)} 已解析条目可单独选择下载，结果不是完整列表。`; }
    finally {
      if (this.parseCancelled || this.stopping) list.status = 'cancelled';
      try { await this.cookies.removeSnapshot(cookie); }
      catch (e) { list.error = `Cookie 清理失败：${errorMessage(e)}`; }
      this.parser = undefined; this.parseWork = undefined; this.changed();
    }
  }
  async stopParse(): Promise<void> {
    this.parseCancelled = true;
    if (this.parser) await this.parser.stop();
    else if (this.parseWork && this.playlist) await this.cookies.cancelSnapshot(this.playlist.id);
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
    await this.cookies.stop();
    await this.stopParse();
    for (const slot of this.running.values()) if (slot.process) await slot.process.stop();
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 30));
    this.store.save();
  }
}
