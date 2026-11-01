import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readKeys, readSignature, createMessage, verify } from 'openpgp';
import type { Store } from './store';
import type { UpdateInfo } from '../shared/types';
import { download } from './network';
import { run } from './process';
import { errorMessage } from './validation';

export const KEY_FINGERPRINT = 'ac0cbbe6848d6a873464af4e57cf65933b5a7581';
export const BUNDLED_YT_VERSION = '2026.10.26';
export const assetName = (platform: string, arch: string): string => {
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return 'yt-dlp_macos';
  if (platform === 'win32' && arch === 'x64') return 'yt-dlp.exe';
  if (platform === 'win32' && arch === 'arm64') return 'yt-dlp_arm64.exe';
  throw new Error(`不支持的系统架构：${platform}/${arch}`);
};
export async function verifyManifest(manifest: Buffer, signature: Buffer, keyText: string): Promise<void> {
  const keys = await readKeys({ armoredKeys: keyText });
  const key = keys.find(k => k.getFingerprint() === KEY_FINGERPRINT);
  if (!key) throw new Error('上游签名公钥指纹不匹配。');
  const sig = signature.toString().startsWith('-----BEGIN') ? await readSignature({ armoredSignature: signature.toString() }) : await readSignature({ binarySignature: signature });
  const result = await verify({ message: await createMessage({ binary: manifest }), signature: sig, verificationKeys: key });
  if (!result.signatures.length) throw new Error('更新缺少签名。');
  for (const s of result.signatures) await s.verified;
}
export function verifyChecksum(data: Buffer, manifest: string, name: string): void {
  const line = manifest.split('\n').find(l => l.trim().split(/\s+/).slice(1).join(' ').replace(/^\*/, '') === name);
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || createHash('sha256').update(data).digest('hex') !== expected.toLowerCase()) throw new Error(`资源校验失败：${name}`);
}
interface Release { tag_name: string; assets: { name: string; browser_download_url: string }[] }
export class Updates {
  info: UpdateInfo;
  private release?: Release;
  private checking?: Promise<void>;
  private operation?: Promise<void>;
  private root: string;
  constructor(private store: Store, private bundled: string, private key: string, private proxy: () => string, private busy: () => boolean, private pause: (paused: boolean) => void, private changed: () => void, private fetchResource: typeof download = download) {
    this.root = path.join(store.root, 'engines');
    this.info = { current: store.state.engine || BUNDLED_YT_VERSION, latest: '', previous: store.state.previousEngine, status: 'idle', error: '' };
  }
  private executable(version: string): string {
    if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(version)) throw new Error('引擎版本标识无效。');
    return path.join(this.root, version, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  }
  yt(): string { return this.store.state.engine ? this.executable(this.store.state.engine) : this.bundled; }
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (this.store.state.engine) {
      try { await stat(this.yt()); await this.checkBinary(this.yt(), this.store.state.engine); }
      catch (e) {
        this.info.error = `已安装引擎不可用，已恢复包内版本：${errorMessage(e)}`;
        this.info.status = 'error';
        this.store.state.engine = '';
        this.info.current = BUNDLED_YT_VERSION;
        this.store.save();
      }
    }
  }
  private async checkBinary(filename: string, expected: string): Promise<void> {
    let version = '';
    const proc = run(filename, ['--version'], line => { version += line; });
    const timeout = setTimeout(() => { void proc.stop().catch(e => { this.info.error = errorMessage(e); }); }, 120_000);
    try { await proc.done; } finally { clearTimeout(timeout); }
    if (version.trim() !== expected) throw new Error('引擎版本检查不匹配。');
  }
  async check(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.operation || this.info.status === 'waiting') throw new Error('已有待安装更新。');
    this.checking = this.checkRun();
    try { await this.checking; } finally { this.checking = undefined; }
  }
  private async checkRun(): Promise<void> {
    this.info.status = 'checking'; this.info.error = ''; this.changed();
    try {
      const raw: unknown = JSON.parse((await this.fetchResource('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', this.proxy(), 4 * 1024 * 1024)).toString());
      if (!raw || typeof raw !== 'object') throw new Error('版本服务返回无效数据。');
      const r = raw as Release;
      if (!/^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/.test(r.tag_name) || !Array.isArray(r.assets)) throw new Error('上游版本信息无效。');
      const name = assetName(process.platform, process.arch);
      if (!r.assets.some(a => a.name === name)) throw new Error('上游没有对应架构的更新文件。');
      this.release = r; this.info.latest = r.tag_name;
      this.info.status = r.tag_name !== this.info.current ? 'available' : 'idle';
    } catch (e) { this.info.status = 'error'; this.info.error = errorMessage(e); throw e; }
    finally { this.changed(); }
  }
  install(): void {
    if (!this.release || this.release.tag_name === this.info.current) throw new Error('请先检查可用更新。');
    if (this.operation || this.info.status === 'waiting') throw new Error('更新已在等待或安装。');
    this.info.status = 'waiting'; this.changed(); this.tick();
  }
  tick(): void {
    if (this.info.status !== 'waiting' || this.busy()) return;
    this.pause(true);
    this.operation = this.installRun().catch(e => {
      this.info.status = 'error'; this.info.error = `更新清理失败：${errorMessage(e)}`;
    }).finally(() => { this.operation = undefined; this.pause(false); this.changed(); });
  }
  private async installRun(): Promise<void> {
    const release = this.release!;
    const temp = path.join(this.root, `temp-${randomUUID()}`);
    this.info.status = 'installing'; this.info.error = ''; this.changed();
    try {
      const name = assetName(process.platform, process.arch);
      const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/`;
      const [manifest, signature, binary, key] = await Promise.all([
        this.fetchResource(`${base}SHA2-256SUMS`, this.proxy(), 1024 * 1024),
        this.fetchResource(`${base}SHA2-256SUMS.sig`, this.proxy(), 1024 * 1024),
        this.fetchResource(`${base}${name}`, this.proxy()),
        readFile(this.key, 'utf8')
      ]);
      await verifyManifest(manifest, signature, key);
      verifyChecksum(binary, manifest.toString(), name);
      await mkdir(temp, { mode: 0o700 });
      const exe = path.join(temp, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
      await writeFile(exe, binary, { mode: 0o700 }); await chmod(exe, 0o700);
      await this.checkBinary(exe, release.tag_name);
      const directory = path.dirname(this.executable(release.tag_name));
      await rm(directory, { recursive: true, force: true });
      await rename(temp, directory);
      const oldEngine = this.store.state.engine, oldPrevious = this.store.state.previousEngine;
      this.store.state.previousEngine = oldEngine || BUNDLED_YT_VERSION;
      this.store.state.engine = release.tag_name;
      try { this.store.save(); }
      catch (error) { this.store.state.engine = oldEngine; this.store.state.previousEngine = oldPrevious; throw error; }
      this.info.current = release.tag_name; this.info.previous = this.store.state.previousEngine; this.info.status = 'idle';
    } catch (e) { this.info.status = 'error'; this.info.error = `更新未安装，保留旧版本：${errorMessage(e)}`; }
    finally { await rm(temp, { recursive: true, force: true }); this.changed(); }
  }
  async rollback(): Promise<void> {
    if (this.busy() || this.operation || this.info.status === 'waiting') throw new Error('请等待下载/解析/更新结束再回滚。');
    const previous = this.store.state.previousEngine;
    if (!previous) throw new Error('没有可回滚版本。');
    this.pause(true);
    try {
      await this.checkBinary(previous === BUNDLED_YT_VERSION ? this.bundled : this.executable(previous), previous);
      const current = this.store.state.engine || BUNDLED_YT_VERSION;
      const oldEngine = this.store.state.engine, oldPrevious = this.store.state.previousEngine;
      this.store.state.engine = previous === BUNDLED_YT_VERSION ? '' : previous;
      this.store.state.previousEngine = current;
      try { this.store.save(); }
      catch (error) { this.store.state.engine = oldEngine; this.store.state.previousEngine = oldPrevious; throw error; }
      this.info.current = previous; this.info.previous = current; this.info.status = 'idle'; this.info.error = '';
    } finally { this.pause(false); this.changed(); }
  }
  async stop(): Promise<void> { await this.checking; await this.operation; }
}
