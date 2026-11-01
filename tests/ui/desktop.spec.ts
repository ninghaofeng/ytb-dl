import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function contrast(foreground: string, background: string): number {
  function luminance(color: string): number {
    const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${color}`);
    const linear = channels.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  }
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

test('desktop shell, input validation, settings and cookie guide', async ({}, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    await expect(page.locator('h1')).toHaveText('ytb-dl-ui');
    await expect(page).toHaveTitle('ytb-dl-ui');
    expect(await desktop.evaluate(({ app }) => app.getName())).toBe('ytb-dl');
    expect(await desktop.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');
    if (process.platform === 'darwin') expect(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.label)).toBe('ytb-dl-ui');
    await page.emulateMedia({ colorScheme: 'dark' });
    const theme = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const primary = getComputedStyle(document.getElementById('download')!);
      const muted = getComputedStyle(document.querySelector('.muted')!);
      return { scheme: root.colorScheme, background: root.backgroundColor, color: root.color, primary: primary.backgroundColor, primaryText: primary.color, muted: muted.color };
    });
    expect(theme.scheme).toBe('light');
    expect(theme.background).toBe('rgb(244, 247, 252)');
    expect(theme.primary).toBe('rgb(37, 99, 235)');
    expect(contrast(theme.color, theme.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.muted, theme.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(theme.primaryText, theme.primary)).toBeGreaterThanOrEqual(4.5);
    await expect(page.locator('.empty')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('light-desktop.png') });
    const isolation = await page.evaluate(() => ({ node: typeof (window as unknown as { require?: unknown }).require, api: typeof window.downloader }));
    expect(isolation).toEqual({ node: 'undefined', api: 'object' });
    await page.locator('#urls').fill('https://youtube.com.evil.test/secret');
    await page.locator('#download').click();
    await expect(page.locator('#notice')).toContainText('仅支持');
    await page.locator('#settings > summary').click();
    await page.locator('.guide > summary').click();
    await expect(page.locator('.guide')).toContainText('Cookie 相当于登录凭据');
    await page.locator('#concurrency').fill('2');
    await page.locator('#save-settings').click();
    await expect(page.locator('#notice')).toHaveText('设置已保存。');
    expect((await page.evaluate(() => window.downloader.snapshot())).settings.concurrency).toBe(2);
    await page.locator('#kind').selectOption('mp3');
    await expect(page.locator('#height')).toBeDisabled();
    await expect(page.locator('#container')).toBeDisabled();
    await page.locator('#kind').selectOption('video');
    await page.locator('#urls').fill('https://www.youtube.com/watch?v=fixture');
    await page.locator('#download').click();
    await expect(page.locator('.badge')).toHaveText('已完成');
    await expect(page.locator('.badge')).toHaveAttribute('data-status', 'completed');
    await expect(page.locator('.task-title')).toHaveText('测试视频');
    await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeVisible();
    await page.locator('#urls').fill('https://www.youtube.com/playlist?list=fixture');
    await page.locator('#parse').click();
    await expect(page.locator('#playlist-count')).toContainText('解析完成');
    await expect(page.locator('#entries')).toContainText('<script>not html</script>');
    expect(await page.locator('#entries script').count()).toBe(0);
    await page.locator('#entries input').nth(1).check();
    await expect(page.locator('#page-label')).toContainText('已勾选 1 项');
    await page.locator('#download-selected').click();
    await expect(page.locator('#task-count')).toHaveText('2');
    for (const width of [880, 1180]) {
      const contentWidth = await desktop.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(size, 850);
        return window.getContentSize()[0];
      }, width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth);
      expect(await page.locator('.options').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(width === 880 ? 2 : 4);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});
