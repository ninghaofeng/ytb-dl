import { test, expect, _electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/main/store';

test('download preparation shows the engine stage, elapsed time and indeterminate progress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-preparation-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    await page.locator('#cookie').selectOption('none');
    await page.locator('#urls').fill('https://youtube.com/watch?v=startup-wait');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await page.locator('#best-streams').click();
    await page.locator('#subtitle-tracks input[data-language="en"][data-source="manual"]').check();
    await page.locator('#confirm-formats').click();
    const detail = page.locator('[data-preparation-task]');
    await expect(detail).toContainText('启动下载引擎 / 获取下载地址');
    await expect(page.locator('.task progress')).not.toHaveAttribute('value');
    await expect(detail).toContainText(/已等待 [12] 秒/);
    await expect(page.locator('.badge')).toHaveText('已完成');
    await expect(detail).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.downloader.snapshot());
    expect(snapshot.preparations).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain('private.invalid');
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

test('Chrome cache is reused for inspection/download and across restart, with manual refresh and revocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-cookie-cache-ui-'));
  const store = new Store(root, path.join(root, 'downloads'));
  store.state.settings.chromeAuthorized = true; store.state.settings.checkUpdates = false; store.save();
  const launch = () => _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  let desktop = await launch();
  try {
    let page = await desktop.firstWindow();
    await page.locator('#settings > summary').click();
    await page.locator('#sync-chrome').click();
    await expect(page.locator('#chrome-state')).toContainText('缓存有效至');
    const first = (await page.evaluate(() => window.downloader.snapshot())).cookies;
    await page.locator('#cookie').selectOption('chrome');
    await page.locator('#urls').fill('https://youtube.com/watch?v=cache-ui');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await page.locator('#best-streams').click();
    await page.locator('#confirm-formats').click();
    await expect(page.locator('.badge')).toHaveText('已完成');
    expect((await page.evaluate(() => window.downloader.snapshot())).cookies.lastChromeSync).toBe(first.lastChromeSync);
    await desktop.close();
    desktop = await launch();
    page = await desktop.firstWindow();
    await page.locator('#settings > summary').click();
    await expect(page.locator('#chrome-state')).toContainText('缓存有效至');
    expect((await page.evaluate(() => window.downloader.snapshot())).cookies.lastChromeSync).toBe(first.lastChromeSync);
    await page.locator('#sync-chrome').click();
    await expect.poll(async () => (await page.evaluate(() => window.downloader.snapshot())).cookies.lastChromeSync).not.toBe(first.lastChromeSync);
    await page.locator('#revoke-chrome').click();
    await expect(page.locator('#chrome-state')).toHaveText('未授权');
    expect((await page.evaluate(() => window.downloader.snapshot())).cookies.chromeCacheExpiresAt).toBe('');
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

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

test('best video and audio shortcut requires confirmation and saves the chosen MKV, MOV or MP4 container', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-merge-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    for (const [index, container] of ['mkv', 'mov', 'mp4'].entries()) {
      await page.locator('#urls').fill(`https://youtube.com/watch?v=merge${index}`);
      await page.locator('#download').click();
      await expect(page.locator('#format-content')).toBeVisible();
      await expect(page.locator('#stream-mode')).toHaveValue('separate');
      await expect(page.locator('#stream-mode')).toContainText('音视频下载后合并');
      await expect(page.locator('#stream-mode option[value="combined"]')).toHaveCount(0);
      await expect(page.locator('#merge-format')).toHaveValue('mkv');
      await expect(page.locator('#embed-chapters')).toBeChecked();
      await expect(page.locator('#chapter-state')).toContainText('2 个章节');
      await expect(page.locator('#subtitle-tracks input:checked')).toHaveCount(0);
      await expect(page.locator('#subtitle-tracks')).toContainText('<English>');
      await expect(page.locator('#subtitle-tracks script')).toHaveCount(0);
      await page.locator('#subtitle-tracks input[data-language="en"][data-source="manual"]').check();
      await page.locator('#subtitle-tracks input[data-language="en"][data-source="automatic"]').check();
      await page.locator('#subtitle-tracks input[data-language="zh-Hans"]').check();
      await expect(page.locator('#subtitle-tracks input:checked')).toHaveCount(3);
      if (index === 1) await page.locator('#embed-chapters').uncheck();
      await page.locator('#resolution').selectOption('1280x720');
      await page.locator('#best-streams').click();
      await expect(page.locator('#resolution')).toHaveValue('all');
      await expect(page.locator('#video-table input[value="v2160"]')).toBeChecked();
      await expect(page.locator('#audio-table input[value="flac"]')).toBeChecked();
      await expect(page.locator('#task-count')).toHaveText(String(index));
      await page.locator('#merge-format').selectOption(container!);
      await expect(page.locator('#format-summary')).toContainText(`合并为 ${container!.toUpperCase()}`);
      await page.locator('#confirm-formats').click();
      await expect(page.locator('#format-picker')).toBeHidden();
      const task = (await page.evaluate(() => window.downloader.snapshot())).tasks[index]!;
      expect(task.options.selection).toEqual({ video: 'v2160', audio: 'flac' });
      expect(task.options.mergeFormat).toBe(container);
      expect(task.options.embedChapters).toBe(index !== 1);
      expect(task.options.subtitles).toEqual([
        { language: 'en', source: 'manual' }, { language: 'zh-Hans', source: 'manual' }, { language: 'en', source: 'automatic' }
      ]);
    }
    await page.locator('#urls').fill('https://youtube.com/watch?v=muxed-only');
    await page.locator('#download').click();
    await expect(page.locator('#format-error')).toContainText('当前版本不提供合一流下载');
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await page.locator('#cancel-formats').click();
    await page.locator('#urls').fill('https://youtube.com/watch?v=audio-subtitle-check');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await page.locator('#subtitle-tracks input[data-source="automatic"]').check();
    await page.locator('#stream-mode').selectOption('audio');
    await expect(page.locator('#subtitle-control')).toBeHidden();
    await page.locator('#audio-table input[value="a1"]').check();
    await page.locator('#confirm-formats').click();
    const audio = (await page.evaluate(() => window.downloader.snapshot())).tasks.at(-1)!;
    expect(audio.options.subtitles).toEqual([]);
    expect(audio.options.embedChapters).toBe(true);
    await expect(page.locator('.badge')).toHaveText(Array(4).fill('已完成'));
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

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
    await page.locator('#cancel-formats').click();
    await page.locator('#settings > summary').click();
    await expect(page.locator('#proxy-state')).toContainText('默认跟随系统代理');
    await page.locator('.guide > summary').click();
    await expect(page.locator('.guide')).toContainText('Cookie 相当于登录凭据');
    await page.locator('#concurrency').fill('2');
    await page.locator('#save-settings').click();
    await expect(page.locator('#notice')).toHaveText('设置已保存。');
    expect((await page.evaluate(() => window.downloader.snapshot())).settings.concurrency).toBe(2);
    await page.locator('#urls').fill('https://www.youtube.com/watch?v=fixture');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await expect(page.locator('#task-count')).toHaveText('0');
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await expect(page.locator('#format-title')).toHaveText('<script>格式测试</script>');
    expect(await page.locator('#format-title script').count()).toBe(0);
    await expect(page.locator('#video-table')).toContainText('avc1.640028');
    await expect(page.locator('#audio-table')).toContainText('无损编码');
    await page.locator('#video-table input[value="v1"]').check();
    await page.locator('#audio-table input[value="a1"]').check();
    await page.locator('#confirm-formats').click();
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
    await expect(page.locator('#format-title')).toHaveText('第二个视频');
    await expect(page.locator('#task-count')).toHaveText('1');
    await page.locator('#video-table input[value="v2"]').check();
    await page.locator('#audio-table input[value="a2"]').check();
    await page.locator('#merge-format').selectOption('mov');
    await page.locator('#confirm-formats').click();
    await expect(page.locator('#task-count')).toHaveText('2');
    for (const width of [880, 1180]) {
      const contentWidth = await desktop.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(size, 850);
        return window.getContentSize()[0];
      }, width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth);
      expect(await page.locator('.source-options').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(2);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

test('system proxy is resolved by Electron and forwarded to format inspection and media downloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-system-proxy-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    await desktop.evaluate(async ({ session }) => {
      await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: 'http=127.0.0.1:8877;https=127.0.0.1:8877' });
    });
    await page.locator('#urls').fill('https://youtube.com/watch?v=system-proxy-check');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await page.locator('#video-table input[value="v1"]').check();
    await page.locator('#audio-table input[value="a1"]').check();
    await page.locator('#confirm-formats').click();
    await expect(page.locator('.badge')).toHaveText('已完成');
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

