import { _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Store } from '../src/main/store';

async function main(): Promise<void> {
  const executablePath = process.argv[2];
  if (!executablePath || !path.isAbsolute(executablePath)) throw new Error('请提供已打包程序的绝对可执行路径。');
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-package-smoke-'));
  const store = new Store(root, path.join(root, 'output'));
  store.state.settings.checkUpdates = false;
  store.save();
  let desktop: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    desktop = await _electron.launch({ executablePath, args: [`--user-data-dir=${root}`], timeout: 60_000 });
    const page = await desktop.firstWindow();
    await page.locator('h1').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'ytb-dl-ui');
    assert.equal(await page.title(), 'ytb-dl-ui');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    assert.equal(await desktop.evaluate(({ app }) => app.getName()), 'ytb-dl');
    const current = await page.evaluate(() => window.downloader.snapshot());
    assert.equal(current.settings.directory, path.join(root, 'output'));
    assert.equal(current.tasks.length, 0);
    assert.equal(current.update.current, '2026.10.26');
    assert.equal(current.warning, '');
    console.log(`Packaged desktop startup verified: ${executablePath}`);
  } finally {
    if (desktop) await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
