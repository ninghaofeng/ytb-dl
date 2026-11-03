import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs';
import type { CookieInfo, CookieMode } from '../shared/types';
import type { Store } from './store';
import { run, type Running } from './process';
import { errorMessage } from './validation';

export function validateCookies(text: string): string {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024 || !/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/m.test(text)) throw new Error('Cookie 必须是 Netscape cookies.txt 格式，不能是 JSON。');
  const lines = text.split(/\r?\n/);
  let count = 0;
  const selected = ['# Netscape HTTP Cookie File'];
  for (const line of lines) {
    if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const fields = line.split('\t');
    if (fields.length !== 7 || !/^(TRUE|FALSE)$/.test(fields[1]!) || !/^(TRUE|FALSE)$/.test(fields[3]!) || !/^\d+$/.test(fields[4]!)) throw new Error('Cookie 文件未完整写入或格式无效，请重新导出。');
    const host = fields[0]!.replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
    if (['youtube.com', 'google.com', 'youtu.be', 'douyin.com', 'iesdouyin.com', 'tiktok.com'].some(d => host === d || host.endsWith(`.${d}`))) {
      count++;
      selected.push(line);
    }
  }
  if (!count) throw new Error('文件内没有目标平台的 Cookie，请在 Chrome 登录后重新导出。');
  return `${selected.join('\n')}\n`;
}
const sessionLifetime = 6 * 60 * 60 * 1000;
const maxUnixSeconds = 8_640_000_000_000n;
const chromiumEpochOffset = 11_644_473_600n;
interface ChromeCache { version: 1; id: string; profile: string; createdAt: number; expiresAt: number; text: string }
export function chromeCache(profile: string, text: string, now: number): ChromeCache {
  const valid = validateCookies(text).trimEnd().split('\n').slice(1);
  let expiresAt = Infinity;
  const retained: string[] = [];
  for (const line of valid) {
    const fields = line.split('\t'), raw = fields[4]!;
    if (raw.length > 20) throw new Error('Chrome Cookie 到期时间无效，请重新读取或导出。');
    let seconds = BigInt(raw);
    if (seconds > maxUnixSeconds) {
      // Some yt-dlp Chrome exports retain Chromium's microsecond/1601 timestamp.
      seconds = seconds / 1_000_000n - chromiumEpochOffset;
      if (seconds > maxUnixSeconds) throw new Error('Chrome Cookie 到期时间无效，请重新读取或导出。');
      if (seconds <= 0) continue;
    }
    const expires = Number(seconds) * 1000;
    if (expires > 0 && expires <= now) continue;
    expiresAt = Math.min(expiresAt, expires || now + sessionLifetime);
    fields[4] = seconds.toString();
    retained.push(fields.join('\t'));
  }
  if (!retained.length || !Number.isFinite(expiresAt)) throw new Error('Chrome 中的目标平台 Cookie 均已过期，请在 Chrome 重新登录。');
  return { version: 1, id: randomUUID(), profile, createdAt: now, expiresAt, text: `# Netscape HTTP Cookie File\n${retained.join('\n')}\n` };
}
export function chromeAuthenticationExpired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError || /not a (?:bot|robot)|captcha|verif(?:y|ication)|confirm (?:your|you)|age.restrict|private video|members.only|geo.restrict|proxy|407|ETIMEDOUT|ECONN|ENOTFOUND|HTTP(?: Error)? (?:429|5\d\d)/i.test(message)) return false;
  return /(?:cookies?|session|authentication)[^\n]{0,100}(?:expired|no longer valid|invalid|revoked)|(?:expired|invalid)[^\n]{0,60}(?:cookies?|session)|(?:login|log[ -]?in|authentication) (?:is )?required|(?:you (?:must|need to|have to)|please) (?:be logged in|log in|login|sign in)|only available (?:for|to) (?:registered|logged.in) users/i.test(message);
}
export function chromeRoot(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
  return path.join(os.homedir(), '.config/google-chrome');
}
export class Cookies {
  info: CookieInfo;
  private watcher?: FSWatcher;
  private watchedSource = '';
  private timer?: NodeJS.Timeout;
  private serial: Promise<void> = Promise.resolve();
  private generation = { file: 0, chrome: 0 };
  private active?: Running;
  private activeId = '';
  private cancelled = new Set<string>();
  private stopping = false;
  private cache?: ChromeCache;
  private snapshotVersions = new Map<string, string>();
  private queuedSnapshots = new Map<string, Set<() => void>>();
  readonly root: string;
  constructor(private store: Store, private yt: () => string, private changed: () => void, private launch: typeof run = run, private now = Date.now) {
    this.root = path.join(store.root, 'cookies');
    this.info = { file: false, watching: false, chromeAuthorized: store.state.settings.chromeAuthorized, chromeProfile: store.state.settings.chromeProfile, lastFileSync: '', lastChromeSync: '', chromeCacheExpiresAt: '', fileError: '', chromeError: '' };
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => {}, () => {});
    return result;
  }
  private snapshotWork<T>(id: string, work: () => Promise<T>): Promise<T> {
    let started = false, cancelled = false;
    let cancel!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => {
        if (started) return;
        cancelled = true;
        reject(new Error('Cookie 同步已取消。'));
      };
    });
    const owners = this.queuedSnapshots.get(id) || new Set<() => void>();
    owners.add(cancel); this.queuedSnapshots.set(id, owners);
    const pending = this.exclusive(() => {
      started = true;
      if (cancelled) throw new Error('Cookie 同步已取消。');
      return work();
    });
    return Promise.race([pending, interrupted]).finally(() => {
      owners.delete(cancel);
      if (!owners.size) this.queuedSnapshots.delete(id);
    });
  }
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    for (const file of await readdir(this.root)) {
      if (/^(?:manual|[a-f0-9-]{36})(?:-[a-f0-9-]{36})?(?:\.chrome)?\.(?:txt|tmp)$/.test(file)) await this.removeSnapshot(path.join(this.root, file));
    }
    try { validateCookies(await readFile(path.join(this.root, 'file.txt'), 'utf8')); this.info.file = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.info.fileError = errorMessage(e); }
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(this.root, 'chrome-cache.json'), 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('缓存无效。');
      const value = raw as ChromeCache;
      if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) ||
          typeof value.profile !== 'string' || typeof value.text !== 'string' ||
          !Number.isFinite(value.createdAt) || value.createdAt > this.now() || value.createdAt < 0 ||
          chromeCache(value.profile, value.text, value.createdAt).expiresAt !== value.expiresAt) throw new Error('缓存无效。');
      if (!this.info.chromeAuthorized || value.profile !== this.info.chromeProfile) await this.clearChromeCache();
      else {
        await chmod(path.join(this.root, 'chrome-cache.json'), 0o600);
        this.cache = value;
        this.info.lastChromeSync = new Date(value.createdAt).toISOString();
        this.info.chromeCacheExpiresAt = new Date(value.expiresAt).toISOString();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.clearChromeCache();
        this.info.chromeError = 'Chrome Cookie 缓存无效或无法读取，已清除；下次使用时将重新读取 Chrome。';
      }
    }
    if (this.store.state.settings.watchCookies && this.store.state.cookieSource) {
      try { await this.importFile(this.store.state.cookieSource, true); }
      catch (e) { this.info.fileError = errorMessage(e); this.changed(); }
    }
  }
  async profiles(): Promise<string[]> {
    try {
      const entries = await readdir(chromeRoot(), { withFileTypes: true });
      return entries.filter(e => e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name)).map(e => e.name).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('未找到 Chrome 配置目录，请先安装并启动 Chrome。');
      throw e;
    }
  }
  async authorize(profile: string): Promise<void> {
    if (!(await this.profiles()).includes(profile)) throw new Error('请选择已存在的 Chrome 配置文件。');
    const changed = !this.info.chromeAuthorized || this.info.chromeProfile !== profile;
    if (changed) this.generation.chrome++;
    this.info.chromeProfile = profile;
    this.info.chromeAuthorized = true;
    this.store.state.settings.chromeAuthorized = true;
    this.store.state.settings.chromeProfile = profile;
    this.store.save();
    if (changed) {
      if (this.active) await this.active.stop();
      await this.exclusive(() => this.clearChromeCache());
      this.info.lastChromeSync = ''; this.info.chromeError = '';
    }
    this.changed();
  }
  async revoke(): Promise<void> {
    this.info.chromeAuthorized = false;
    this.store.state.settings.chromeAuthorized = false;
    this.generation.chrome++;
    this.store.save();
    if (this.active) await this.active.stop();
    await this.exclusive(() => this.clearChromeCache());
    this.info.lastChromeSync = ''; this.info.chromeError = '';
    this.changed();
  }
  async importFile(source: string, watchFile: boolean): Promise<void> {
    const generation = this.generation.file;
    const [candidate, managed] = await Promise.all([realpath(source), realpath(this.root)]);
    const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    if (watchFile && normalize(candidate).startsWith(`${normalize(managed)}${path.sep}`)) throw new Error('不能监测程序内的 Cookie 私密副本，请选择 Chrome 原始导出文件。');
    await this.exclusive(async () => {
      if (this.stopping || generation !== this.generation.file) throw new Error('Cookie 文件同步已取消。');
      const valid = validateCookies(await readFile(source, 'utf8'));
      if (generation !== this.generation.file) throw new Error('Cookie 文件同步授权已撤销。');
      await this.writePrivate('file.txt', valid);
      this.info.file = true;
      this.info.lastFileSync = new Date().toISOString();
      this.info.fileError = '';
      this.store.state.cookieSource = source;
      this.store.state.settings.watchCookies = watchFile;
      this.store.save();
      this.watchSource(watchFile);
      this.changed();
    });
  }
  private watchSource(enabled: boolean): void {
    const source = this.store.state.cookieSource;
    if (enabled && this.info.watching && this.watchedSource === source) return;
    this.watcher?.close();
    if (this.watchedSource) unwatchFile(this.watchedSource);
    this.watchedSource = '';
    if (this.timer) clearTimeout(this.timer);
    this.info.watching = false;
    if (!enabled) return;
    const reload = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.importFile(source, true).catch(e => { this.info.fileError = errorMessage(e); this.changed(); });
      }, 250);
    };
    this.watcher = watch(path.dirname(source), (_, filename) => {
      if (filename && filename.toString() !== path.basename(source)) return;
      reload();
    });
    watchFile(source, { interval: 750, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) reload();
    });
    this.watchedSource = source;
    this.watcher.on('error', e => { this.info.watching = false; this.info.fileError = errorMessage(e); this.changed(); });
    this.info.watching = true;
  }
  async clear(): Promise<void> {
    this.generation.file++;
    this.watchSource(false);
    await this.exclusive(async () => {
      this.watchSource(false);
      this.store.state.cookieSource = '';
      this.store.state.settings.watchCookies = false;
      this.info.file = false;
      this.info.fileError = '';
      await unlink(path.join(this.root, 'file.txt')).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
      this.store.save();
      this.changed();
    });
  }
  private async writePrivate(name: string, content: string): Promise<void> {
    const temp = path.join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temp, content, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path.join(this.root, name));
    } finally {
      await unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
    }
  }
  private async clearChromeCache(): Promise<void> {
    this.cache = undefined;
    this.info.chromeCacheExpiresAt = '';
    await unlink(path.join(this.root, 'chrome-cache.json')).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  }
  private async invalidateChrome(filename: string): Promise<void> {
    await this.exclusive(async () => {
      if (this.cache?.id !== this.snapshotVersions.get(filename)) return;
      await this.clearChromeCache();
      this.info.chromeError = '平台报告登录失效，已停用该 Cookie 缓存。';
      this.changed();
    });
  }
  async withSnapshot<T>(mode: CookieMode, id: string, work: (filename: string) => Promise<T>, acquire = () => this.snapshot(mode, id)): Promise<T> {
    const generation = this.generation.chrome;
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt && generation !== this.generation.chrome) throw new Error('Chrome Cookie 授权或配置已改变，不会使用其他配置自动重试。');
        let filename = '';
        try {
          filename = await acquire();
          return await work(filename);
        } catch (error) {
          if (mode !== 'chrome' || !filename || !chromeAuthenticationExpired(error) ||
              this.stopping || this.cancelled.has(id) || !this.info.chromeAuthorized || generation !== this.generation.chrome) throw error;
          await this.invalidateChrome(filename);
          if (attempt > 0) {
            this.info.chromeError = '重新读取 Chrome 后登录仍失效，请在 Chrome 重新登录后点击“立即刷新”。';
            this.changed();
            throw new Error(`${errorMessage(error)} 已自动刷新 Chrome Cookie 一次，登录仍失效，请在 Chrome 重新登录后手动刷新。`, { cause: error });
          }
        } finally { await this.removeSnapshot(filename); }
      }
    } finally { this.cancelled.delete(id); }
  }
  async snapshot(mode: CookieMode, id: string, force = false): Promise<string> {
    if (mode === 'none') return '';
    const generation = this.generation[mode];
    return this.snapshotWork(id, async () => {
      if (this.stopping || this.cancelled.has(id)) {
        this.cancelled.delete(id);
        throw new Error('Cookie 同步已取消。');
      }
      if (generation !== this.generation[mode]) throw new Error('Cookie 授权或来源已改变，请重试。');
      const target = path.join(this.root, `${id}-${randomUUID()}.txt`);
      try {
        if (mode === 'chrome') {
          if (!this.info.chromeAuthorized) throw new Error('尚未授权 Chrome Cookie 读取，请在设置中授权或导入文件。');
          if (force || (this.cache && (this.cache.profile !== this.info.chromeProfile || this.cache.expiresAt <= this.now()))) await this.clearChromeCache();
          if (!this.cache) {
            if (this.stopping || this.cancelled.has(id) || generation !== this.generation.chrome) throw new Error('Chrome Cookie 同步已取消或授权已改变。');
            const temp = path.join(this.root, `${randomUUID()}.chrome.txt`);
            try {
              this.activeId = id;
              // This command opens/closes YoutubeDL and saves its browser cookie jar without visiting a site.
              try {
                this.active = this.launch(this.yt(), ['--ignore-config', '--no-plugin-dirs', '--no-colors', '--cookies-from-browser', `chrome:${this.info.chromeProfile}`, '--cookies', temp, '--list-impersonate-targets']);
                await this.active.done;
                const diagnostics = this.active.diagnostics();
                if (/warning|error/i.test(diagnostics) && /decrypt|keyring|keychain|permission|locked|cookie/i.test(diagnostics)) throw new Error(`Chrome Cookie 未完整读取：${diagnostics}`);
              } catch (error) {
                throw new Error(`${errorMessage(error)} 请检查 Chrome 配置/钥匙串权限；Windows 加密保护可能阻止读取，请改为手动导入。`, { cause: error });
              }
              if (this.cancelled.has(id)) throw new Error('Cookie 同步已取消。');
              if (generation !== this.generation.chrome || !this.info.chromeAuthorized) throw new Error('Chrome 授权已撤销，请重新选择 Cookie 来源。');
              const cache = chromeCache(this.info.chromeProfile, await readFile(temp, 'utf8'), this.now());
              await this.writePrivate('chrome-cache.json', JSON.stringify(cache));
              this.cache = cache;
              this.info.lastChromeSync = new Date(cache.createdAt).toISOString();
              this.info.chromeCacheExpiresAt = new Date(cache.expiresAt).toISOString();
              this.info.chromeError = '';
            } finally {
              this.active = undefined;
              this.activeId = '';
              await unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
            }
          }
          await this.writePrivate(path.basename(target), this.cache.text);
          this.snapshotVersions.set(target, this.cache.id);
        } else {
          if (!this.info.file) throw new Error('请先导入 cookies.txt。');
          if (this.info.fileError) throw new Error(`Cookie 自动同步失败，请重新导入：${this.info.fileError}`);
          await copyFile(path.join(this.root, 'file.txt'), target);
          await chmod(target, 0o600);
        }
        if (this.cancelled.has(id)) throw new Error('Cookie 同步已取消。');
        if (generation !== this.generation[mode]) throw new Error('Cookie 授权或来源已改变，请重试。');
        if (mode === 'chrome') this.info.chromeError = '';
        this.changed();
        return target;
      } catch (e) {
        if (mode === 'chrome') this.info.chromeError = errorMessage(e);
        else this.info.fileError = errorMessage(e);
        await this.removeSnapshot(target);
        this.changed();
        throw new Error(mode === 'chrome' ? this.info.chromeError : this.info.fileError);
      } finally { this.cancelled.delete(id); }
    });
  }
  async cancelSnapshot(id: string): Promise<void> {
    this.cancelled.add(id);
    for (const cancel of this.queuedSnapshots.get(id) || []) cancel();
    if (this.activeId === id && this.active) await this.active.stop();
  }
  async snapshotIdentity(mode: CookieMode, filename: string): Promise<string> {
    if (mode === 'none') return 'none';
    if (mode === 'chrome') {
      const version = this.snapshotVersions.get(filename);
      if (!version) throw new Error('Chrome Cookie 副本已失效，请重新解析。');
      return `chrome:${version}`;
    }
    return `file:${this.generation.file}:${createHash('sha256').update(await readFile(filename)).digest('hex')}`;
  }
  async sync(mode: CookieMode): Promise<void> {
    if (mode === 'file') {
      if (!this.store.state.cookieSource) throw new Error('请先导入 Cookie 文件。');
      await this.importFile(this.store.state.cookieSource, this.store.state.settings.watchCookies);
    } else if (mode === 'chrome') {
      const filename = await this.snapshot(mode, 'manual', true);
      await this.removeSnapshot(filename);
    } else throw new Error('请选择文件或 Chrome Cookie 来源。');
  }
  async removeSnapshot(filename: string): Promise<void> {
    if (!filename) return;
    await unlink(filename).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
    this.snapshotVersions.delete(filename);
  }
  get busy(): boolean { return !!this.active; }
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation.file++;
    this.generation.chrome++;
    this.watchSource(false);
    if (this.active) await this.active.stop();
    await this.serial;
  }
}
