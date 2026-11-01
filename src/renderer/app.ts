import type { DownloadOptions, Snapshot, TaskStatus } from '../shared/types';

const api = window.downloader;
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`界面元素缺失：${id}`);
  return found as T;
}
function input(id: string): HTMLInputElement { return el<HTMLInputElement>(id); }
function select(id: string): HTMLSelectElement { return el<HTMLSelectElement>(id); }
let state: Snapshot;
let playlistId = '', page = 0, taskPage = 0;
const selected = new Set<string>();
const labels: Record<TaskStatus, string> = { queued: '排队中', syncing: '准备 / 同步 Cookie', downloading: '下载中', processing: '合并 / 转换中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
function notice(message: string, error = false): void {
  el('notice').textContent = message;
  el('notice').classList.toggle('error', error);
  el('notice').hidden = false;
}
function bind(id: string, action: () => Promise<unknown>): void {
  el<HTMLButtonElement>(id).addEventListener('click', async () => {
    const button = el<HTMLButtonElement>(id); button.disabled = true;
    try { await action(); }
    catch (e) { notice(e instanceof Error ? e.message : String(e), true); }
    finally { button.disabled = false; }
  });
}
function downloadOptions(): DownloadOptions {
  return { kind: select('kind').value as DownloadOptions['kind'], container: select('container').value as DownloadOptions['container'], height: Number(select('height').value), cookie: select('cookie').value as DownloadOptions['cookie'] };
}
function urls(): string[] { return el<HTMLTextAreaElement>('urls').value.split('\n').map(s => s.trim()).filter(Boolean); }
function text(tag: string, value: string, className = ''): HTMLElement {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
function action(label: string, work: () => Promise<unknown>): HTMLButtonElement {
  const button = document.createElement('button'); button.textContent = label;
  button.onclick = async () => {
    button.disabled = true;
    try { await work(); } catch (e) { notice(e instanceof Error ? e.message : String(e), true); }
    finally { button.disabled = false; }
  };
  return button;
}
function render(s: Snapshot, initial = false): void {
  state = s;
  el('warning').hidden = !s.warning; el('warning').textContent = s.warning;
  if (initial) {
    input('directory').value = s.settings.directory;
    input('concurrency').value = String(s.settings.concurrency);
    input('auto-update').checked = s.settings.checkUpdates;
  }
  el('proxy-state').textContent = s.proxyConfigured ? '已保存代理（凭据使用系统安全存储）。留空不更改。' : '未配置代理，请确保网络可访问目标站点。';
  const c = s.cookies;
  el('file-state').textContent = c.fileError || `${c.file ? '已导入' : '未导入'} · ${c.watching ? '正在监测原始文件' : '未监测'}${c.lastFileSync ? ` · 同步于 ${new Date(c.lastFileSync).toLocaleString()}` : ''}`;
  el('chrome-state').textContent = c.chromeError || `${c.chromeAuthorized ? `已授权 ${c.chromeProfile}` : '未授权'}${c.lastChromeSync ? ` · 同步于 ${new Date(c.lastChromeSync).toLocaleString()}` : ''}`;
  const u = s.update;
  el('update-state').textContent = `当前 ${u.current}${u.latest ? ` · 上游 ${u.latest}` : ''} · ${({ idle: '就绪', checking: '检查中', available: '有可用更新，请确认安装', waiting: '等待下载空闲后安装', installing: '正在校验并安装', error: '发生错误' })[u.status]}${u.error ? `：${u.error}` : ''}`;
  el<HTMLButtonElement>('install-update').disabled = u.status !== 'available';
  el<HTMLButtonElement>('rollback').disabled = !u.previous || ['waiting', 'installing'].includes(u.status);
  renderTasks();
  el('playlist').hidden = !s.playlist;
  if (s.playlist) {
    if (playlistId !== s.playlist.id) { playlistId = s.playlist.id; page = 0; selected.clear(); input('all-entries').checked = false; }
    el('playlist-count').textContent = `${s.playlist.count} 项 · ${s.playlist.status === 'running' ? '解析中' : s.playlist.status === 'completed' ? '解析完成' : s.playlist.status === 'cancelled' ? '已停止' : '解析失败'}`;
    el('playlist-error').hidden = !s.playlist.error; el('playlist-error').textContent = s.playlist.error;
    el<HTMLButtonElement>('download-selected').disabled = s.playlist.status === 'running';
    void renderEntries().catch(e => notice(String(e), true));
  }
}
function renderTasks(): void {
  const count = state.tasks.length;
  taskPage = Math.min(taskPage, Math.max(0, Math.ceil(count / 30) - 1));
  const list = el('tasks'); list.replaceChildren();
  el('task-count').textContent = String(count);
  el('task-page').textContent = `${taskPage + 1} / ${Math.max(1, Math.ceil(count / 30))}`;
  el<HTMLButtonElement>('task-prev').disabled = taskPage === 0;
  el<HTMLButtonElement>('task-next').disabled = (taskPage + 1) * 30 >= count;
  if (!count) { list.append(text('div', '还没有任务。粘贴链接，开始你的第一次下载。', 'empty')); return; }
  for (const task of state.tasks.slice(taskPage * 30, (taskPage + 1) * 30).reverse()) {
    const row = text('div', '', 'task');
    const head = text('div', '', 'task-head');
    const badge = text('span', labels[task.status], 'badge');
    badge.dataset.status = task.status;
    head.append(text('div', task.title, 'task-title'), badge);
    const progress = document.createElement('progress'); progress.max = 100; progress.value = task.progress; progress.setAttribute('aria-label', '下载进度');
    row.append(head, progress, text('p', `${task.progress.toFixed(1)}% · ${task.speed || '—'} · 预计 ${task.eta || '—'}`, 'muted'), text('p', task.file || task.directory, 'muted'));
    if (task.error) row.append(text('p', task.error, 'warning'));
    const buttons = text('div', '', 'actions');
    if (['queued', 'syncing', 'downloading', 'processing'].includes(task.status)) buttons.append(action('取消', () => api.cancel(task.id)));
    if (['failed', 'cancelled', 'interrupted'].includes(task.status)) buttons.append(action('重试 / 尝试续传', () => api.retry(task.id)));
    if (task.status === 'completed') buttons.append(action('打开文件', () => api.openFile(task.id)), action('打开所在目录', () => api.showFile(task.id)));
    row.append(buttons); list.append(row);
  }
}
let entryRequest = 0;
async function renderEntries(): Promise<void> {
  const request = ++entryRequest;
  const entries = await api.playlistPage(page * 100);
  if (request !== entryRequest) return;
  const list = el('entries'); list.replaceChildren();
  for (const entry of entries) {
    const label = text('label', '', 'check entry');
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(entry.id);
    check.onchange = () => {
      if (check.checked) selected.add(entry.id); else selected.delete(entry.id);
      el('page-label').textContent = `第 ${page + 1} 页 · 已勾选 ${selected.size} 项`;
    };
    label.append(check, text('span', entry.title)); list.append(label);
  }
  el('page-label').textContent = `第 ${page + 1} 页 · 已勾选 ${selected.size} 项`;
  el<HTMLButtonElement>('prev-page').disabled = page === 0;
  el<HTMLButtonElement>('next-page').disabled = (page + 1) * 100 >= (state.playlist?.count || 0);
}
bind('download', async () => { const result = await api.enqueue({ urls: urls(), options: downloadOptions() }); notice(`已加入 ${result.added} 个任务，跳过 ${result.duplicates} 个重复项。`); });
bind('parse', async () => { const values = urls(); if (values.length !== 1) throw new Error('解析播放列表时请输入一个链接。'); await api.parsePlaylist({ url: values[0]!, cookie: downloadOptions().cookie }); });
bind('stop-parse', () => api.stopPlaylist());
bind('download-selected', async () => { const r = await api.enqueuePlaylist({ ids: [...selected], all: input('all-entries').checked, options: downloadOptions() }); notice(`已加入 ${r.added} 项，跳过 ${r.duplicates} 个重复项。`); });
bind('prev-page', async () => { page--; await renderEntries(); });
bind('next-page', async () => { page++; await renderEntries(); });
bind('task-prev', async () => { taskPage--; renderTasks(); });
bind('task-next', async () => { taskPage++; renderTasks(); });
bind('clear-tasks', () => api.clearFinished());
bind('choose-directory', async () => { const directory = await api.chooseDirectory(); if (directory) input('directory').value = directory; });
bind('save-settings', async () => {
  const proxy = input('clear-proxy').checked ? '' : input('proxy').value.trim() || undefined;
  await api.saveSettings({ ...state.settings, directory: input('directory').value, concurrency: Number(input('concurrency').value), checkUpdates: input('auto-update').checked, proxy });
  input('proxy').value = ''; input('clear-proxy').checked = false; notice('设置已保存。');
});
bind('import-cookies', () => api.importCookies(input('watch-file').checked));
bind('clear-cookies', () => api.clearCookies());
bind('sync-file', async () => { await api.syncCookies('file'); notice('Cookie 文件已重新加载。'); });
bind('detect-chrome', async () => {
  const profiles = await api.profiles(); const list = select('chrome-profile'); list.replaceChildren();
  for (const profile of profiles) { const option = document.createElement('option'); option.value = profile; option.textContent = profile; list.append(option); }
  if (!profiles.length) throw new Error('未检测到 Chrome 配置，请先启动 Chrome。');
  if (profiles.includes(state.settings.chromeProfile)) list.value = state.settings.chromeProfile;
});
bind('authorize-chrome', () => api.authorizeChrome(select('chrome-profile').value));
bind('revoke-chrome', () => api.revokeChrome());
bind('sync-chrome', async () => { await api.syncCookies('chrome'); notice('已读取最新 Cookie；只保留任务需要的临时副本。'); });
bind('check-update', () => api.checkUpdate());
bind('install-update', async () => { await api.installUpdate(); notice('已确认更新，将在下载与解析空闲时校验安装。'); });
bind('rollback', async () => { await api.rollback(); notice('已回滚下载引擎。'); });
select('kind').onchange = () => { const audio = select('kind').value === 'mp3'; select('height').disabled = audio; select('container').disabled = audio; };
api.onChange(s => render(s));
void api.snapshot().then(s => render(s, true)).catch(e => notice(`初始化失败：${String(e)}`, true));
