import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const files = (await readdir('release')).filter(f => /\.(exe|zip)$/.test(f));
if (!files.length) throw new Error('No packaged artifacts');
const lines = await Promise.all(files.map(async file => `${createHash('sha256').update(await readFile(`release/${file}`)).digest('hex')}  ${file}`));
await writeFile('release/SHA256SUMS.txt', lines.join('\n') + '\n');
