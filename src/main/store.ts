import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { options, settings, videoUrl } from './validation';
import type { Settings, Task } from '../shared/types';

export interface State {
  schema: 1;
  settings: Settings;
  tasks: Task[];
  cookieSource: string;
  proxyEncrypted: string;
  engine: string;
  previousEngine: string;
}
const statuses = ['queued', 'syncing', 'downloading', 'processing', 'completed', 'failed', 'cancelled', 'interrupted'];
export function decodeState(raw: unknown): State {
  if (!raw || typeof raw !== 'object') throw new Error('状态文件无效。');
  const v = raw as State;
  if (v.schema !== 1 || !Array.isArray(v.tasks) || !['cookieSource', 'proxyEncrypted', 'engine', 'previousEngine'].every(k => typeof (raw as Record<string, unknown>)[k] === 'string')) throw new Error('状态版本或结构无效。');
  const validated = settings(v.settings);
  const ids = new Set<string>();
  for (const t of v.tasks) {
    if (!t || !/^[a-f0-9-]{36}$/.test(t.id) || ids.has(t.id) || !statuses.includes(t.status) ||
        ![t.title, t.directory, t.speed, t.eta, t.error, t.file, t.createdAt].every(s => typeof s === 'string') ||
        typeof t.progress !== 'number' || !Number.isFinite(t.progress) || !path.isAbsolute(t.directory)) throw new Error('任务状态无效。');
    ids.add(t.id);
    videoUrl(t.url);
    options(t.options);
    if (t.file && (!path.isAbsolute(t.file) || path.dirname(path.resolve(t.file)) !== path.resolve(t.directory))) throw new Error('任务输出路径不在登记目录内。');
  }
  return { ...v, settings: validated };
}
export class Store {
  state: State;
  warning = '';
  private filename: string;
  constructor(readonly root: string, directory: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.filename = path.join(root, 'state.json');
    this.state = { schema: 1, settings: { directory, concurrency: 3, checkUpdates: true, chromeProfile: 'Default', chromeAuthorized: false, watchCookies: false }, tasks: [], cookieSource: '', proxyEncrypted: '', engine: '', previousEngine: '' };
    if (existsSync(this.filename)) {
      try { this.state = decodeState(JSON.parse(readFileSync(this.filename, 'utf8'))); }
      catch (error) {
        const corrupted = `${this.filename}.corrupt-${Date.now()}`;
        copyFileSync(this.filename, corrupted);
        this.warning = `状态文件损坏，已保留诊断副本：${path.basename(corrupted)}。`;
        if (existsSync(`${this.filename}.bak`)) {
          try { this.state = decodeState(JSON.parse(readFileSync(`${this.filename}.bak`, 'utf8'))); this.warning += ' 已恢复备份，请核对任务。'; }
          catch { throw new Error(`${this.warning} 备份也无效，请手动处理后重启。`, { cause: error }); }
        } else throw new Error(`${this.warning} 无可用备份，请手动处理后重启。`, { cause: error });
      }
    }
    for (const t of this.state.tasks) {
      if (['syncing', 'downloading', 'processing', 'interrupted'].includes(t.status)) {
        t.status = 'queued';
        t.error = '已恢复中断任务；部分文件有效时续传，否则可能重新下载。';
      }
    }
  }
  save(): void {
    const temp = `${this.filename}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(temp, 0o600);
    if (existsSync(this.filename)) copyFileSync(this.filename, `${this.filename}.bak`);
    renameSync(temp, this.filename);
  }
}
