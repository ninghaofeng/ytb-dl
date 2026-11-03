import { download } from '../src/main/network';
import { errorMessage } from '../src/main/validation';

function transient(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? error.code : undefined;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(String(code)) ||
    /连接超时|下载总时限已到|HTTP (408|429|500|502|503|504)\b/.test(error.message);
}
export async function downloadResource(
  url: string, proxy: string, maxBytes?: number,
  fetch: typeof download = download,
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  report: (message: string) => void = console.warn
): Promise<Buffer> {
  const parsed = new URL(url);
  const resource = `${parsed.hostname}${parsed.pathname}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fetch(url, proxy, maxBytes); }
    catch (error) {
      if (attempt === 3 || !transient(error)) {
        throw new Error(`下载资源失败：${resource}（已尝试 ${attempt} 次）。${errorMessage(error)} 请检查网络，或设置 HTTPS_PROXY / HTTP_PROXY 后重试。`);
      }
      report(`资源下载暂时失败：${resource}（${attempt}/3），稍后重试。${errorMessage(error)}`);
      await wait(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error('资源下载重试状态无效。');
}
