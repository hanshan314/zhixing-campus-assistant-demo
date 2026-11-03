import { readFile, mkdir, writeFile, rename, copyFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { randomUUID, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { initialState, validateState, operate, SCENARIOS } from './core.js';
import { analyzeRoster } from './roster.js';
const scrypt = promisify(scryptCallback);
const SESSION_MS = 7 * 24 * 3600 * 1000;
const fail = (message,status = 400) => { const error = new Error(message); error.status = status; throw error; };
const name = (value,max,label) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}需要 1–${max} 个字符`); return value.trim(); };
function username(value) { const v = name(value,32,'用户名').normalize('NFKC').toLowerCase(); if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(v)) fail('用户名需为 3–32 位文字、数字或 _ . -'); return v; }
function password(value) { if (typeof value !== 'string' || value.length < 8 || value.length > 128) fail('密码需要 8–128 个字符'); return value; }
const digest = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (a,b) => a.length === b.length && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const role = value => { if (!Object.hasOwn(SCENARIOS,value)) fail('请选择有效的账号类型'); return value; };
const publicAccount = a => ({ id:a.id,username:a.username,displayName:a.displayName,role:a.role,createdAt:a.createdAt });
const publicSpace = s => ({ id:s.id,name:s.state.className,scenario:s.state.scenario,revision:s.state.revision,count:s.state.students.filter(x => !x.archived).length,events:s.state.events.filter(x => !x.undone).length });
function validateDatabase(value) {
  if (value?.schemaVersion === 1) {
    const legacy = validateState(value);
    return { schemaVersion:2,accounts:[],spaces:[],sessions:[],legacy:legacy.students.length || legacy.events.length ? legacy : null };
  }
  if (value?.schemaVersion !== 2 || !Array.isArray(value.accounts) || !Array.isArray(value.spaces) || !Array.isArray(value.sessions)) fail('账号数据文件格式无效');
  if (value.accounts.length > 100 || value.spaces.length > 1000 || value.sessions.length > 2000) fail('账号数据超过数量上限');
  const ids = new Set(), users = new Set(), spaceIds = new Set();
  const accounts = value.accounts.map(a => {
    if (typeof a.id !== 'string' || ids.has(a.id)) fail('账号标识重复或无效'); ids.add(a.id);
    const user = username(a.username); if (users.has(user)) fail('账号用户名重复'); users.add(user);
    if (!/^[a-f0-9]{128}$/.test(a.passwordHash) || !/^[a-f0-9]{32}$/.test(a.salt)) fail('密码存储格式无效');
    return { id:a.id,username:user,displayName:name(a.displayName,30,'显示名称'),role:role(a.role),salt:a.salt,passwordHash:a.passwordHash,createdAt:name(a.createdAt,40,'创建时间') };
  });
  const spaces = value.spaces.map(s => {
    if (!ids.has(s.ownerId) || typeof s.id !== 'string' || spaceIds.has(s.id)) fail('抽签场景归属无效'); spaceIds.add(s.id);
    return { id:s.id,ownerId:s.ownerId,state:validateState(s.state) };
  });
  const sessions = value.sessions.filter(s => ids.has(s.accountId) && /^[a-f0-9]{64}$/.test(s.hash) && Number.isSafeInteger(s.expiresAt)).map(s => ({ hash:s.hash,accountId:s.accountId,expiresAt:s.expiresAt }));
  return { schemaVersion:2,accounts,spaces,sessions,legacy:value.legacy ? validateState(value.legacy) : null };
}
export async function createAccountStore(file,{ clock = () => Date.now() } = {}) {
  let db, migrating = false;
  try { const source = JSON.parse(await readFile(file,'utf8')); migrating = source.schemaVersion === 1; db = validateDatabase(source); }
  catch (e) { if (e.code === 'ENOENT') db = { schemaVersion:2,accounts:[],spaces:[],sessions:[],legacy:null }; else throw new Error(`账号数据读取失败，原文件已保留：${e.message}`); }
  let queue = Promise.resolve();
  const attempts = new Map();
  const identify = (data,session) => {
    if (typeof session !== 'string' || !/^[a-f0-9]{64}$/.test(session)) fail('请先登录账号',401);
    const entry = data.sessions.find(s => s.hash === digest(session) && s.expiresAt > clock());
    const account = entry && data.accounts.find(a => a.id === entry.accountId);
    if (!account) fail('登录已失效，请重新登录',401);
    return account;
  };
  const ownSpace = (data,account,id) => { const s = data.spaces.find(s => s.id === id && s.ownerId === account.id); if (!s) fail('场景不存在或不属于当前账号',404); return s; };
  const response = (data,a,spaceId) => {
    const owned = data.spaces.filter(s => s.ownerId === a.id);
    const active = owned.find(s => s.id === spaceId) || owned[0];
    return { authenticated:true,account:publicAccount(a),spaces:owned.map(publicSpace),spaceId:active?.id || null,state:active ? structuredClone(active.state) : null,scenarios:SCENARIOS };
  };
  const transaction = fn => {
    const run = queue.then(async () => {
      const draft = structuredClone(db), result = await fn(draft);
      draft.sessions = draft.sessions.filter(s => s.expiresAt > clock());
      const validated = validateDatabase(draft), serialized = JSON.stringify(validated,null,2);
      await mkdir(dirname(file),{ recursive:true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        if (migrating) {
          try { await copyFile(file,file+'.v1-backup',fsConstants.COPYFILE_EXCL); }
          catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        await writeFile(temp,serialized,{ mode:0o600 });
        try { await copyFile(file,file+'.backup'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await rename(temp,file);
      } catch (e) { await unlink(temp).catch(() => {}); throw e; }
      db = validated;
      migrating = false;
      return result;
    });
    queue = run.catch(() => {}); return run;
  };
  const sessionFor = (data,a) => {
    const session = randomBytes(32).toString('hex');
    const existing = data.sessions.filter(s => s.accountId === a.id && s.expiresAt > clock());
    if (existing.length >= 10) data.sessions = data.sessions.filter(s => s.hash !== existing[0].hash);
    data.sessions.push({ hash:digest(session),accountId:a.id,expiresAt:clock()+SESSION_MS });
    return session;
  };
  return {
    auth(session) {
      try { return response(db,identify(db,session)); }
      catch (e) { if (e.status !== 401) throw e; return { authenticated:false,hasAccounts:db.accounts.length > 0,hasLegacy:Boolean(db.legacy),scenarios:SCENARIOS }; }
    },
    snapshot(session,spaceId) { const a = identify(db,session); if (spaceId) ownSpace(db,a,spaceId); return response(db,a,spaceId); },
    preview(session,input) {
      const account = identify(db,session), space = ownSpace(db,account,input.spaceId);
      const preview = analyzeRoster(input.source,{ scenario:space.state.scenario });
      const existing = space.state.students.filter(s => !s.archived), accepted = [...existing];
      for (const row of preview.rows) {
        row.duplicate = accepted.some(s => row.number && s.number ? row.number === s.number : row.name && row.name === s.name);
        if (row.duplicate) row.selected = false;
        else if (row.selected) accepted.push(row);
      }
      return { ...preview,revision:space.state.revision };
    },
    async register(input) {
      const user = username(input.username), secret = password(input.password), displayName = name(input.displayName,30,'显示名称'), accountRole = role(input.role);
      const salt = randomBytes(16).toString('hex'), hash = (await scrypt(secret,salt,64)).toString('hex');
      return transaction(data => {
        if (data.accounts.some(a => a.username === user)) fail('这个用户名已被使用');
        if (data.accounts.length >= 100) fail('本机账号已达 100 个上限');
        const a = { id:randomUUID(),username:user,displayName,role:accountRole,salt,passwordHash:hash,createdAt:new Date(clock()).toISOString() };
        data.accounts.push(a);
        if (data.legacy && input.adoptLegacy === true) {
          data.spaces.push({ id:randomUUID(),ownerId:a.id,state:structuredClone(data.legacy) }); data.legacy = null;
        }
        if (!data.spaces.some(s => s.ownerId === a.id && s.state.scenario === accountRole)) data.spaces.push({ id:randomUUID(),ownerId:a.id,state:initialState(accountRole) });
        const session = sessionFor(data,a);
        return { ...response(data,a),session,message:'账号已创建，欢迎使用' };
      });
    },
    async login(input) {
      const user = username(input.username), secret = password(input.password), now = clock();
      const attempt = attempts.get(user);
      if (attempt?.until > now) fail('尝试次数较多，请在 1 分钟后重试',429);
      const a = db.accounts.find(a => a.username === user);
      const hash = (await scrypt(secret,a?.salt || '00000000000000000000000000000000',64)).toString('hex');
      if (!a || !safeEqual(hash,a.passwordHash)) {
        const recent = attempt && now-attempt.start < 60000 ? attempt : { count:0,start:now,until:0 };
        recent.count++; if (recent.count >= 5) recent.until = now+60000;
        if (attempts.size > 1000) attempts.clear(); attempts.set(user,recent);
        fail('用户名或密码不正确',401);
      }
      attempts.delete(user);
      return transaction(data => {
        const current = data.accounts.find(x => x.id === a.id);
        if (!current || current.passwordHash !== a.passwordHash) fail('账号密码已变更，请重新登录',401);
        const session = sessionFor(data,current);
        return { ...response(data,current),session,message:'登录成功' };
      });
    },
    logout(session) { return transaction(data => { data.sessions = data.sessions.filter(s => s.hash !== digest(session || '')); return { authenticated:false,message:'已退出当前账号' }; }); },
    change(session,input) {
      return transaction(data => {
        const a = identify(data,session), space = ownSpace(data,a,input.spaceId);
        if (input.revision !== space.state.revision) { const e = new Error('当前场景已在其他窗口更新，已刷新，请重试'); e.status = 409; e.spaceId = space.id; throw e; }
        const result = operate(space.state,input,{ uuid:randomUUID,random:() => randomInt(0,2**48-1)/(2**48-1),now:() => new Date(clock()).toISOString() });
        space.state = result.state;
        return { ...response(data,a,space.id),message:result.message };
      });
    },
    manageSpace(session,input) {
      return transaction(data => {
        const a = identify(data,session);
        if (input.operation === 'create') {
          const scenario = role(input.scenario), title = name(input.name,40,'场景名称');
          if (data.spaces.filter(s => s.ownerId === a.id).length >= 50) fail('每个账号最多创建 50 个场景');
          const space = { id:randomUUID(),ownerId:a.id,state:initialState(scenario,title) }; data.spaces.push(space);
          return { ...response(data,a,space.id),message:'新场景已创建' };
        }
        if (input.operation === 'delete') {
          const space = ownSpace(data,a,input.spaceId);
          if (input.revision !== space.state.revision) fail('场景已更新，请刷新后再删除',409);
          if (data.spaces.filter(s => s.ownerId === a.id).length <= 1) fail('请至少保留一个抽签场景');
          data.spaces = data.spaces.filter(s => s.id !== space.id);
          return { ...response(data,a),message:'场景及其名单、记录已删除' };
        }
        fail('不支持的场景操作');
      });
    },
    async updateAccount(session,input) {
      const previous = identify(db,session);
      const hash = (await scrypt(password(input.currentPassword),previous.salt,64)).toString('hex');
      if (!safeEqual(hash,previous.passwordHash)) fail('当前密码不正确',401);
      const displayName = name(input.displayName,30,'显示名称');
      const salt = input.newPassword ? randomBytes(16).toString('hex') : previous.salt;
      const passwordHash = input.newPassword ? (await scrypt(password(input.newPassword),salt,64)).toString('hex') : previous.passwordHash;
      return transaction(data => {
        const a = identify(data,session);
        if (a.passwordHash !== previous.passwordHash) fail('密码已变更，请重新登录',401);
        a.displayName = displayName; a.salt = salt; a.passwordHash = passwordHash;
        data.sessions = data.sessions.filter(s => s.accountId !== a.id);
        const fresh = sessionFor(data,a);
        return { ...response(data,a),session:fresh,message:'账号资料已更新，其他登录已退出' };
      });
    }
  };
}
