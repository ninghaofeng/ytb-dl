import path from 'node:path';
import type { DownloadOptions, Task } from '../shared/types';
import { streamSelection } from './validation';

export interface Tools { yt: string; ffmpeg: string; ffprobe: string; node: string }
export function commonArgs(tools: Tools, proxy: string, cookies: string): string[] {
  return ['--ignore-config', '--no-plugin-dirs', '--no-colors', '--encoding', 'utf-8', '--js-runtimes', `node:${tools.node}`, '--ffmpeg-location', path.dirname(tools.ffmpeg),
    '--socket-timeout', '30', '--retries', '3', '--proxy', proxy, ...(cookies ? ['--cookies', cookies] : [])];
}
export function formatArgs(o: DownloadOptions): string[] {
  if (o.selection) {
    const s = streamSelection(o.selection);
    return ['-f', s.combined || [s.video, s.audio].filter(Boolean).join('+'), ...(s.video && s.audio ? ['--merge-output-format', o.mergeFormat || 'mkv'] : [])];
  }
  if (o.kind === 'mp3') return ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  const height = o.height ? `[height<=${o.height}]` : '';
  if (o.container === 'mp4') return ['-f', `bestvideo[ext=mp4][vcodec^=avc1]${height}+bestaudio[ext=m4a]/best[ext=mp4][vcodec^=avc1]${height}`, '--merge-output-format', 'mp4'];
  return ['-f', `bestvideo${height}+bestaudio/best${height}`];
}
export function downloadArgs(t: Task, tools: Tools, proxy: string, cookies: string): string[] {
  return [...commonArgs(tools, proxy, cookies), '--no-playlist', '--continue', '--windows-filenames',
    '--newline', '--progress', '--progress-delta', '1',
    '--progress-template', 'download:DL:%(progress)j',
    '--progress-template', 'postprocess:PP:%(progress)j',
    '--print', 'before_dl:INFO:%(.{id,title})j',
    '--print', 'post_process:STAGE:%(id)j',
    '--print', 'after_move:FILE:%(filepath)j',
    '--no-simulate', '-o', path.join(t.directory, `${t.id.slice(0, 8)}-%(title).120B [%(id)s].%(ext)s`),
    ...formatArgs(t.options), '--', t.url];
}
