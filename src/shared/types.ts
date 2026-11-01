export type CookieMode = 'none' | 'file' | 'chrome';
export type TaskStatus = 'queued' | 'syncing' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface DownloadOptions {
  kind: 'video' | 'mp3';
  container: 'original' | 'mp4';
  height: number;
  cookie: CookieMode;
}
export interface Task {
  id: string;
  url: string;
  title: string;
  directory: string;
  options: DownloadOptions;
  status: TaskStatus;
  progress: number;
  speed: string;
  eta: string;
  error: string;
  file: string;
  createdAt: string;
}
export interface Settings {
  directory: string;
  concurrency: number;
  checkUpdates: boolean;
  chromeProfile: string;
  chromeAuthorized: boolean;
  watchCookies: boolean;
}
export interface CookieInfo {
  file: boolean;
  watching: boolean;
  chromeAuthorized: boolean;
  chromeProfile: string;
  lastFileSync: string;
  lastChromeSync: string;
  fileError: string;
  chromeError: string;
}
export interface PlaylistEntry { id: string; url: string; title: string }
export interface Playlist {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  count: number;
  error: string;
}
export interface UpdateInfo {
  current: string;
  latest: string;
  previous: string;
  status: 'idle' | 'checking' | 'available' | 'waiting' | 'installing' | 'error';
  error: string;
}
export interface Snapshot {
  settings: Settings;
  cookies: CookieInfo;
  tasks: Task[];
  playlist: Playlist | null;
  update: UpdateInfo;
  warning: string;
  proxyConfigured: boolean;
}
export interface Api {
  snapshot(): Promise<Snapshot>;
  saveSettings(input: Settings & { proxy?: string }): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  importCookies(watch: boolean): Promise<void>;
  clearCookies(): Promise<void>;
  authorizeChrome(profile: string): Promise<void>;
  revokeChrome(): Promise<void>;
  syncCookies(mode: CookieMode): Promise<void>;
  profiles(): Promise<string[]>;
  enqueue(input: { urls: string[]; options: DownloadOptions }): Promise<{ added: number; duplicates: number }>;
  parsePlaylist(input: { url: string; cookie: CookieMode }): Promise<void>;
  playlistPage(offset: number): Promise<PlaylistEntry[]>;
  stopPlaylist(): Promise<void>;
  enqueuePlaylist(input: { ids: string[]; all: boolean; options: DownloadOptions }): Promise<{ added: number; duplicates: number }>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  openFile(id: string): Promise<void>;
  showFile(id: string): Promise<void>;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  rollback(): Promise<void>;
  onChange(listener: (snapshot: Snapshot) => void): () => void;
}
declare global { interface Window { downloader: Api } }
