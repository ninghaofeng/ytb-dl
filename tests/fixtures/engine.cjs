const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
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
const url = args.at(-1);
console.log('INFO:' + JSON.stringify({ id: 'fixture', title: '测试视频' }));
console.log('DL:' + JSON.stringify({ downloaded_bytes: 50, total_bytes: 100, _speed_str: '1 MiB/s', _eta_str: '00:01' }));
if (url.includes('fail')) {
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
    if (!url.includes('missing')) {
      const filename = path.join(path.dirname(args[args.indexOf('-o') + 1]), '输出 fixture.mp4');
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, 'fixture media');
      console.log('FILE:' + JSON.stringify(filename));
    }
    process.exit(0);
  }, 100);
}
