import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
const files = { '': ['index.html', 'text/html'], 'index.html': ['index.html', 'text/html'], 'app.js': ['app.js', 'text/javascript'], 'accounts.js': ['accounts.js', 'text/javascript'], 'rules-ui.js':['rules-ui.js','text/javascript'], 'rules-engine.js':['../lib/rules.js','text/javascript'], 'rules.css':['rules.css','text/css'], 'styles.css': ['styles.css', 'text/css'], 'import.css': ['import.css', 'text/css'], 'icon.svg': ['../icon.svg', 'image/svg+xml'] };
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 8 * 1024 * 1024) { const e = new Error('数据不能超过 8 MB'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求数据格式无效'); }
}
export function createHandler({ store, token, prefix = '/class-picker/' }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(prefix)) return false;
      const path = url.pathname.slice(prefix.length);
      if (path.startsWith('api/')) {
        const supplied = req.headers['x-class-picker-token'];
        if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { send(res, 401, { error: '连接凭证失效，请关闭选人窗口后刷新 Harness 页面' }); return true; }
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { send(res, 403, { error: '不允许跨站请求' }); return true; }
        const session = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('class_picker_session='))?.slice('class_picker_session='.length) || '';
        const reply = result => {
          const { session: fresh, ...publicData } = result;
          if (fresh) res.setHeader('set-cookie',`class_picker_session=${fresh}; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=604800${req.socket.encrypted ? '; Secure' : ''}`);
          send(res,200,publicData);
        };
        try {
          if (path === 'api/auth' && req.method === 'GET') reply(store.auth(session));
          else if (path === 'api/auth/register' && req.method === 'POST') reply(await store.register(await body(req)));
          else if (path === 'api/auth/login' && req.method === 'POST') reply(await store.login(await body(req)));
          else if (path === 'api/auth/logout' && req.method === 'POST') {
            const result = await store.logout(session);
            res.setHeader('set-cookie',`class_picker_session=; Path=${prefix}; HttpOnly; SameSite=Strict; Max-Age=0`); reply(result);
          }
          else if (path === 'api/auth/account' && req.method === 'POST') reply(await store.updateAccount(session,await body(req)));
          else if (path === 'api/state' && req.method === 'GET') reply(store.snapshot(session,url.searchParams.get('spaceId')));
          else if (path === 'api/spaces' && req.method === 'POST') reply(await store.manageSpace(session,await body(req)));
          else if (path === 'api/import-preview' && req.method === 'POST') reply(store.preview(session,await body(req)));
          else if (path === 'api/action' && req.method === 'POST') reply(await store.change(session,await body(req)));
          else send(res,404,{ error:'接口不存在或请求方法不正确' });
        } catch (e) {
          let latest = {};
          if (e.status === 409) { try { latest = store.snapshot(session,e.spaceId); } catch {} }
          send(res,e.status || 400,{ ...latest,error:e.message });
        }
      } else if (Object.hasOwn(files, path) && ['GET','HEAD'].includes(req.method)) {
        const [file, mime] = files[path];
        const content = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'content-type': `${mime}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'" });
        res.end(req.method === 'HEAD' ? undefined : content);
      } else send(res, 404, { error: '页面不存在' });
    } catch (e) { if (!res.headersSent) send(res, 400, { error: e.message }); else res.end(); }
    return true;
  };
}
