import type { Chapter, SubtitleSelection, SubtitleTrack } from '../shared/types';
import { subtitleSelection } from './validation';

export interface InspectedSource {
  url: string;
  cookieIdentity: string;
  proxy: string;
  inspectedAt: number;
  raw: Record<string, unknown>;
}
export const inspectionLifetime = 5 * 60 * 1000;
const subtitleFormats = ['vtt', 'srt', 'ass', 'ssa'];
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function subtitleLanguage(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) && value !== 'live_chat';
}
function candidates(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).map(record).filter(row =>
    typeof row.ext === 'string' && subtitleFormats.includes(row.ext) &&
    (typeof row.url === 'string' || typeof row.data === 'string'));
}
export function sourceChapters(value: unknown): Chapter[] {
  const raw = record(value);
  return (Array.isArray(raw.chapters) ? raw.chapters : []).map(record).flatMap(chapter =>
    typeof chapter.start_time === 'number' && Number.isFinite(chapter.start_time) && chapter.start_time >= 0 &&
    typeof chapter.end_time === 'number' && Number.isFinite(chapter.end_time) && chapter.end_time > chapter.start_time
      ? [{ title: typeof chapter.title === 'string' ? chapter.title.slice(0, 1000) : '', start: chapter.start_time, end: chapter.end_time }] : []);
}
export function sourceSubtitles(value: unknown): SubtitleTrack[] {
  const raw = record(value);
  const tracks: SubtitleTrack[] = [];
  for (const [source, field] of [['manual', 'subtitles'], ['automatic', 'automatic_captions']] as const) {
    for (const [language, entries] of Object.entries(record(raw[field]))) {
      if (!subtitleLanguage(language)) continue;
      const usable = candidates(entries);
      if (!usable.length) continue;
      const name = usable.find(row => typeof row.name === 'string')?.name;
      tracks.push({ language, source, name: typeof name === 'string' ? name.slice(0, 500) : language,
        formats: [...new Set(usable.map(row => String(row.ext)))] });
    }
  }
  return tracks;
}
export function validateSubtitles(available: SubtitleTrack[], value: unknown): SubtitleSelection[] {
  const selected = subtitleSelection(value);
  for (const track of selected) {
    if (!available.some(row => row.language === track.language && row.source === track.source)) {
      throw new Error(`所选字幕 ${track.language}（${track.source === 'manual' ? '人工' : '自动生成'}）已不可用，请重新解析。`);
    }
  }
  return selected;
}
export function subtitleName(track: SubtitleSelection): string {
  return `${track.language} (${track.source === 'manual' ? 'manual' : 'automatic'})`;
}
export function prepareSubtitleMetadata(value: unknown, selection: SubtitleSelection[]): Record<string, unknown> {
  const raw = record(value);
  const selected = validateSubtitles(sourceSubtitles(raw), selection);
  const subtitles: Record<string, unknown> = {};
  for (const [index, track] of selected.entries()) {
    const entries = candidates(record(raw[track.source === 'manual' ? 'subtitles' : 'automatic_captions'])[track.language]);
    const entry = subtitleFormats.flatMap(ext => entries.filter(row => row.ext === ext)).at(0)!;
    // Unique keys keep manual and automatic tracks of the same language distinct.
    subtitles[`${track.language}-ytbdl-${index}`] = [{ ...entry, name: subtitleName(track) }];
  }
  return { ...raw, subtitles, automatic_captions: {}, requested_subtitles: undefined, webpage_url: undefined };
}
export function verifyEmbedded(value: unknown, subtitles: SubtitleSelection[], chapters: Chapter[]): void {
  const raw = record(value);
  const streams = (Array.isArray(raw.streams) ? raw.streams : []).map(record).filter(row => row.codec_type === 'subtitle');
  for (const track of subtitles) {
    if (!streams.some(stream => {
      const tags = record(stream.tags);
      return tags.title === subtitleName(track) || tags.handler_name === subtitleName(track);
    })) throw new Error(`字幕 ${subtitleName(track)} 未成功内挂；不会将此任务标记为成功。请改用 MKV 或重新解析。`);
  }
  const embedded = (Array.isArray(raw.chapters) ? raw.chapters : []).map(record);
  if (chapters.length && (embedded.length !== chapters.length || chapters.some((chapter, i) =>
    !Number.isFinite(Number(embedded[i]?.start_time)) || Math.abs(Number(embedded[i]?.start_time) - chapter.start) > 0.1 ||
    !Number.isFinite(Number(embedded[i]?.end_time)) || Math.abs(Number(embedded[i]?.end_time) - chapter.end) > 0.1 ||
    String(record(embedded[i]?.tags).title ?? '').slice(0, 1000) !== chapter.title))) {
    throw new Error('章节信息未完整嵌入当前容器；不会将此任务标记为成功。请改用 MKV。');
  }
}
