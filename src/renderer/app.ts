import type { Compression, CookieMode, FormatInspection, Snapshot, SourceFormat, StreamSelection, TaskStatus } from '../shared/types';

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
    finally { button.disabled = false; pickerControls(); }
  });
}
function cookieMode(): CookieMode { return select('cookie').value as CookieMode; }
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
  pickerControls();
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
    if (task.options.selection) row.append(text('p', selectionLabel(task.options.selection), 'muted'));
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
let formatBatch: { urls: string[]; cookie: CookieMode; index: number; added: number; duplicates: number } | undefined;
let inspection: FormatInspection | undefined;
let formatLoading = false, formatSubmitting = false, formatClosing = false;
function selectionLabel(s: StreamSelection): string {
  if (s.combined) return `音视频合一流 #${s.combined} · 原容器，不重新编码`;
  return [s.video ? `视频 #${s.video}` : '', s.audio ? `音频 #${s.audio}` : ''].filter(Boolean).join(' + ') +
    (s.video && s.audio ? ' · 合并为 MKV，不重新编码' : ' · 保留源格式，不重新编码');
}
function chosenStreams(): StreamSelection {
  const chosen = (type: string): string | undefined => el('format-content').querySelector<HTMLInputElement>(`input[name="source-${type}"]:checked`)?.value;
  const mode = select('stream-mode').value;
  if (mode === 'combined') return chosen('combined') ? { combined: chosen('combined') } : {};
  return { ...(['separate', 'video'].includes(mode) && chosen('video') ? { video: chosen('video') } : {}), ...(['separate', 'audio'].includes(mode) && chosen('audio') ? { audio: chosen('audio') } : {}) };
}
function resolutionKey(format: SourceFormat): string { return `${format.width ?? '?'}x${format.height ?? '?'}`; }
function resolutionLabel(format: SourceFormat): string {
  const { width, height } = format;
  if (width !== null && height !== null) {
    const quality = width < height ? '竖屏' : `${height === 2160 ? '4K · ' : height === 4320 ? '8K · ' : ''}${height}p`;
    return `${width} × ${height} / ${quality}`;
  }
  if (height !== null) return `${height}p（宽度未知）`;
  if (width !== null) return `宽 ${width}（高度未知）`;
  return '分辨率未知';
}
function resolutionOptions(reset = false): void {
  const list = select('resolution'), previous = reset ? 'all' : list.value;
  const type = select('stream-mode').value === 'combined' ? 'combined' : 'video';
  const choices = new Map<string, SourceFormat>();
  for (const format of inspection?.formats || []) if (format.type === type) choices.set(resolutionKey(format), format);
  list.replaceChildren();
  const all = document.createElement('option'); all.value = 'all'; all.textContent = '全部分辨率'; list.append(all);
  const area = (f: SourceFormat): number => (f.height || 0) * (f.width || f.height || 0);
  for (const [key, format] of [...choices].sort((a, b) => area(b[1]) - area(a[1]))) {
    const option = document.createElement('option'); option.value = key; option.textContent = resolutionLabel(format); list.append(option);
  }
  list.value = choices.has(previous) ? previous : 'all';
}
function filterResolution(): void {
  for (const type of ['video', 'combined'] as const) {
    const host = el(`${type}-table`);
    const previous = host.querySelector<HTMLInputElement>('input:checked')?.value;
    const formats = inspection?.formats.filter(f => f.type === type && (select('resolution').value === 'all' || resolutionKey(f) === select('resolution').value)) || [];
    renderFormatTable(type, formats);
    for (const radio of Array.from(host.querySelectorAll<HTMLInputElement>('input'))) radio.checked = radio.value === previous;
  }
  pickerControls();
}
function pickerControls(): void {
  const selecting = !!formatBatch || formatClosing;
  el<HTMLButtonElement>('download').disabled = selecting;
  el<HTMLButtonElement>('parse').disabled = selecting;
  el<HTMLButtonElement>('download-selected').disabled = selecting || state?.playlist?.status === 'running';
  select('cookie').disabled = selecting;
  const mode = select('stream-mode').value;
  el('video-formats').hidden = !['separate', 'video'].includes(mode);
  el('audio-formats').hidden = !['separate', 'audio'].includes(mode);
  el('combined-formats').hidden = mode !== 'combined';
  const s = chosenStreams();
  const valid = mode === 'separate' ? s.video && s.audio : mode === 'combined' ? s.combined : mode === 'video' ? s.video : s.audio;
  el<HTMLButtonElement>('confirm-formats').disabled = !inspection || !valid || formatLoading || formatSubmitting || formatClosing;
  el<HTMLButtonElement>('retry-formats').disabled = formatLoading || formatSubmitting || formatClosing;
  el<HTMLButtonElement>('skip-formats').disabled = formatLoading || formatSubmitting || formatClosing;
  el<HTMLButtonElement>('cancel-formats').disabled = formatSubmitting || formatClosing;
  select('stream-mode').disabled = formatSubmitting;
  el('resolution-control').hidden = mode === 'audio';
  el('resolution-hint').hidden = mode === 'audio';
  select('resolution').disabled = !inspection || formatLoading || formatSubmitting || formatClosing;
  for (const radio of Array.from(el('format-content').querySelectorAll<HTMLInputElement>('input'))) radio.disabled = formatSubmitting;
  const video = inspection?.formats.find(f => f.id === (s.video || s.combined));
  el('format-summary').textContent = valid ? `${video ? `${resolutionLabel(video)} · ` : ''}${selectionLabel(s)}` : '请明确选择分辨率和具体格式；不会自动替你选择或降级到其他编码。';
}
function codecLabel(codec: string, value: Compression): string {
  if (codec === 'none') return '无';
  if (codec === 'unknown') return '未知';
  return `${codec} · ${{ lossy: '通常有损（编码推断）', lossless: '无损编码', unknown: '压缩属性未知' }[value]}`;
}
function numberLabel(value: number | null, unit: string): string { return value === null ? '未知' : `${Number(value.toFixed(2))}${unit}`; }
function renderFormatTable(type: SourceFormat['type'], formats: SourceFormat[]): void {
  const host = el(`${type}-table`); host.replaceChildren();
  if (!formats.length) { host.append(text('p', '当前分辨率下未提供此类可下载流。', 'muted')); return; }
  const scroll = text('div', '', 'format-scroll'); scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', `${{ video: '视频', audio: '音频', combined: '音视频合一' }[type]}格式列表，可横向滚动`);
  const table = document.createElement('table'); table.className = 'format-table';
  table.append(text('caption', `${type} 可用源格式`));
  const header = document.createElement('thead'), headings = document.createElement('tr');
  for (const title of ['选择', 'ID / 容器', '视频编码', '分辨率 / FPS', '音频编码', '视频 / 音频 / 总码率', '采样率 / 声道', '语言 / 动态范围', '文件大小']) {
    const th = text('th', title); th.setAttribute('scope', 'col'); headings.append(th);
  }
  header.append(headings); table.append(header);
  const body = document.createElement('tbody');
  for (const [index, format] of formats.entries()) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = `source-${type}`; radio.value = format.id;
    radio.id = `format-${type}-${index}`; radio.setAttribute('aria-label', `选择格式 ${format.id}`); radio.onchange = pickerControls;
    cell.append(radio); row.append(cell);
    const identity = document.createElement('td'), label = document.createElement('label');
    label.htmlFor = radio.id; label.textContent = `#${format.id} / ${format.ext}`; identity.append(label); row.append(identity);
    const size = format.size === null ? '未知' : `${format.approximateSize ? '约 ' : ''}${(format.size / 1024 / 1024).toFixed(2)} MiB`;
    for (const value of [
      codecLabel(format.videoCodec, format.videoCompression),
      format.type === 'audio' ? '不适用' : `${numberLabel(format.width, '')} × ${numberLabel(format.height, '')} / ${numberLabel(format.fps, ' fps')}`,
      codecLabel(format.audioCodec, format.audioCompression),
      [format.videoBitrate, format.audioBitrate, format.totalBitrate].map(n => numberLabel(n, ' kbps')).join(' / '),
      format.type === 'video' ? '不适用' : `${numberLabel(format.sampleRate, ' Hz')} / ${numberLabel(format.channels, ' 声道')}`,
      `${format.language || '未知'} / ${format.dynamicRange || '未知'}`, size
    ]) row.append(text('td', value));
    body.append(row);
  }
  table.append(body); scroll.append(table); host.append(scroll);
}
async function loadFormats(): Promise<void> {
  const batch = formatBatch;
  if (!batch) return;
  inspection = undefined; formatLoading = true;
  for (const type of ['video', 'audio', 'combined']) el(`${type}-table`).replaceChildren();
  el('format-content').hidden = true; el('format-error').hidden = true; el('format-loading').hidden = false;
  el('format-position').textContent = `${batch.index + 1} / ${batch.urls.length}`;
  el('format-title').textContent = '正在解析视频';
  el('format-url').textContent = batch.urls[batch.index]!;
  pickerControls();
  try {
    const result = await api.inspectFormats({ url: batch.urls[batch.index]!, cookie: batch.cookie });
    if (formatBatch !== batch || formatClosing) return;
    inspection = result;
    el('format-title').textContent = result.title;
    renderFormatTable('audio', result.formats.filter(f => f.type === 'audio'));
    const has = (type: SourceFormat['type']): boolean => result.formats.some(f => f.type === type);
    for (const option of Array.from(select('stream-mode').options)) option.disabled = option.value === 'separate' ? !has('video') || !has('audio') : !has(option.value as SourceFormat['type']);
    select('stream-mode').value = has('video') && has('audio') ? 'separate' : has('combined') ? 'combined' : has('video') ? 'video' : 'audio';
    resolutionOptions(true);
    filterResolution();
    el('format-content').hidden = false;
  } catch (error) {
    if (formatBatch !== batch || formatClosing) return;
    const message = error instanceof Error ? error.message : String(error);
    el('format-error').textContent = message; el('format-error').hidden = false;
    el('format-title').textContent = '格式解析失败'; notice(message, true);
  } finally {
    if (formatBatch === batch) {
      formatLoading = false; el('format-loading').hidden = true; pickerControls();
    }
  }
}
async function chooseFormats(values: string[], cookie: CookieMode): Promise<void> {
  if (formatBatch || formatClosing) throw new Error('请先结束当前的格式选择。');
  if (!values.length) throw new Error('请输入至少一个视频链接。');
  formatBatch = { urls: [...new Set(values)], cookie, index: 0, added: 0, duplicates: 0 };
  el('format-picker').hidden = false;
  el('format-picker').scrollIntoView({ block: 'start', behavior: 'instant' });
  await loadFormats();
}
async function nextFormat(): Promise<void> {
  if (!formatBatch) return;
  formatBatch.index++;
  if (formatBatch.index < formatBatch.urls.length) await loadFormats();
  else {
    const { added, duplicates } = formatBatch;
    await api.cancelInspection();
    formatBatch = undefined; inspection = undefined;
    el('format-picker').hidden = true; pickerControls();
    notice(`格式选择结束：已加入 ${added} 项，跳过 ${duplicates} 个重复任务。未确认的视频不会下载。`);
  }
}
select('stream-mode').onchange = () => { resolutionOptions(); filterResolution(); };
select('resolution').onchange = filterResolution;
el('confirm-formats').addEventListener('click', () => {
  if (!inspection || formatSubmitting || formatLoading) return;
  formatSubmitting = true; pickerControls();
  void (async () => {
    try {
      const result = await api.enqueueFormats({ inspection: inspection!.id, selection: chosenStreams() });
      if (formatBatch) { formatBatch.added += result.added; formatBatch.duplicates += result.duplicates; }
      await nextFormat();
    } catch (error) { notice(error instanceof Error ? error.message : String(error), true); }
    finally { formatSubmitting = false; pickerControls(); }
  })();
});
bind('retry-formats', loadFormats);
bind('skip-formats', nextFormat);
bind('cancel-formats', async () => {
  const batch = formatBatch;
  formatClosing = true; pickerControls();
  try {
    await api.cancelInspection();
    formatBatch = undefined; inspection = undefined;
    el('format-picker').hidden = true;
    notice(`已结束格式选择。已确认的 ${batch?.added || 0} 项任务继续运行，未确认的视频不会下载。`);
  } finally { formatClosing = false; formatLoading = false; el('format-loading').hidden = true; pickerControls(); }
});
bind('download', () => chooseFormats(urls(), cookieMode()));
bind('parse', async () => { const values = urls(); if (values.length !== 1) throw new Error('解析播放列表时请输入一个链接。'); await api.parsePlaylist({ url: values[0]!, cookie: cookieMode() }); });
bind('stop-parse', () => api.stopPlaylist());
bind('download-selected', async () => { const entries = await api.selectedPlaylist({ ids: [...selected], all: input('all-entries').checked }); await chooseFormats(entries.map(e => e.url), cookieMode()); });
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
api.onChange(s => render(s));
void api.snapshot().then(s => render(s, true)).catch(e => notice(`初始化失败：${String(e)}`, true));
