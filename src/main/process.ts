import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { redact } from './validation';

export interface Running {
  child: ChildProcess;
  done: Promise<void>;
  stop(): Promise<void>;
  diagnostics(): string;
}
export function run(executable: string, args: string[], onLine: (line: string) => void = () => {}, cwd?: string, input?: string): Running {
  const child = spawn(executable, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let protocolError: unknown;
  let settled = false;
  const lines = readline.createInterface({ input: child.stdout! });
  lines.on('line', line => {
    if (line.length > 4 * 1024 * 1024) { protocolError = new Error('引擎输出过大。'); void stop().catch(e => { protocolError = e; }); return; }
    try { onLine(line); } catch (e) { protocolError = e; void stop().catch(error => { protocolError = error; }); }
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      settled = true;
      lines.close();
      if (protocolError) reject(protocolError);
      else if (code === 0) resolve();
      else reject(new Error(redact(stderr.trim()) || `引擎退出：${code ?? signal}。如需登录，请在 Chrome 重新登录并同步 Cookie。`));
    });
    if (input !== undefined) {
      child.stdin!.on('error', error => { protocolError = error; });
      child.stdin!.end(input);
    }
  });
  async function stop(): Promise<void> {
    if (settled || !child.pid) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
        killer.once('error', reject);
        killer.once('close', code => code === 0 || settled ? resolve() : reject(new Error(`终止任务进程树失败：${code}`)));
      });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      await new Promise(resolve => setTimeout(resolve, 400));
      // Descendants may remain alive after the parent exits.
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    }
    await done.catch(() => { /* Expected nonzero exit after explicit termination. */ });
  }
  return { child, done, stop, diagnostics: () => redact(stderr) };
}
