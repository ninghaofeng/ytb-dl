import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { run } from '../src/main/process';

async function main(): Promise<void> {
  const native = `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`;
  const supported = ['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64'];
  const requested = process.argv.slice(2);
  const targets = requested.length === 1 && requested[0] === '--all' ? supported : requested.length ? requested : [native];
  if (!targets.every(target => supported.includes(target))) throw new Error('用法：check-tools.ts [--all | mac-arm64 mac-x64 win-x64 win-arm64]');
  for (const target of targets) {
    const root = path.resolve('resources', target);
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as { platform: string; arch: string; files: { file: string; sha256: string }[] };
    if (`${manifest.platform}-${manifest.arch}` !== target) throw new Error('资源架构与目标不匹配。');
    const names = ['yt-dlp', 'ffmpeg', 'ffprobe', 'node'];
    for (const name of names) if (!manifest.files.some(record => record.file === name + (manifest.platform === 'win' ? '.exe' : ''))) throw new Error(`资源清单缺少工具：${name}`);
    for (const record of manifest.files) {
      const data = await readFile(path.join(root, record.file));
      if (createHash('sha256').update(data).digest('hex') !== record.sha256) throw new Error(`打包前校验失败：${record.file}`);
    }
    console.log(`Verified ${target}`);
    if (target === native) for (const name of names) {
      const file = path.join(root, name + (manifest.platform === 'win' ? '.exe' : ''));
      const args = name.startsWith('ff') ? ['-version'] : ['--version'];
      let first = true;
      await run(file, args, line => { if (first) { console.log(line); first = false; } }).done;
    }
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
