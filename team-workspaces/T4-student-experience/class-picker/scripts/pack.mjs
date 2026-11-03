import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname,'..');
const manifest = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const paths = [];
async function walk(path) {
  if ((await stat(path)).isDirectory()) { for (const name of (await readdir(path)).sort()) await walk(join(path,name)); }
  else paths.push(path);
}
await walk(join(root,'package.json'));
for (const path of manifest.files) if (!path.includes('*')) await walk(join(root,path));
const chunks = [];
for (const path of paths) {
  const name = 'package/' + relative(root,path).replaceAll('\\','/');
  if (Buffer.byteLength(name) > 100) throw new Error('Archive path too long');
  const data = await readFile(path), header = Buffer.alloc(512);
  const put = (s,offset,size) => header.write(s,offset,size,'utf8');
  const octal = (n,size) => n.toString(8).padStart(size-1,'0')+'\0';
  put(name,0,100); put(octal(0o644,8),100,8); put(octal(0,8),108,8); put(octal(0,8),116,8);
  put(octal(data.length,12),124,12); put(octal(0,12),136,12); put('        ',148,8);
  put('0',156,1); put('ustar\0',257,6); put('00',263,2);
  const checksum = header.reduce((sum,n) => sum+n,0);
  put(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
  chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));
}
chunks.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(chunks)), name = `dsh-class-picker-${manifest.version}.tgz`;
await writeFile(join(root,name),archive);
await writeFile(join(root,name+'.sha256'),createHash('sha256').update(archive).digest('hex')+'  '+name+'\n');
console.log(`Created ${name}: ${paths.length} files, ${archive.length} bytes`);