test('batch videos require individual confirmation and support source audio, retry, skip and cancellation', async ({}, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-format-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    await page.locator('#urls').fill('https://youtube.com/watch?v=one\nhttps://youtube.com/watch?v=two');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await expect(page.locator('#format-position')).toHaveText('1 / 2');
    await expect(page.locator('#task-count')).toHaveText('0');
    await page.locator('#resolution').selectOption('1920x1080');
    await page.locator('#video-table input[value="av1"]').check();
    await page.locator('#audio-table input[value="flac"]').check();
    await expect(page.locator('#format-summary')).toContainText('合并为 MKV，不重新编码');
    await expect(page.locator('#format-content')).not.toContainText('never-render');
    await expect(page.locator('#format-content')).not.toContainText('#drm');
    await page.screenshot({ path: testInfo.outputPath('source-format-picker.png'), fullPage: true });
    for (const width of [880, 1180]) {
      const contentWidth = await desktop.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setSize(size, 850); return window.getContentSize()[0];
      }, width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(contentWidth);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.locator('#confirm-formats').click();
    await expect(page.locator('#format-position')).toHaveText('2 / 2');
    await expect(page.locator('#format-content')).toBeVisible();
    await expect(page.locator('#resolution')).toHaveValue('all');
    await expect(page.locator('#video-table input:checked')).toHaveCount(0);
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await expect(page.locator('#task-count')).toHaveText('1');
    await page.locator('#stream-mode').selectOption('audio');
    await expect(page.locator('#video-formats')).toBeHidden();
    await page.locator('#audio-table input[value="a2"]').check();
    await page.locator('#confirm-formats').click();
    await expect(page.locator('#format-picker')).toBeHidden();
    await expect(page.locator('#task-count')).toHaveText('2');
    const tasks = (await page.evaluate(() => window.downloader.snapshot())).tasks;
    expect(tasks[0]!.options.selection).toEqual({ video: 'av1', audio: 'flac' });
    expect(tasks[1]!.options.selection).toEqual({ audio: 'a2' });
    await page.locator('#urls').fill('https://youtube.com/watch?v=inspect-fail\nhttps://youtube.com/watch?v=three');
    await page.locator('#download').click();
    await expect(page.locator('#format-error')).toContainText('format extraction failed');
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await page.locator('#retry-formats').click();
    await expect(page.locator('#format-error')).toContainText('format extraction failed');
    await page.locator('#skip-formats').click();
    await expect(page.locator('#format-content')).toBeVisible();
    await expect(page.locator('#task-count')).toHaveText('2');
    await page.locator('#cancel-formats').click();
    await expect(page.locator('#format-picker')).toBeHidden();
    await page.locator('#urls').fill('https://youtube.com/watch?v=inspect-slow');
    await page.locator('#download').click();
    await expect(page.locator('#format-loading')).toBeVisible();
    await expect(page.locator('#format-loading')).toContainText('正在连接平台');
    await expect(page.locator('#format-loading')).toContainText('上限 120 秒');
    await page.locator('#cancel-formats').click();
    await expect(page.locator('#format-picker')).toBeHidden();
    await expect(page.locator('#download')).toBeEnabled();
    await expect(page.locator('#task-count')).toHaveText('2');
    await page.locator('#urls').fill('https://youtube.com/playlist?list=fixture');
    await page.locator('#parse').click();
    await expect(page.locator('#playlist-count')).toContainText('解析完成');
    await page.locator('#all-entries').check();
    await page.locator('#download-selected').click();
    await expect(page.locator('#format-position')).toHaveText('1 / 2');
    await expect(page.locator('#task-count')).toHaveText('2');
    await page.locator('#skip-formats').click();
    await expect(page.locator('#format-position')).toHaveText('2 / 2');
    await expect(page.locator('#format-title')).toHaveText('第二个视频');
    await page.locator('#cancel-formats').click();
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});

