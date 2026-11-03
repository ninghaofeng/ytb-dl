const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const chapters = [{ start_time: 0, end_time: 2, title: 'Opening' }, { start_time: 2, end_time: 4, title: 'Ending' }];
if (args.includes('-show_chapters')) {
  console.log(fs.readFileSync(args.at(-1), 'utf8'));
  process.exit(0);
}
if (args.includes('--list-impersonate-targets')) {
  if (args.includes('chrome:Profile 99')) {
    setInterval(() => {}, 1000);
    return;
  }
  if (args.includes('chrome:Profile 98')) console.error('WARNING: failed to decrypt some cookies');
  fs.writeFileSync(args[args.indexOf('--cookies') + 1], '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tTEST\tfake-value\n');
  process.exit(0);
}
if (args.includes('--flat-playlist')) {
  console.log(JSON.stringify({ id: 'one', title: '<script>not html</script>', url: 'https://www.youtube.com/watch?v=one', ie_key: 'Youtube' }));
  console.log(JSON.stringify({ id: 'two', title: '第二项', url: 'https://www.youtube.com/watch?v=two', ie_key: 'Youtube' }));
  process.exit(0);
}
const metadata = args.includes('--load-info-json') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
const url = metadata?.original_url || args.at(-1);
if (url.includes('system-proxy-check') && args[args.indexOf('--proxy') + 1] !== 'http://127.0.0.1:8877/') {
  console.error('ERROR: expected resolved system proxy');
  process.exit(1);
}
if (args.includes('--dump-json')) {
  if (url.includes('inspect-slow')) { setInterval(() => {}, 1000); return; }
  if (url.includes('inspect-fail')) { console.error('ERROR: format extraction failed'); process.exit(1); }
  const second = url.includes('two');
  console.log(JSON.stringify({
    id: 'fixture', title: second ? '第二个视频' : '<script>格式测试</script>', original_url: url, chapters,
    subtitles: { en: [{ ext: 'vtt', name: '<English>', url: 'https://private.invalid/manual' }], 'zh-Hans': [{ ext: 'srt', url: 'https://private.invalid/chinese' }] },
    automatic_captions: url.includes('subs-disappeared') ? {} : { en: [{ ext: 'vtt', name: 'English', url: 'https://private.invalid/automatic' }] },
    formats: [
      { format_id: second ? 'v2' : 'v1', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, fps: 60, vbr: 2400, filesize_approx: 10485760, url: 'https://private.invalid/video?token=never-render' },
      { format_id: 'av1', ext: 'webm', vcodec: 'av01.0.08M.08', acodec: 'none', width: 1920, height: 1080, fps: 30, url: 'https://private.invalid/video' },
      { format_id: 'v720', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', width: 1280, height: 720, fps: 30, url: 'https://private.invalid/video720' },
      { format_id: 'portrait', ext: 'mp4', vcodec: 'avc1', acodec: 'none', width: 1080, height: 1920, fps: 30, url: 'https://private.invalid/portrait' },
      { format_id: 'unknown-resolution', ext: 'mp4', vcodec: 'avc1', acodec: 'none', url: 'https://private.invalid/unknown' },
      { format_id: second ? 'a2' : 'a1', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, asr: 48000, audio_channels: 2, language: 'zh', url: 'https://private.invalid/audio' },
      { format_id: 'flac', ext: 'flac', vcodec: 'none', acodec: 'flac', abr: 800, asr: 96000, audio_channels: 2, filesize: 20971520, url: 'https://private.invalid/lossless' },
      { format_id: 'muxed', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', width: 640, height: 360, fps: 30, tbr: 600, url: 'https://private.invalid/muxed' },
      { format_id: 'muxed720', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a.40.2', width: 1280, height: 720, fps: 30, url: 'https://private.invalid/muxed720' },
      { format_id: 'v2160', ext: 'webm', vcodec: 'vp09.00.51.08', acodec: 'none', width: 3840, height: 2160, fps: 60, url: 'https://private.invalid/video4k' },
      { format_id: 'drm', ext: 'mp4', vcodec: 'avc1', acodec: 'none', has_drm: true, url: 'https://private.invalid/drm' }
    ].filter(format => !url.includes('muxed-only') || format.format_id === 'muxed')
  }));
  process.exit(0);
}
if (url.includes('startup-wait')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
console.log('INFO:' + JSON.stringify({ id: 'fixture', title: '测试视频', chapters }));
console.log('DL:' + JSON.stringify({ downloaded_bytes: 50, total_bytes: 100, _speed_str: '1 MiB/s', _eta_str: '00:01' }));
if (url.includes('fail')) {
  if (url.includes('merge-fail')) console.log('STAGE:"fixture"');
  console.error('ERROR: cookie=secret https://user:password@host/path?token=secret');
  process.exit(1);
}
if (url.includes('slow')) {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const marker = args[args.indexOf('-o') + 1].replace(/%\([^)]+\)[^ .\]]*/g, 'fixture') + '.pid';
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    console.log('PP:' + JSON.stringify({ status: 'processing' }));
    if (!url.includes('missing') || url.includes('missing-subs')) {
      const filename = path.join(path.dirname(args[args.indexOf('-o') + 1]), '输出 fixture.mp4');
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, JSON.stringify({
        chapters: args.includes('--embed-chapters') ? chapters.map(chapter => ({ ...chapter, tags: { title: chapter.title } })) : [],
        streams: url.includes('missing-subs') ? [] : Object.values(metadata?.subtitles || {}).map(entries => ({ codec_type: 'subtitle', tags: { title: entries[0].name } }))
      }));
      console.log('FILE:' + JSON.stringify(filename));
    }
    process.exit(0);
  }, url.includes('transfer-delay') ? 1200 : 100);
}
