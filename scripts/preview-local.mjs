import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve('E:/ai比赛/交互端/docs/coordination/demo-runs/20261023-local-01/web-current-local');
await stat(resolve(web, 'index.html')).catch(() => {
  throw new Error('尚未生成网页原型，请先运行 scripts/build-demo.ps1。');
});
for (const resource of ['main.dart.js', 'assets/FontManifest.json', 'assets/fonts/MaterialIcons-Regular.otf', 'assets/assets/demo-practice.pdf']) {
  const entry = await stat(resolve(web, resource)).catch(() => { throw new Error(`网页资源缺失：${resource}。请重新运行 scripts/build-demo.ps1。`); });
  if (!entry.isFile() || entry.size === 0) throw new Error(`网页资源为空：${resource}`);
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const file = resolve(web, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(web + sep)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { response.writeHead(404).end('Not found'); }
});
await new Promise((done, fail) => { server.once('error', fail); server.listen(18766, '127.0.0.1', done); });
const backend = spawn(process.execPath, [resolve(root, 'mock-server/server.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (backend.exitCode === null) backend.kill('SIGTERM');
  server.close();
  server.closeAllConnections();
  process.exitCode = code;
}
backend.once('error', error => { console.error(error.message); stop(1); });
backend.once('exit', code => { if (!closing) stop(code || 1); });
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('知行网页原型：http://127.0.0.1:18766（仅虚拟材料；Ctrl+C 结束本次预览）');
