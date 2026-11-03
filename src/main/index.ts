import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell } from 'electron';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store';
import { Cookies } from './cookies';
import { Engine } from './engine';
import { Updates } from './updates';
import { Formats } from './formats';
import { settings, proxyUrl, options, errorMessage } from './validation';
import type { Api, CookieMode, Settings, Snapshot } from '../shared/types';
import type { Tools } from './arguments';
import { run } from './process';
import { resolveApplicationProxy } from './proxy';

let win: BrowserWindow | undefined;
let quitting = false;
let stopping = false;
let confirming = false;
let notification: NodeJS.Timeout | undefined;
let store: Store;
let cookies: Cookies;
let engine: Engine;
let updates: Updates;
let formats: Formats;
const testing = process.env.YTB_DL_TEST === '1' && !app.isPackaged;
const customData = app.commandLine.getSwitchValue('user-data-dir');

if (customData) {
  if (!path.isAbsolute(customData)) {
    dialog.showErrorBox('数据目录无效', '--user-data-dir 必须指定已有目录的绝对路径。');
    app.exit(1);
  } else app.setPath('userData', customData);
}
if (testing && process.env.YTB_DL_TEST_DATA) app.setPath('userData', process.env.YTB_DL_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  void app.whenReady().then(start).catch(async error => {
    await dialog.showMessageBox({ type: 'error', title: '无法启动 ytb-dl-ui', message: errorMessage(error), detail: '请检查依赖包、磁盘权限和状态文件。程序不会将启动失败显示为成功。' });
    app.exit(1);
  });
}
function snapshot(): Snapshot {
  return { settings: store.state.settings, tasks: store.state.tasks, cookies: cookies.info, playlist: engine.playlist, update: updates.info, warning: store.warning, proxyConfigured: !!store.state.proxyEncrypted, inspection: formats.info, preparations: engine.preparations };
}
function changed(): void {
  if (!notification) notification = setTimeout(() => {
    notification = undefined;
    if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
    updates?.tick();
  }, 150);
}
function manualProxy(): string {
  if (!store.state.proxyEncrypted) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法读取代理凭据。');
  return safeStorage.decryptString(Buffer.from(store.state.proxyEncrypted, 'base64'));
}
function proxy(url: string): Promise<string> {
  return resolveApplicationProxy(url, manualProxy, value => session.defaultSession.resolveProxy(value));
}
function tools(): Tools {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'tools') : path.join(app.getAppPath(), 'resources', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return { yt: updates ? updates.yt() : path.join(base, `yt-dlp${suffix}`), ffmpeg: path.join(base, `ffmpeg${suffix}`), ffprobe: path.join(base, `ffprobe${suffix}`), node: path.join(base, `node${suffix}`) };
}
async function start(): Promise<void> {
  nativeTheme.themeSource = 'light';
  app.setAboutPanelOptions({ applicationName: 'ytb-dl-ui' });
  store = new Store(app.getPath('userData'), testing ? path.join(app.getPath('userData'), 'downloads') : path.join(app.getPath('downloads'), 'ytb-dl-ui'));
  const bundled = tools();
  if (!testing) for (const filename of Object.values(bundled)) if (!(await stat(filename)).isFile()) throw new Error(`内置工具缺失：${path.basename(filename)}。开发模式请先运行 npm run prepare:tools。`);
  const key = app.isPackaged ? path.join(process.resourcesPath, 'public.key') : path.join(app.getAppPath(), 'resources/public.key');
  const launch: typeof run = testing
    ? (_executable, args, onLine, cwd, input) => run(bundled.node, [path.join(app.getAppPath(), 'tests/fixtures/engine.cjs'), ...args], onLine, cwd, input)
    : run;
  cookies = new Cookies(store, () => updates.yt(), changed, launch);
  engine = new Engine(store, tools, cookies, proxy, changed, launch);
  formats = new Formats(tools, cookies, proxy, changed, () => engine.paused || stopping, launch);
  updates = new Updates(store, bundled.yt, key, proxy, () => engine.busy || formats.busy, paused => { engine.paused = paused; if (!paused) engine.schedule(); }, changed);
  await cookies.init();
  await updates.init();
  store.save();
  registerApi();
  createWindow();
  engine.schedule();
  if (store.state.settings.checkUpdates && !testing) void updates.check().catch(e => { store.warning = `更新检查失败：${errorMessage(e)}`; changed(); });
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
}
function createWindow(): void {
  win = new BrowserWindow({
    width: 1180, height: 850, minWidth: 880, minHeight: 640, title: 'ytb-dl-ui',
    backgroundColor: '#f4f7fc',
    webPreferences: { preload: path.join(__dirname, '../preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, callback) => callback(false));
  win.on('close', event => { if (!quitting) { event.preventDefault(); void requestQuit(); } });
  if (process.platform === 'darwin') {
    const menu = Menu.getApplicationMenu();
    const applicationMenu = menu?.items[0];
    if (menu && applicationMenu) {
      applicationMenu.label = 'ytb-dl-ui';
      const labels: Record<string, string> = { about: '关于 ytb-dl-ui', hide: '隐藏 ytb-dl-ui', quit: '退出 ytb-dl-ui' };
      for (const item of applicationMenu.submenu?.items || []) {
        const label = labels[item.role?.toLowerCase() || ''];
        if (label) item.label = label;
      }
      Menu.setApplicationMenu(menu);
    }
  }
  void win.loadFile(path.join(__dirname, '../renderer/index.html')).catch(e => { dialog.showErrorBox('界面加载失败', errorMessage(e)); });
}
async function requestQuit(): Promise<void> {
  if (confirming || quitting) return;
  confirming = true;
  try {
    if (engine.busy || formats.busy || store.state.tasks.some(t => t.status === 'queued') || ['waiting', 'installing', 'checking'].includes(updates.info.status)) {
      const answer = await dialog.showMessageBox(win!, { type: 'question', buttons: ['继续运行', '终止任务并退出'], defaultId: 0, cancelId: 0, message: '正在下载、解析或更新，确定退出？', detail: '下载任务会保留部分文件并在下次启动时尝试恢复。更新安装会等待完成，避免损坏引擎。' });
      if (answer.response !== 1) return;
    }
    stopping = true;
    await formats.cancel();
    await engine.stop();
    await updates.stop().catch(e => { store.warning = `退出时更新检查失败：${errorMessage(e)}`; store.save(); });
    quitting = true;
    app.quit();
  } catch (e) { stopping = false; await dialog.showMessageBox(win!, { type: 'error', message: `退出失败：${errorMessage(e)}`, detail: '程序仍保持运行，请检查任务与磁盘状态。' }); }
  finally { confirming = false; }
}
function handle<K extends keyof Api>(name: K, fn: Api[K]): void {
  ipcMain.handle(name, async (event, ...args: unknown[]) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('拒绝非授权页面调用。');
    try {
      return await (fn as (...args: unknown[]) => unknown)(...args);
    } catch (e) { throw new Error(errorMessage(e)); }
  });
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('参数无效。');
  return value;
}
function mode(value: unknown): CookieMode {
  if (!['none', 'file', 'chrome'].includes(String(value))) throw new Error('Cookie 来源无效。');
  return value as CookieMode;
}
function registerApi(): void {
  handle('snapshot', async () => snapshot());
  handle('saveSettings', async (input: Settings & { proxy?: string }) => {
    const validated = settings(input);
    if (!path.isAbsolute(validated.directory)) throw new Error('请选择绝对路径下载目录。');
    await mkdir(validated.directory, { recursive: true });
    if (input.proxy !== undefined) {
      const value = proxyUrl(text(input.proxy));
      if (value && !safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，不能安全保存代理凭据。');
      store.state.proxyEncrypted = value ? safeStorage.encryptString(value).toString('base64') : '';
    }
    // Authorization can only change through its dedicated confirmation dialog.
    store.state.settings = { ...validated, chromeProfile: store.state.settings.chromeProfile, chromeAuthorized: store.state.settings.chromeAuthorized, watchCookies: store.state.settings.watchCookies };
    store.save(); engine.schedule(); changed();
  });
  handle('chooseDirectory', async () => {
    const answer = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return answer.canceled ? null : answer.filePaths[0] || null;
  });
  handle('importCookies', async (watchFile: boolean) => {
    if (typeof watchFile !== 'boolean') throw new Error('监测选项无效。');
    const answer = await dialog.showOpenDialog(win!, { title: '选择 Netscape cookies.txt（仅保存在本机）', properties: ['openFile'], filters: [{ name: 'Cookie 文件', extensions: ['txt'] }] });
    if (!answer.canceled && answer.filePaths[0]) {
      if (watchFile) {
        const consent = await dialog.showMessageBox(win!, { type: 'question', buttons: ['取消', '允许监测'], defaultId: 0, cancelId: 0, message: '允许监测这个导出文件的变化？', detail: '程序将重新加载用户导出的 Cookie，但不会让 Chrome 自动重新导出。可以通过删除 Cookie 撤销监测。' });
        if (consent.response !== 1) return;
      }
      await cookies.importFile(answer.filePaths[0], watchFile);
    }
  });
  handle('clearCookies', async () => cookies.clear());
  handle('authorizeChrome', async profile => {
    const consent = await dialog.showMessageBox(win!, { type: 'warning', buttons: ['取消', '授权读取'], defaultId: 0, cancelId: 0, message: '允许读取并缓存选定 Chrome 配置的 Cookie？', detail: 'yt-dlp 会读取浏览器登录凭据。程序将目标平台 Cookie 保存在本机私密缓存，文件不加密、不上传、不记录内容，可跨重启复用；会话 Cookie 最长缓存 6 小时。到期或明确登录失效时重新读取，每次操作最多自动重试一次。切换配置或撤销授权会清除缓存。macOS 可能请求钥匙串权限，Windows 加密可能阻止读取；失败请手动导入。' });
    if (consent.response === 1) await cookies.authorize(text(profile));
  });
  handle('revokeChrome', async () => cookies.revoke());
  handle('syncCookies', async value => cookies.sync(mode(value)));
  handle('profiles', async () => cookies.profiles());
  handle('enqueue', async input => {
    if (!input || !Array.isArray(input.urls)) throw new Error('链接列表无效。');
    return engine.enqueue(input.urls, options(input.options));
  });
  handle('parsePlaylist', async input => {
    if (!input) throw new Error('播放列表参数无效。');
    engine.parse(text(input.url), mode(input.cookie));
  });
  handle('playlistPage', async offset => {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('分页参数无效。');
    return engine.entries.slice(offset, offset + 100);
  });
  handle('stopPlaylist', async () => engine.stopParse());
  handle('enqueuePlaylist', async input => {
    if (!input || !Array.isArray(input.ids) || !input.ids.every(id => typeof id === 'string') || typeof input.all !== 'boolean') throw new Error('条目选择无效。');
    return engine.enqueueEntries(input.ids, input.all, options(input.options));
  });
  handle('selectedPlaylist', async input => {
    if (!input || !Array.isArray(input.ids) || !input.ids.every(id => typeof id === 'string') || typeof input.all !== 'boolean') throw new Error('条目选择无效。');
    return engine.selectedEntries(input.ids, input.all);
  });
  handle('inspectFormats', async input => {
    if (!input) throw new Error('格式解析参数无效。');
    return formats.inspect(text(input.url), mode(input.cookie));
  });
  handle('cancelInspection', async () => formats.cancel());
  handle('enqueueFormats', async input => {
    if (!input || stopping) throw new Error('格式确认参数无效或程序正在退出。');
    const selected = formats.selection(text(input.inspection), input.selection, input.subtitles);
    return engine.enqueue([selected.url], options({ kind: 'video', container: 'original', height: 0, cookie: selected.cookie, selection: selected.selection,
      embedChapters: input.embedChapters === undefined ? true : input.embedChapters, subtitles: selected.subtitles, ...(input.mergeFormat !== undefined ? { mergeFormat: input.mergeFormat } : {}) }), selected.source);
  });
  handle('cancel', async id => engine.cancel(text(id)));
  handle('retry', async id => engine.retry(text(id)));
  handle('clearFinished', async () => engine.clearFinished());
  handle('openFile', async id => {
    const t = engine.task(text(id));
    if (t.status !== 'completed' || !t.file || !(await stat(t.file)).isFile()) throw new Error('文件不存在或下载未完成。');
    const error = await shell.openPath(t.file);
    if (error) throw new Error(error);
  });
  handle('showFile', async id => {
    const t = engine.task(text(id));
    if (!t.file || !(await stat(t.file)).isFile()) throw new Error('文件尚未生成或已被移动。');
    shell.showItemInFolder(t.file);
  });
  handle('checkUpdate', async () => {
    await updates.check();
    if (store.warning.startsWith('更新检查失败：')) { store.warning = ''; changed(); }
  });
  handle('installUpdate', async () => updates.install());
  handle('rollback', async () => updates.rollback());
}
