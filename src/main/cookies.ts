import { chmod, copyFile, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
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
  readonly root: string;
  constructor(private store: Store, private yt: () => string, private changed: () => void, private launch: typeof run = run) {
    this.root = path.join(store.root, 'cookies');
    this.info = { file: false, watching: false, chromeAuthorized: store.state.settings.chromeAuthorized, chromeProfile: store.state.settings.chromeProfile, lastFileSync: '', lastChromeSync: '', fileError: '', chromeError: '' };
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.then(() => {}, () => {});
    return result;
  }
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    for (const file of await readdir(this.root)) {
      if (/^(?:manual|[a-f0-9-]{36})(?:-[a-f0-9-]{36})?(?:\.chrome)?\.(?:txt|tmp)$/.test(file)) await this.removeSnapshot(path.join(this.root, file));
    }
    try { validateCookies(await readFile(path.join(this.root, 'file.txt'), 'utf8')); this.info.file = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.info.fileError = errorMessage(e); }
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
    this.info.chromeProfile = profile;
    this.info.chromeAuthorized = true;
    this.store.state.settings.chromeAuthorized = true;
    this.store.state.settings.chromeProfile = profile;
    this.store.save();
    this.changed();
  }
  async revoke(): Promise<void> {
    this.info.chromeAuthorized = false;
    this.store.state.settings.chromeAuthorized = false;
    this.generation.chrome++;
    this.store.save();
    if (this.active) await this.active.stop();
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
  async snapshot(mode: CookieMode, id: string): Promise<string> {
    if (mode === 'none') return '';
    const generation = this.generation[mode];
    return this.exclusive(async () => {
      if (this.stopping || this.cancelled.has(id)) {
        this.cancelled.delete(id);
        throw new Error('Cookie 同步已取消。');
      }
      const target = path.join(this.root, `${id}-${randomUUID()}.txt`);
      try {
        if (mode === 'chrome') {
          if (!this.info.chromeAuthorized) throw new Error('尚未授权 Chrome Cookie 读取，请在设置中授权或导入文件。');
          const temp = path.join(this.root, `${randomUUID()}.chrome.txt`);
          try {
            this.activeId = id;
            // This command opens/closes YoutubeDL and saves its browser cookie jar without visiting a site.
            this.active = this.launch(this.yt(), ['--ignore-config', '--no-plugin-dirs', '--no-colors', '--cookies-from-browser', `chrome:${this.info.chromeProfile}`, '--cookies', temp, '--list-impersonate-targets']);
            await this.active.done;
            const diagnostics = this.active.diagnostics();
            if (/warning|error/i.test(diagnostics) && /decrypt|keyring|keychain|permission|locked|cookie/i.test(diagnostics)) throw new Error(`Chrome Cookie 未完整读取：${diagnostics}`);
            if (this.cancelled.has(id)) throw new Error('Cookie 同步已取消。');
            if (generation !== this.generation.chrome || !this.info.chromeAuthorized) throw new Error('Chrome 授权已撤销，请重新选择 Cookie 来源。');
            await this.writePrivate(path.basename(target), validateCookies(await readFile(temp, 'utf8')));
            this.info.lastChromeSync = new Date().toISOString();
            this.info.chromeError = '';
          } finally {
            this.active = undefined;
            this.activeId = '';
            await unlink(temp).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
          }
        } else {
          if (!this.info.file) throw new Error('请先导入 cookies.txt。');
          if (this.info.fileError) throw new Error(`Cookie 自动同步失败，请重新导入：${this.info.fileError}`);
          await copyFile(path.join(this.root, 'file.txt'), target);
          await chmod(target, 0o600);
        }
        if (this.cancelled.has(id)) throw new Error('Cookie 同步已取消。');
        if (generation !== this.generation[mode]) throw new Error('Cookie 授权或来源已改变，请重试。');
        this.changed();
        return target;
      } catch (e) {
        if (mode === 'chrome') this.info.chromeError = `${errorMessage(e)} 请检查 Chrome 配置/钥匙串权限；Windows 加密保护可能阻止读取，请改为手动导入。`;
        else this.info.fileError = errorMessage(e);
        await this.removeSnapshot(target);
        this.changed();
        throw new Error(mode === 'chrome' ? this.info.chromeError : this.info.fileError);
      } finally { this.cancelled.delete(id); }
    });
  }
  async cancelSnapshot(id: string): Promise<void> {
    this.cancelled.add(id);
    if (this.activeId === id && this.active) await this.active.stop();
  }
  async sync(mode: CookieMode): Promise<void> {
    if (mode === 'file') {
      if (!this.store.state.cookieSource) throw new Error('请先导入 Cookie 文件。');
      await this.importFile(this.store.state.cookieSource, this.store.state.settings.watchCookies);
    } else if (mode === 'chrome') {
      const filename = await this.snapshot(mode, 'manual');
      await this.removeSnapshot(filename);
    } else throw new Error('请选择文件或 Chrome Cookie 来源。');
  }
  async removeSnapshot(filename: string): Promise<void> {
    if (!filename) return;
    await unlink(filename).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
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
