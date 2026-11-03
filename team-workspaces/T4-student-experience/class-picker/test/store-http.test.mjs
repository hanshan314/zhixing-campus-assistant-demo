import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:http';
import { createStore } from '../lib/store.js';
import { createHandler } from '../lib/http.js';
import { createAccountStore } from '../lib/accounts.js';
import { apply as plugin, inject } from '../index.js';
async function fixture(t) {
  const root = resolve(import.meta.dirname,'../.test-data');
  await mkdir(root,{ recursive:true });
  const dir = await mkdtemp(join(root,'test-'));
  t.after(() => {
    if (!resolve(dir).startsWith(root + sep)) throw new Error('Test cleanup path escaped its root');
    return rm(dir,{ recursive:true,force:true });
  });
  const file = join(dir,'state.json'), store = await createStore(file);
  return { dir,file,store };
}
test('atomic persistence, reload and previous-version backup',async t => {
  const { store,file } = await fixture(t);
  await store.change({ revision:0,operation:'import',source:'示例一\n示例二' });
  await store.change({ revision:1,operation:'rename',name:'测试班' });
  assert.equal((await createStore(file)).snapshot().className,'测试班');
  assert.equal(JSON.parse(await readFile(file+'.backup','utf8')).revision,1);
});
test('simultaneous changes conflict instead of overwriting counts',async t => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    store.change({ revision:0,operation:'rename',name:'甲班' }),
    store.change({ revision:0,operation:'rename',name:'乙班' })
  ]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].reason.status,409);
  assert.equal(store.snapshot().className,'甲班');
});
test('production random source draws, confirms, reloads and undoes correctly',async t => {
  const { store,file } = await fixture(t);
  await store.change({ revision:0,operation:'import',source:'示例一,01,2\n示例二,02,0\n示例三,03,1' });
  const draw = await store.change({ revision:1,operation:'draw',count:2,strength:1,name:'班会' });
  assert.equal(draw.state.pending.ids.length,2);
  const result = await store.change({ revision:2,operation:'confirm',id:draw.state.pending.id });
  assert.equal(result.state.events.length,1);
  const reloaded = await createStore(file);
  const undone = await reloaded.change({ revision:3,operation:'undo',id:result.state.events[0].id });
  assert.equal(undone.state.events[0].undone,true);
});
test('failed disk write leaves memory and persisted data unchanged',async t => {
  const { store,file } = await fixture(t);
  await store.change({ revision:0,operation:'rename',name:'原班级' });
  await mkdir(file+'.backup');
  await assert.rejects(store.change({ revision:1,operation:'rename',name:'不能保存' }));
  assert.equal(store.snapshot().className,'原班级');
  assert.equal(JSON.parse(await readFile(file,'utf8')).className,'原班级');
});
test('corrupt data is reported and never silently replaced',async t => {
  const { file } = await fixture(t); await writeFile(file,'broken-json');
  await assert.rejects(createStore(file),/原文件已保留/);
  assert.equal(await readFile(file,'utf8'),'broken-json');
});
test('HTTP authentication, cookies, CSP, origin checks, conflicts, and no traversal',async t => {
  const { file } = await fixture(t), store = await createAccountStore(file), token = 'test-token';
  const handler = createHandler({ store,token });
  const server = createServer(async(req,res) => { if (!(await handler(req,res))) { res.writeHead(404);res.end(); } });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/class-picker/`;
  assert.equal((await fetch(base+'api/state')).status,401);
  const headers = { 'x-class-picker-token':token,'content-type':'application/json' };
  assert.equal((await fetch(base+'api/state',{ headers })).status,401);
  assert.equal((await fetch(base+'api/state',{ headers:{ ...headers,origin:'https://evil.example' } })).status,403);
  const html = await fetch(base);
  assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  assert.match(await html.text(),/账号与抽签/);
  const registration = await fetch(base+'api/auth/register',{ method:'POST',headers,body:JSON.stringify({ username:'http-user',password:'test-password',displayName:'老师',role:'teacher' }) });
  assert.equal(registration.status,200);
  assert.match(registration.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const account = await registration.json(); assert.equal(account.session,undefined); assert.equal(account.account.passwordHash,undefined);
  headers.cookie = registration.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'api/state',{ headers })).status,200);
  const previewResponse = await fetch(base+'api/import-preview',{ method:'POST',headers,body:JSON.stringify({ spaceId:account.spaceId,source:'101 高一（1）班\n102 高一（2）班' }) });
  assert.equal(previewResponse.status,200);
  const preview = await previewResponse.json(); assert.equal(preview.rows[0].name,'高一（1）班');
  assert.equal(store.snapshot(headers.cookie.slice('class_picker_session='.length),account.spaceId).state.revision,0);
  assert.equal((await fetch(base+'api/action',{ method:'POST',headers,body:JSON.stringify({ spaceId:account.spaceId,revision:0,operation:'import',source:'高一一班\n高一二班' }) })).status,200);
  assert.equal((await fetch(base+'api/action',{ method:'POST',headers,body:JSON.stringify({ spaceId:account.spaceId,revision:0,operation:'rename',name:'过时更新' }) })).status,409);
  assert.equal((await fetch(base+'%2e%2e/package.json')).status,404);
  assert.equal((await fetch(base+'api/action',{ method:'POST',headers,body:'null' })).status,400);
  await fetch(base+'api/auth/logout',{ method:'POST',headers,body:'{}' });
  assert.equal((await fetch(base+'api/state',{ headers })).status,401);
});
test('Harness plugin registers its scoped route, bootstrap and disposal',async t => {
  const { file } = await fixture(t); let route, transform; const cleanups = [];
  const ctx = { webServer:{ register(r) { route = r; return () => { route = null; }; }, tapIndex(fn) { transform = fn; return () => { transform = null; }; } }, effect(fn) { cleanups.push(fn()); } };
  assert.deepEqual(inject,['webServer']);
  await plugin(ctx,{ dataFile:file });
  assert.equal(route.kind,'prefix'); assert.equal(route.path,'/class-picker/');
  assert.match(transform('<html><head></head><body></body></html>'),/__DSH_CLASS_PICKER__/);
  for (const fn of cleanups) fn();
  assert.equal(route,null); assert.equal(transform,null);
});
