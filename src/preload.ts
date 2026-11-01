import { contextBridge, ipcRenderer } from 'electron';
import type { Api, Snapshot } from './shared/types';

const api: Api = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  saveSettings: input => ipcRenderer.invoke('saveSettings', input),
  chooseDirectory: () => ipcRenderer.invoke('chooseDirectory'),
  importCookies: watch => ipcRenderer.invoke('importCookies', watch),
  clearCookies: () => ipcRenderer.invoke('clearCookies'),
  authorizeChrome: profile => ipcRenderer.invoke('authorizeChrome', profile),
  revokeChrome: () => ipcRenderer.invoke('revokeChrome'),
  syncCookies: mode => ipcRenderer.invoke('syncCookies', mode),
  profiles: () => ipcRenderer.invoke('profiles'),
  enqueue: input => ipcRenderer.invoke('enqueue', input),
  parsePlaylist: input => ipcRenderer.invoke('parsePlaylist', input),
  playlistPage: offset => ipcRenderer.invoke('playlistPage', offset),
  stopPlaylist: () => ipcRenderer.invoke('stopPlaylist'),
  enqueuePlaylist: input => ipcRenderer.invoke('enqueuePlaylist', input),
  cancel: id => ipcRenderer.invoke('cancel', id),
  retry: id => ipcRenderer.invoke('retry', id),
  clearFinished: () => ipcRenderer.invoke('clearFinished'),
  openFile: id => ipcRenderer.invoke('openFile', id),
  showFile: id => ipcRenderer.invoke('showFile', id),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  rollback: () => ipcRenderer.invoke('rollback'),
  onChange: listener => {
    const callback = (_: Electron.IpcRendererEvent, state: Snapshot) => listener(state);
    ipcRenderer.on('state', callback);
    return () => ipcRenderer.removeListener('state', callback);
  }
};
contextBridge.exposeInMainWorld('downloader', api);