test('resolution selection filters exact source dimensions without changing audio or silently selecting a different stream', async ({}, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ytbdl-resolution-ui-'));
  const desktop = await _electron.launch({ args: ['.'], env: { ...process.env, YTB_DL_TEST: '1', YTB_DL_TEST_DATA: root } });
  try {
    const page = await desktop.firstWindow();
    await page.locator('#urls').fill('https://youtube.com/watch?v=resolution');
    await page.locator('#download').click();
    await expect(page.locator('#format-content')).toBeVisible();
    const resolutions = page.locator('#resolution option');
    expect(await resolutions.evaluateAll(options => options.map(o => (o as HTMLOptionElement).value))).toEqual([
      'all', '3840x2160', '1920x1080', '1080x1920', '1280x720', '?x?'
    ]);
    await expect(page.locator('#resolution')).toContainText('4K');
    await expect(page.locator('#resolution')).not.toContainText('1440p');
    await page.locator('#audio-table input[value="a1"]').check();
    await page.locator('#resolution').selectOption('1920x1080');
    await expect(page.locator('#video-table tbody tr')).toHaveCount(2);
    await page.locator('#video-table input[value="v1"]').check();
    await expect(page.locator('#confirm-formats')).toBeEnabled();
    await page.locator('#resolution').selectOption('1280x720');
    await expect(page.locator('#video-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#video-table input:checked')).toHaveCount(0);
    await expect(page.locator('#audio-table input[value="a1"]')).toBeChecked();
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await page.locator('#video-table input[value="v720"]').check();
    await expect(page.locator('#format-summary')).toContainText('1280 × 720 / 720p');
    await page.locator('#resolution').selectOption('3840x2160');
    await expect(page.locator('#confirm-formats')).toBeDisabled();
    await page.locator('#video-table input[value="v2160"]').check();
    await expect(page.locator('#format-summary')).toContainText('4K');
    await page.screenshot({ path: testInfo.outputPath('resolution-picker.png'), fullPage: true });
    await page.locator('#resolution').selectOption('1080x1920');
    await expect(page.locator('#video-table tbody tr')).toHaveCount(1);
    await page.locator('#video-table input[value="portrait"]').check();
    await expect(page.locator('#format-summary')).toContainText('1080 × 1920 / 竖屏');
    await expect(page.locator('#format-summary')).not.toContainText('1920p');
    await page.locator('#resolution').selectOption('?x?');
    await expect(page.locator('#video-table tbody tr')).toHaveCount(1);
    await page.locator('#video-table input[value="unknown-resolution"]').check();
    await expect(page.locator('#format-summary')).toContainText('分辨率未知');
    await page.locator('#stream-mode').selectOption('audio');
    await expect(page.locator('#resolution-control')).toBeHidden();
    await expect(page.locator('#confirm-formats')).toBeEnabled();
    await page.locator('#stream-mode').selectOption('separate');
    await expect(page.locator('#stream-mode option[value="combined"]')).toHaveCount(0);
    await expect(page.locator('#merge-control')).toBeVisible();
    await page.locator('#resolution').selectOption('1280x720');
    await expect(page.locator('#video-table tbody tr')).toHaveCount(1);
    await page.locator('#video-table input[value="v720"]').check();
    await page.locator('#merge-format').selectOption('mp4');
    await expect(page.locator('#format-summary')).toContainText('720p');
    await page.locator('#confirm-formats').click();
    await expect(page.locator('#task-count')).toHaveText('1');
    const task = (await page.evaluate(() => window.downloader.snapshot())).tasks[0]!;
    expect(task.options.selection).toEqual({ video: 'v720', audio: 'a1' });
    expect(task.options.mergeFormat).toBe('mp4');
    expect(task.options.height).toBe(0);
  } finally { await desktop.close(); await rm(root, { recursive: true, force: true }); }
});
