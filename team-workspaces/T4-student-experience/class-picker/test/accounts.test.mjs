import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createAccountStore } from '../lib/accounts.js';
import { initialState, totals } from '../lib/core.js';
async function fixture(t,options) {
  const root = resolve(import.meta.dirname,'../.test-data'); await mkdir(root,{ recursive:true });
  const dir = await mkdtemp(join(root,'accounts-'));
  t.after(() => { if (!resolve(dir).startsWith(root+sep)) throw new Error('Invalid cleanup path'); return rm(dir,{ recursive:true,force:true }); });
  const file = join(dir,'state.json'); return { file,store:await createAccountStore(file,options) };
}
const registration = (username,role = 'class') => ({ username,password:'test-pass-123',displayName:username,role });
test('registration hashes passwords, keeps private account data off snapshots and persists login',async t => {
  const { store,file } = await fixture(t), input = registration('teacher1','teacher');
  const result = await store.register(input);
  assert.equal(result.state.scenario,'teacher');
  assert.equal(store.auth(result.session).account.username,'teacher1');
  const raw = await readFile(file,'utf8');
  assert.ok(!raw.includes(input.password)); assert.match(raw,/passwordHash/);
  const snapshot = store.snapshot(result.session,result.spaceId);
  assert.equal(snapshot.passwordHash,undefined); assert.equal(snapshot.account.salt,undefined); assert.equal(snapshot.session,undefined);
  const reloaded = await createAccountStore(file);
  assert.equal(reloaded.auth(result.session).authenticated,true);
  await assert.rejects(store.register(input),/已被使用/);
  await assert.rejects(store.register({ ...input,username:'other',password:'short' }),/8–128/);
});
test('accounts cannot read, edit, delete or confirm each other’s spaces',async t => {
  const { store } = await fixture(t), a = await store.register(registration('account-a')), b = await store.register(registration('account-b','club'));
  const foreign = { spaceId:a.spaceId,revision:0,operation:'import',source:'仅甲可见' };
  assert.throws(() => store.snapshot(b.session,a.spaceId),e => e.status === 404);
  await assert.rejects(store.change(b.session,foreign),e => e.status === 404);
  await assert.rejects(store.manageSpace(b.session,{ operation:'delete',spaceId:a.spaceId,revision:0 }),e => e.status === 404);
  const edited = await store.change(a.session,foreign);
  assert.equal(edited.state.students[0].name,'仅甲可见');
  assert.equal(store.snapshot(b.session,b.spaceId).state.students.length,0);
});
test('all four scenario types have independent rosters, counters, pending draws and history',async t => {
  const { store } = await fixture(t), a = await store.register(registration('multi-scene'));
  const spaces = [a];
  for (const scenario of ['teacher','club','union']) spaces.push(await store.manageSpace(a.session,{ operation:'create',scenario,name:scenario }));
  for (const space of spaces) {
    const first = await store.change(a.session,{ spaceId:space.spaceId,revision:0,operation:'import',source:'同名条目,01,0\n第二条目,02,2' });
    assert.equal(first.state.students.length,2);
  }
  const chosen = spaces[0].spaceId;
  const draw = await store.change(a.session,{ spaceId:chosen,revision:1,operation:'draw',count:2,strength:1,name:'测试活动' });
  const confirmed = await store.change(a.session,{ spaceId:chosen,revision:2,operation:'confirm',id:draw.state.pending.id });
  assert.equal(confirmed.state.events.length,1);
  assert.equal([...totals(confirmed.state).values()].reduce((a,b) => a+b),4);
  for (const space of spaces.slice(1)) {
    const other = store.snapshot(a.session,space.spaceId).state;
    assert.equal(other.events.length,0); assert.equal(other.pending,null);
    assert.equal([...totals(other).values()].reduce((a,b) => a+b),2);
  }
  await assert.rejects(store.change(a.session,{ spaceId:chosen,revision:1,operation:'reset' }),e => e.status === 409);
});
test('password change revokes previous sessions, logout revokes new session',async t => {
  const { store } = await fixture(t), input = registration('password-test'), a = await store.register(input);
  const second = await store.login(input);
  const update = await store.updateAccount(a.session,{ currentPassword:input.password,newPassword:'new-password-456',displayName:'新名称' });
  assert.equal(update.account.displayName,'新名称');
  assert.equal(store.auth(a.session).authenticated,false); assert.equal(store.auth(second.session).authenticated,false);
  assert.equal(store.auth(update.session).authenticated,true);
  await assert.rejects(store.login(input),/用户名或密码/);
  const login = await store.login({ ...input,password:'new-password-456' });
  await store.logout(login.session);
  assert.throws(() => store.snapshot(login.session),e => e.status === 401);
});
test('expired sessions and repeated failed passwords are rejected',async t => {
  let clock = Date.now(); const { store } = await fixture(t,{ clock:() => clock }), input = registration('limited-user'), a = await store.register(input);
  for (let i=0;i<5;i++) await assert.rejects(store.login({ ...input,password:'wrong-password' }),e => e.status === 401);
  await assert.rejects(store.login(input),e => e.status === 429);
  clock += 61000; assert.ok((await store.login(input)).session);
  clock += 8*24*3600*1000; assert.equal(store.auth(a.session).authenticated,false);
});
test('legacy data is preserved, hidden before login, and can be explicitly adopted once',async t => {
  const { file } = await fixture(t);
  const old = initialState(); old.className = '旧班级'; old.students.push({ id:'old-id',name:'旧同学',number:'01',initialCount:4,enabled:true,archived:false });
  old.pending = { id:'old-draw',ids:['old-id'],name:'旧的待确认活动',strength:1 };
  await writeFile(file,JSON.stringify(old));
  const store = await createAccountStore(file);
  assert.equal(store.auth('').hasLegacy,true); assert.equal(store.auth('').state,undefined);
  assert.equal(JSON.parse(await readFile(file,'utf8')).schemaVersion,1);
  const a = await store.register({ ...registration('legacy-owner','teacher'),adoptLegacy:true });
  assert.equal(a.spaces.length,2); assert.equal(a.state.className,'旧班级'); assert.equal(a.state.students[0].initialCount,4);
  assert.equal(a.state.pending.name,'旧的待确认活动');
  assert.equal(store.auth('').hasLegacy,false);
  const b = await store.register({ ...registration('second-owner'),adoptLegacy:true });
  assert.equal(b.state.students.length,0);
  assert.equal(JSON.parse(await readFile(file+'.backup','utf8')).schemaVersion,2);
  assert.equal(JSON.parse(await readFile(file+'.v1-backup','utf8')).className,'旧班级');
});
test('deleting a space is scoped and the final space cannot be removed',async t => {
  const { store } = await fixture(t), a = await store.register(registration('delete-space'));
  await assert.rejects(store.manageSpace(a.session,{ operation:'delete',spaceId:a.spaceId,revision:0 }),/至少保留/);
  const b = await store.manageSpace(a.session,{ operation:'create',scenario:'union',name:'宣传部' });
  const result = await store.manageSpace(a.session,{ operation:'delete',spaceId:b.spaceId,revision:0 });
  assert.equal(result.spaces.length,1); assert.equal(result.spaceId,a.spaceId);
});
test('smart import preview is read-only, ownership checked, and metadata survives disk reload',async t => {
  const { store,file } = await fixture(t), a = await store.register(registration('import-owner','club')), b = await store.register(registration('import-other'));
  const payload = { spaceId:a.spaceId,source:'示例甲  组织部  干事\n示例乙  组织部  成员' };
  const preview = store.preview(a.session,payload);
  assert.equal(preview.rows[0].position,'干事'); assert.equal(preview.rows[0].number,'');
  assert.equal(store.snapshot(a.session,a.spaceId).state.students.length,0);
  assert.equal(store.snapshot(a.session,a.spaceId).state.revision,0);
  assert.throws(() => store.preview(b.session,payload),e => e.status === 404);
  const imported = await store.change(a.session,{ operation:'import',spaceId:a.spaceId,revision:0,students:preview.rows });
  assert.equal(imported.state.students[0].department,'组织部');
  const duplicate = store.preview(a.session,payload);
  assert.ok(duplicate.rows.every(r => r.duplicate && !r.selected));
  const reloaded = await createAccountStore(file);
  assert.equal(reloaded.snapshot(a.session,a.spaceId).state.students[0].position,'干事');
});
