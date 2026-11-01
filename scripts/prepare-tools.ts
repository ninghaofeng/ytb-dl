import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readKeys } from 'openpgp';
import { download as fetchResource } from '../src/main/network';
import { assetName, BUNDLED_YT_VERSION, KEY_FINGERPRINT, verifyChecksum, verifyManifest } from '../src/main/updates';
import { run } from '../src/main/process';

const platform = process.argv[2] || (process.platform === 'darwin' ? 'mac' : 'win');
const arch = process.argv[3] || process.arch;
if (!['mac', 'win'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('用法：npm run prepare:tools -- [mac|win] [arm64|x64]');
const root = path.resolve('resources', `${platform}-${arch}`);
const temporary = path.join(root, `prepare-${randomUUID()}`);
const suffix = platform === 'win' ? '.exe' : '';
const buildProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
const download = (url: string, _proxy = '', maxBytes?: number): Promise<Buffer> => fetchResource(url, buildProxy, maxBytes);
const records: { file: string; sha256: string; source: string }[] = [];
const hash = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
async function save(filename: string, data: Buffer, source: string): Promise<void> {
  await writeFile(path.join(root, filename), data, { mode: filename.endsWith('.txt') ? 0o644 : 0o755 });
  await chmod(path.join(root, filename), filename.endsWith('.txt') ? 0o644 : 0o755);
  records.push({ file: filename, sha256: hash(data), source });
}
async function verified(url: string, expected: string): Promise<Buffer> {
  const data = await download(url);
  if (hash(data) !== expected) throw new Error(`固定资源 SHA256 不匹配：${url}`);
  return data;
}
const ffmpegHashes: Record<string, Record<string, string>> = {
  'mac-arm64': {
    ffmpeg: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
    ffprobe: 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64',
    LICENSE: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2',
    README: '05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a'
  },
  'mac-x64': {
    ffmpeg: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    ffprobe: 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0',
    LICENSE: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
    README: 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36'
  },
  'win-x64': {
    ffmpeg: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    ffprobe: '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4',
    LICENSE: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
    README: 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311'
  }
};
async function prepareFfmpeg(): Promise<void> {
  if (platform === 'win' && arch === 'arm64') {
    const filename = 'ffmpeg-n8.1.3-29-gad3b795b72-winarm64-lgpl-8.1.zip';
    const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49/${filename}`;
    const archive = await verified(url, '7ae4b2bf5a5e25bb63cf92702fa41919d04be95b4c8feec38d32bdd1e3a4fda9');
    const zip = path.join(temporary, 'ffmpeg.zip'), extracted = path.join(temporary, 'ffmpeg');
    await writeFile(zip, archive); await mkdir(extracted);
    await run('tar', ['-xf', zip, '-C', extracted]).done;
    const directories = await readdir(extracted);
    if (directories.length !== 1) throw new Error('FFmpeg archive 结构不符合预期。');
    const source = path.join(extracted, directories[0]!);
    await Promise.all(['ffmpeg', 'ffprobe'].map(async name => save(`${name}.exe`, await readFile(path.join(source, 'bin', `${name}.exe`)), url)));
    await save('FFmpeg-LICENSE.txt', await readFile(path.join(source, 'LICENSE.txt')), url);
    await save('FFmpeg-README.txt', Buffer.from(`FFmpeg LGPL Windows ARM64 build\nBinary: ${url}\nBuild scripts and source instructions: https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-11-01-12-49\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/ad3b795b72\nSee FFmpeg-LICENSE.txt for redistribution terms.\n`), url);
    return;
  }
  const hashes = ffmpegHashes[`${platform}-${arch}`]!;
  await Promise.all(Object.entries(hashes).map(async ([name, digest]) => {
    const upstreamPlatform = platform === 'mac' ? 'darwin' : 'win32';
    const asset = ['ffmpeg', 'ffprobe'].includes(name) ? `${name}-${upstreamPlatform}-${arch}` : `${upstreamPlatform}-${arch}.${name}`;
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${asset}`;
    await save(['ffmpeg', 'ffprobe'].includes(name) ? `${name}${suffix}` : `FFmpeg-${name}.txt`, await verified(url, digest), url);
  }));
}
async function prepareNode(): Promise<void> {
  const version = 'v22.23.4';
  const filename = `node-${version}-${platform === 'mac' ? 'darwin' : 'win'}-${arch}.${platform === 'mac' ? 'tar.gz' : 'zip'}`;
  const base = `https://nodejs.org/dist/${version}/`;
  const [sums, archive] = await Promise.all([download(`${base}SHASUMS256.txt`), download(base + filename)]);
  verifyChecksum(archive, sums.toString(), filename);
  const file = path.join(temporary, filename);
  const extracted = path.join(temporary, 'node');
  await writeFile(file, archive); await mkdir(extracted);
  await run('tar', ['-xf', file, '-C', extracted]).done;
  const dirname = filename.replace(/\.tar\.gz$|\.zip$/, '');
  await save(`node${suffix}`, await readFile(path.join(extracted, dirname, platform === 'mac' ? 'bin/node' : 'node.exe')), base + filename);
  await save('Node-LICENSE.txt', await readFile(path.join(extracted, dirname, 'LICENSE')), base + filename);
}
async function prepareYt(): Promise<void> {
  const keyUrl = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${BUNDLED_YT_VERSION}/public.key`;
  const key = await download(keyUrl, '', 1024 * 1024);
  if (!(await readKeys({ armoredKeys: key.toString() })).some(k => k.getFingerprint() === KEY_FINGERPRINT)) throw new Error('固定公钥指纹不匹配。');
  await writeFile(path.resolve('resources/public.key'), key);
  const name = assetName(platform === 'mac' ? 'darwin' : 'win32', arch);
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${BUNDLED_YT_VERSION}/`;
  const [manifest, signature, binary] = await Promise.all([download(base + 'SHA2-256SUMS'), download(base + 'SHA2-256SUMS.sig'), download(base + name)]);
  await verifyManifest(manifest, signature, key.toString()); verifyChecksum(binary, manifest.toString(), name);
  await save(`yt-dlp${suffix}`, binary, base + name);
  await save('yt-dlp-SHA2-256SUMS.txt', manifest, base + 'SHA2-256SUMS');
  await save('yt-dlp-SHA2-256SUMS.sig.txt', signature, base + 'SHA2-256SUMS.sig');
  for (const license of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    const url = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${BUNDLED_YT_VERSION}/${license}`;
    await save(`yt-dlp-${license}.txt`, await download(url), url);
  }
}
async function main(): Promise<void> {
 await mkdir(temporary, { recursive: true });
 try {
  console.log(`Preparing ${platform}-${arch}: signed yt-dlp, Node.js, FFmpeg and ffprobe`);
  const results = await Promise.allSettled([prepareYt(), prepareNode(), prepareFfmpeg()]);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map(result => result.reason), '资源准备失败，不能生成完整应用。');
  await copyFile('README.md', path.join(root, 'usage.txt'));
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ platform, arch, ytDlp: BUNDLED_YT_VERSION, node: '22.23.4', files: records }, null, 2));
  console.log(`Verified tools saved to ${root}`);
 } finally { await rm(temporary, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
