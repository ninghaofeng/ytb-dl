import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function architectures(value, native) {
  if (value === 'all') return ['x64', 'arm64'];
  const arch = value || native;
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Architecture must be x64, arm64 or all.');
  return [arch];
}
export function buildSteps(platform, arches) {
  if (!['mac', 'win'].includes(platform) || !arches.length || !arches.every(a => ['x64', 'arm64'].includes(a))) throw new Error('Invalid build target.');
  return [
    ['ci'],
    ...arches.map(arch => ['run', 'prepare:tools', '--', platform, arch]),
    ['run', 'typecheck'],
    ['run', 'build'],
    ['exec', '--no', '--', 'tsx', 'scripts/check-tools.ts', ...arches.map(arch => `${platform}-${arch}`)],
    ['exec', '--no', '--', 'electron-builder', `--${platform}`, ...arches.map(arch => `--${arch}`)],
    ['run', 'checksums']
  ];
}
function npmCli() {
  const bin = path.dirname(process.execPath);
  const candidates = [
    path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js')
  ];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const executable = path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!existsSync(executable)) continue;
    const resolved = realpathSync(executable);
    if (resolved.endsWith('npm-cli.js')) candidates.push(resolved);
    candidates.push(path.join(path.dirname(resolved), 'node_modules/npm/bin/npm-cli.js'));
  }
  const cli = candidates.find(file => existsSync(file));
  if (!cli) throw new Error('npm was not found. Install Node.js with npm and retry.');
  return cli;
}
export async function executeSteps(steps, execute) {
  for (const [index, args] of steps.entries()) {
    console.log(`\n[${index + 1}/${steps.length}] npm ${args.join(' ')}`);
    await execute(args);
  }
}
async function main() {
  const [platform, requested = ''] = process.argv.slice(2);
  if (process.argv.length > 4) throw new Error('Usage: build script [x64|arm64|all]');
  if ((platform === 'mac' && process.platform !== 'darwin') || (platform === 'win' && process.platform !== 'win32')) throw new Error('Run the macOS script on macOS and the Windows script on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required; Node.js 22.23.4 or newer is recommended.');
  const arches = architectures(requested, process.arch);
  const cli = npmCli();
  const env = { ...process.env };
  if ((env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = '1';
  console.log(`Building ${platform}: ${arches.join(', ')}\nRepository: ${root}`);
  await executeSteps(buildSteps(platform, arches), args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`npm ${args[0]} failed (${code ?? signal}). Build stopped; no success is reported.`)));
  }));
  console.log(`\nBuild succeeded. Packages and SHA256SUMS.txt: ${path.join(root, 'release')}`);
}
const entry = process.argv[1] && realpathSync(process.argv[1]);
const current = fileURLToPath(import.meta.url);
if (entry && (process.platform === 'win32' ? entry.toLowerCase() === current.toLowerCase() : entry === current)) {
  void main().catch(error => { console.error(`\nBuild failed: ${error.message}`); process.exitCode = 1; });
}
