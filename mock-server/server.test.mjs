import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDemoServer } from './server.mjs';
import { validateResponse } from '../contracts/runtime-validation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = () => `test_${randomUUID()}`;
const TASK = 'task_demo_pending';
const PDF = Buffer.from('%PDF-1.4\n% virtual material only\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');

async function harness(t, options = {}) {
  const root = join(HERE, '.test-work'); await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(join(root, 'http-'));
  let time = new Date('2026-10-15T12:00:00Z');
  let app = await createDemoServer({ dataDir, clock: () => time, runDelayMs: 15, ...options });
  let url = await app.listen(0);
  const api = async (method, path, body, { token = 'demo-student-a', key, operation, expected = 200, headers = {} } = {}) => {
    const h = { Authorization: `Bearer ${token}`, ...headers };
    if (key) h['Idempotency-Key'] = key;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const response = await fetch(`${url}${path}`, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    assert.equal(value.meta.mode, 'demo');
    assert.ok(value.meta.request_id.startsWith('req_'));
    if (operation) assert.deepEqual(validateResponse(operation, response.status, value), [], JSON.stringify(value));
    return value.data ?? value.error;
  };
  const upload = async ({ token = 'demo-student-a', bytes = PDF, mime = 'application/pdf', key = KEY(), expected = 201, purpose = 'submission_material', taskId = TASK, extra = {} } = {}) => {
    const form = new FormData(); form.set('file', new Blob([bytes], { type: mime }), 'material.pdf'); form.set('purpose', purpose); if (taskId !== null) form.set('task_id', taskId);
    for (const [name, value] of Object.entries(extra)) form.set(name, value);
    const response = await fetch(`${url}/v1/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key }, body: form });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); assert.deepEqual(validateResponse('uploadFile', response.status, value), []);
    return value.data ?? value.error;
  };
  const scenario = body => api('POST', '/__demo/scenario', body);
  const prepare = async ({ taskId = TASK, token = 'demo-student-a', revision = null, requirement = 1 } = {}) => {
    await api('POST', `/v1/tasks/${taskId}/confirm`, { requirement_version: requirement }, { token, key: KEY(), operation: 'confirmTask' });
    const file = await upload({ token, taskId });
    const draft = await api('POST', `/v1/tasks/${taskId}/submission-drafts`, { requirement_version: requirement, file_ids: [file.file_id], text: '', revision_of_submission_id: revision }, { token, operation: 'createDraft', expected: 201 });
    return { file, draft, request: { draft_id: draft.draft_id, draft_version: draft.draft_version, requirement_version: requirement, expected_effective_submission_id: revision } };
  };
  const submit = (request, options = {}) => api('POST', `/v1/tasks/${options.taskId ?? TASK}/submissions`, request, { key: KEY(), operation: 'submitMaterials', expected: 201, ...options });
  const waitRun = async runId => {
    for (let i = 0; i < 100; i++) {
      const run = await api('GET', `/v1/runs/${runId}`, undefined, { operation: 'getRun' });
      if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    throw new Error('Run did not finish');
  };
  t.after(async () => { await app.close(); const target = resolve(dataDir); assert.ok(target.startsWith(resolve(root) + '\\') || target.startsWith(resolve(root) + '/')); await rm(target, { recursive: true, force: true }); });
  return { api, upload, prepare, submit, scenario, waitRun, dataDir, get url() { return url; }, setTime(value) { time = new Date(value); }, async restart(editPersistedState) { await app.close(); if (editPersistedState) { const path = join(dataDir, 'state.json'); const saved = JSON.parse(await readFile(path, 'utf8')); await editPersistedState(saved); await writeFile(path, JSON.stringify(saved)); } app = await createDemoServer({ dataDir, clock: () => time, runDelayMs: 15, ...options }); url = await app.listen(0); } };
}

test('源契约结构、虚拟身份、四类期限、来源与只读行为', async t => {
  const h = await harness(t);
  const a = await h.api('GET', '/v1/me', undefined, { operation: 'getMe' });
  await h.api('GET', '/v1/me', undefined, { token: '__proto__', operation: 'getMe', expected: 401 });
  const b = await h.api('GET', '/v1/me', undefined, { operation: 'getMe', token: 'demo-student-b' });
  assert.equal(a.display_name, b.display_name); assert.notEqual(a.user_id, b.user_id);
  const caps = await h.api('GET', '/v1/capabilities', undefined, { operation: 'getCapabilities' });
  assert.equal(caps.upload.available, true); assert.equal(caps.parse.available, false); assert.equal(caps.checks.mode, 'demo');
  const list = await h.api('GET', '/v1/me/tasks', undefined, { operation: 'listMyTasks' }); assert.equal(list.items.length, 4);
  assert.deepEqual([...new Set(list.items.map(task => task.deadline.kind))].sort(), ['at', 'no_deadline', 'unknown']);
  const task = await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' });
  await h.api('GET', `/v1/sources/${task.source_ids[0]}`, undefined, { operation: 'getSource' });
  assert.equal(task.student_state.read_status, 'unread');
  await h.api('POST', `/v1/tasks/${TASK}/read`, { requirement_version: 1 }, { operation: 'readTask' });
  const read = await h.api('GET', `/v1/tasks/${TASK}`);
  assert.equal(read.student_state.read_status, 'read'); assert.equal(read.student_state.confirmation_status, 'pending'); assert.equal(read.student_state.submission_status, 'none');
});

test('保存 multipart 原字节不等于正式提交；草稿 PATCH 递增并失效旧检查', async t => {
  const h = await harness(t), file = await h.upload();
  const content = await fetch(`${h.url}/v1/files/${file.file_id}/content`, { headers: { Authorization: 'Bearer demo-student-a' } });
  assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), PDF);
  await h.api('GET', `/v1/files/${file.file_id}`, undefined, { operation: 'getFile' });
  assert.equal((await h.api('GET', `/v1/tasks/${TASK}`)).student_state.submission_status, 'none');
  const draft = await h.api('POST', `/v1/tasks/${TASK}/submission-drafts`, { requirement_version: 1, file_ids: [], text: '', revision_of_submission_id: null }, { operation: 'createDraft', expected: 201 });
  const patched = await h.api('PATCH', `/v1/submission-drafts/${draft.draft_id}`, { draft_version: 1, requirement_version: 1, file_ids: [file.file_id], text: '' }, { operation: 'patchDraft' });
  assert.equal(patched.draft_version, 2);
  const run = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: 2, requirement_version: 1 }, { key: KEY(), operation: 'startCheck', expected: 202 });
  assert.equal(run.status, 'queued'); await h.waitRun(run.run_id);
  const checked = await h.api('GET', `/v1/submission-drafts/${draft.draft_id}`, undefined, { operation: 'getDraft' }); assert.ok(checked.current_check_id);
  const changed = await h.api('PATCH', `/v1/submission-drafts/${draft.draft_id}`, { draft_version: 2, requirement_version: 1, file_ids: [file.file_id], text: '修改内容' }, { operation: 'patchDraft' });
  assert.equal(changed.current_check_id, null); assert.equal(changed.draft_version, 3);
  const stale = await h.api('PATCH', `/v1/submission-drafts/${draft.draft_id}`, { draft_version: 2, requirement_version: 1, file_ids: [file.file_id], text: '' }, { expected: 409, operation: 'patchDraft' }); assert.equal(stale.code, 'RESOURCE_VERSION_CONFLICT');
});

test('并发同键只产生一次提交，原回执重放和同键异内容拒绝', async t => {
  const h = await harness(t), prepared = await h.prepare(), key = KEY();
  const results = await Promise.all(Array.from({ length: 8 }, () => h.submit(prepared.request, { key })));
  assert.equal(new Set(results.map(result => result.submission_id)).size, 1);
  const history = await h.api('GET', `/v1/tasks/${TASK}/my-submissions`, undefined, { operation: 'listMySubmissions' }); assert.equal(history.items.length, 1);
  const bad = await h.submit({ ...prepared.request, draft_version: 2 }, { key, expected: 409 }); assert.equal(bad.code, 'IDEMPOTENCY_KEY_REUSED');
  await h.scenario({ scenario: 'withdraw_task', task_id: TASK });
  const replay = await h.submit(prepared.request, { key }); assert.deepEqual(replay, results[0]);
  const state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8')); assert.equal(state.events.filter(event => event.type === 'submission_saved').length, 1);
});

test('提交回应丢失：查询原操作引用、同键恢复、not_found 始终 unknown', async t => {
  const h = await harness(t), { request } = await h.prepare(), key = KEY();
  await h.scenario({ scenario: 'drop_next_submit_response' });
  await assert.rejects(() => h.submit(request, { key }));
  const operation = await h.api('POST', '/v1/operations/lookup', { action: 'submit_materials', target_id: TASK, idempotency_key: key }, { operation: 'lookupOperation' });
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.receipt.kind, 'submission'); assert.equal(operation.receipt.result_path, `/v1/tasks/${TASK}/my-submissions`);
  const replay = await h.submit(request, { key }); assert.equal(replay.submission_id, operation.receipt.id);
  const missing = await h.api('POST', '/v1/operations/lookup', { action: 'submit_materials', target_id: TASK, idempotency_key: KEY() }, { operation: 'lookupOperation' }); assert.equal(missing.status, 'not_found'); assert.equal(missing.outcome, 'unknown');
});

test('两个设备从同一旧版本补交：仅一次有效版本切换，旧版保留', async t => {
  const h = await harness(t), taskId = 'task_demo_revision';
  const task = await h.api('GET', `/v1/tasks/${taskId}`), oldId = task.student_state.effective_submission_id;
  assert.equal(task.student_state.display_status, 'needs_revision');
  const first = await h.prepare({ taskId, revision: oldId }), second = await h.prepare({ taskId, revision: oldId });
  const results = await Promise.all([first, second].map(async prepared => {
    const response = await fetch(`${h.url}/v1/tasks/${taskId}/submissions`, { method: 'POST', headers: { Authorization: 'Bearer demo-student-a', 'Content-Type': 'application/json', 'Idempotency-Key': KEY() }, body: JSON.stringify(prepared.request) });
    const value = await response.json(); assert.deepEqual(validateResponse('submitMaterials', response.status, value), []); return { status: response.status, value };
  }));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(results.find(result => result.status === 409).value.error.code, 'RESOURCE_VERSION_CONFLICT');
  const history = await h.api('GET', `/v1/tasks/${taskId}/my-submissions`, undefined, { operation: 'listMySubmissions' }); assert.equal(history.items.length, 2);
  assert.equal(history.items[0].submission_version, 2); assert.equal(history.items[0].review_status, 'pending'); assert.equal(history.items[1].submission_id, oldId); assert.equal(history.items[1].review_status, 'needs_revision');
  const reviewRace = await h.api('POST', '/__demo/scenario', { scenario: 'review_needs_revision', task_id: taskId, expected_effective_submission_id: oldId, expected_resource_version: 2 }, { expected: 409 }); assert.equal(reviewRace.code, 'RESOURCE_VERSION_CONFLICT');
});

test('AI 故障保留规则结果和文件，可提交；重试新 Run 并关联旧执行', async t => {
  const h = await harness(t), { request, file, draft } = await h.prepare();
  await h.scenario({ scenario: 'ai_failure', enabled: true });
  const accepted = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: draft.draft_version, requirement_version: 1 }, { key: KEY(), operation: 'startCheck', expected: 202 });
  const failed = await h.waitRun(accepted.run_id); assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'AI_TIMEOUT');
  assert.equal(failed.result_ref, null); assert.equal(failed.check_id, null);
  const preservedDraft = await h.api('GET', `/v1/submission-drafts/${draft.draft_id}`, undefined, { operation: 'getDraft' });
  assert.ok(preservedDraft.current_check_id, 'failed AI keeps the saved rule check reachable through its draft');
  const check = await h.api('GET', `/v1/checks/${preservedDraft.current_check_id}`, undefined, { operation: 'getCheck' }); assert.equal(check.rule_status, 'passed'); assert.deepEqual(check.ai_suggestions, []);
  await h.api('GET', `/v1/files/${file.file_id}`);
  await h.scenario({ scenario: 'ai_failure', enabled: false });
  const retried = await h.api('POST', `/v1/runs/${failed.run_id}/retry`, { resource_version: failed.resource_version }, { key: KEY(), operation: 'retryRun', expected: 202 }); assert.notEqual(retried.run_id, failed.run_id); assert.equal(retried.retry_of, failed.run_id);
  assert.equal((await h.waitRun(retried.run_id)).status, 'succeeded');
  assert.equal((await h.submit(request)).review_status, 'pending');
});

test('旧failed Run读取投影兼容新契约，规则/原文件与旧记录不被改写', async t => {
  const h = await harness(t), { file, draft } = await h.prepare();
  await h.scenario({ scenario: 'ai_failure', enabled: true });
  const accepted = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: draft.draft_version, requirement_version: 1 }, { key: KEY(), operation: 'startCheck', expected: 202 });
  await h.waitRun(accepted.run_id);
  let legacy;
  await h.restart(state => {
    const run = state.runs[accepted.run_id].value;
    const checkId = state.drafts[draft.draft_id].value.current_check_id;
    run.check_id = checkId;
    run.result_ref = { kind: 'check', id: checkId, result_path: `/v1/checks/${checkId}` };
    legacy = structuredClone(run);
  });
  const projected = await h.api('GET', `/v1/runs/${accepted.run_id}`, undefined, { operation: 'getRun' });
  assert.equal(projected.status, 'failed'); assert.equal(projected.check_id, null); assert.equal(projected.result_ref, null);
  const list = await h.api('GET', '/v1/me/runs', undefined, { operation: 'listMyRuns' });
  assert.equal(list.items.find(run => run.run_id === accepted.run_id).result_ref, null);
  const restored = await h.api('GET', `/v1/submission-drafts/${draft.draft_id}`, undefined, { operation: 'getDraft' });
  assert.equal(restored.current_check_id, legacy.check_id);
  const check = await h.api('GET', `/v1/checks/${restored.current_check_id}`, undefined, { operation: 'getCheck' });
  assert.equal(check.rule_status, 'passed');
  await h.api('GET', `/v1/files/${file.file_id}`);
  const state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.runs[accepted.run_id].value, legacy, 'projection must not rewrite historical run');
});

test('同名账号按稳定身份隔离：文件、草稿、检查、Run、历史和操作查询', async t => {
  const h = await harness(t), { file, draft, request } = await h.prepare(), key = KEY();
  const run = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: 1, requirement_version: 1 }, { key: KEY(), expected: 202 }); const terminal = await h.waitRun(run.run_id);
  await h.submit(request, { key });
  for (const path of [`/v1/files/${file.file_id}`, `/v1/files/${file.file_id}/content`, `/v1/submission-drafts/${draft.draft_id}`, `/v1/runs/${run.run_id}`, `/v1/checks/${terminal.check_id}`]) {
    const error = await h.api('GET', path, undefined, { token: 'demo-student-b', expected: 404 }); assert.equal(error.code, 'NOT_FOUND');
  }
  const history = await h.api('GET', `/v1/tasks/${TASK}/my-submissions`, undefined, { token: 'demo-student-b' }); assert.deepEqual(history.items, []);
  const lookup = await h.api('POST', '/v1/operations/lookup', { action: 'submit_materials', target_id: TASK, idempotency_key: key }, { token: 'demo-student-b' }); assert.equal(lookup.status, 'not_found');
  const injected = await h.api('POST', `/v1/tasks/${TASK}/submission-drafts`, { requirement_version: 1, file_ids: [file.file_id], text: '', revision_of_submission_id: null }, { token: 'demo-student-b', expected: 404 }); assert.equal(injected.code, 'NOT_FOUND');
  const identity = await h.api('GET', '/v1/me?owner_id=user_demo_a', undefined, { token: 'demo-student-b', expected: 422 }); assert.equal(identity.code, 'VALIDATION_FAILED');
});

test('关闭和重新启动服务可恢复文件、草稿、Run、提交及原操作', async t => {
  const h = await harness(t, { runDelayMs: 50 }), { file, draft, request } = await h.prepare(), key = KEY();
  const run = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: 1, requirement_version: 1 }, { key: KEY(), expected: 202 });
  const submission = await h.submit(request, { key });
  await h.restart();
  assert.equal((await h.api('GET', `/v1/files/${file.file_id}`)).content_hash, file.content_hash);
  assert.equal((await h.api('GET', `/v1/submission-drafts/${draft.draft_id}`)).draft_id, draft.draft_id);
  assert.equal((await h.waitRun(run.run_id)).status, 'succeeded');
  assert.equal((await h.submit(request, { key })).submission_id, submission.submission_id);
  const operation = await h.api('POST', '/v1/operations/lookup', { action: 'submit_materials', target_id: TASK, idempotency_key: key }); assert.equal(operation.receipt.id, submission.submission_id);
});

test('版本变化、未知期限、撤销与未确认由服务端拦截', async t => {
  const h = await harness(t), { request } = await h.prepare();
  await h.scenario({ scenario: 'requirements_changed', task_id: TASK });
  const error = await h.submit(request, { expected: 409 }); assert.equal(error.code, 'REQUIREMENT_VERSION_CONFLICT');
  const task = await h.api('GET', `/v1/tasks/${TASK}`); assert.equal(task.requirement_version, 2); assert.equal(task.student_state.confirmation_status, 'pending');
  const unknown = await h.prepare({ taskId: 'task_demo_unknown' }); assert.equal((await h.submit(unknown.request, { taskId: 'task_demo_unknown', expected: 422 })).code, 'DEADLINE_UNKNOWN');
  await h.scenario({ scenario: 'withdraw_task', task_id: 'task_demo_unknown' }); assert.equal((await h.submit(unknown.request, { taskId: 'task_demo_unknown', expected: 409 })).code, 'TASK_WITHDRAWN');
});

test('截止前、恰好截止、截止后与迟交开关使用注入服务器时钟', async t => {
  for (const [offset, allow, expected, late] of [[-1, false, 201, false], [0, false, 201, false], [1, false, 422, null], [1, true, 201, true]]) {
    const h = await harness(t), { request } = await h.prepare();
    const due = '2026-10-15T13:00:00.000Z';
    await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: due, allow_late_submission: allow });
    h.setTime(Date.parse(due) + offset);
    const result = await h.submit(request, { expected });
    if (expected === 201) assert.equal(result.is_late, late); else assert.equal(result.code, 'DEADLINE_PASSED');
  }
});

test('真实 multipart 边界、幂等上传、额外字段和空材料阻断', async t => {
  const h = await harness(t), key = KEY();
  const first = await h.upload({ key }), replay = await h.upload({ key }); assert.equal(first.file_id, replay.file_id);
  assert.equal((await h.upload({ bytes: Buffer.alloc(20 * 1024 * 1024, 1) })).size, 20 * 1024 * 1024);
  assert.equal((await h.upload({ key, bytes: Buffer.from('different'), expected: 409 })).code, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await h.upload({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1, 1), expected: 413 })).code, 'FILE_TOO_LARGE');
  assert.equal((await h.upload({ mime: 'application/x-executable', expected: 415 })).code, 'FILE_TYPE_UNSUPPORTED');
  assert.equal((await h.upload({ bytes: Buffer.alloc(0), expected: 422 })).code, 'VALIDATION_FAILED');
  assert.equal((await h.upload({ extra: { owner_id: 'user_demo_b' }, expected: 422 })).code, 'VALIDATION_FAILED');
  const draft = await h.api('POST', `/v1/tasks/${TASK}/submission-drafts`, { requirement_version: 1, file_ids: [], text: '', revision_of_submission_id: null }, { expected: 201 });
  await h.api('POST', `/v1/tasks/${TASK}/confirm`, { requirement_version: 1 }, { key: KEY() });
  const error = await h.submit({ draft_id: draft.draft_id, draft_version: 1, requirement_version: 1, expected_effective_submission_id: null }, { expected: 422 }); assert.equal(error.code, 'VALIDATION_FAILED');
});

test('取消异步受理保留终态；稳定分页及本机 CORS', async t => {
  const h = await harness(t, { runDelayMs: 200 }), { draft } = await h.prepare();
  const run = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: 1, requirement_version: 1 }, { key: KEY(), expected: 202 });
  const cancel = await h.api('POST', `/v1/runs/${run.run_id}/cancel`, { resource_version: run.resource_version }, { key: KEY(), operation: 'cancelRun', expected: 202 }); assert.equal(cancel.status, 'cancelling'); assert.equal((await h.waitRun(run.run_id)).status, 'cancelled');
  const first = await h.api('GET', '/v1/me/tasks?limit=2'); assert.equal(first.items.length, 2); assert.equal(first.has_more, true);
  const second = await h.api('GET', `/v1/me/tasks?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`); assert.equal(second.items.length, 2); assert.equal(second.as_of, first.as_of); assert.equal(new Set([...first.items, ...second.items].map(item => item.task_id)).size, 4);
  const preflight = await fetch(`${h.url}/v1/files`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:18766', 'Access-Control-Request-Method': 'POST' } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:18766');
  await h.api('GET', '/v1/me', undefined, { operation: 'getMe', headers: { Origin: 'http://127.0.0.1:18766' } });
  const external = await fetch(`${h.url}/v1/me`, { headers: { Origin: 'https://untrusted.invalid', Authorization: 'Bearer demo-student-a' } }); assert.equal(external.status, 403);
});

test('真正 Node 子进程停止再启动后仍可读取原操作和磁盘文件', async t => {
  const root = join(HERE, '.test-work'); await mkdir(root, { recursive: true }); const dataDir = await mkdtemp(join(root, 'process-'));
  let child;
  async function start() {
    child = spawn(process.execPath, [join(HERE, 'server.mjs')], { env: { ...process.env, PORT: '0', DEMO_DATA_DIR: dataDir, DEMO_CLOCK: '2026-10-15T12:00:00Z' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return new Promise((resolveStart, reject) => {
      let output = '';
      child.stdout.on('data', bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) resolveStart(match[0]); });
      child.once('exit', code => reject(new Error(`child exited ${code}`))); child.once('error', reject);
    });
  }
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  t.after(async () => { await stop(); assert.ok(resolve(dataDir).startsWith(resolve(root))); await rm(dataDir, { recursive: true, force: true }); });
  let url = await start(); const key = KEY();
  const form = new FormData(); form.set('file', new Blob([PDF], { type: 'application/pdf' }), 'sample.pdf'); form.set('purpose', 'submission_material'); form.set('task_id', TASK);
  const uploaded = await fetch(`${url}/v1/files`, { method: 'POST', headers: { Authorization: 'Bearer demo-student-a', 'Idempotency-Key': key }, body: form }); assert.equal(uploaded.status, 201); const file = (await uploaded.json()).data;
  await stop(); url = await start();
  const content = await fetch(`${url}/v1/files/${file.file_id}/content`, { headers: { Authorization: 'Bearer demo-student-a' } }); assert.deepEqual(Buffer.from(await content.arrayBuffer()), PDF);
  const lookup = await fetch(`${url}/v1/operations/lookup`, { method: 'POST', headers: { Authorization: 'Bearer demo-student-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upload_file', target_id: TASK, idempotency_key: key }) }); assert.equal(lookup.status, 200); assert.equal((await lookup.json()).data.receipt.id, file.file_id);
});

test('0.2 上传按任务原目标恢复，files不命中新操作，跨账号与同键异内容均隔离', async t => {
  const h = await harness(t), key = KEY();
  const before = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  const uploads = await Promise.all(Array.from({ length: 4 }, () => h.upload({ key })));
  assert.equal(new Set(uploads.map(file => file.file_id)).size, 1);
  const lookup = (target, token) => h.api('POST', '/v1/operations/lookup', { action: 'upload_file', target_id: target, idempotency_key: key }, { operation: 'lookupOperation', ...(token ? { token } : {}) });
  const found = await lookup(TASK);
  assert.equal(found.status, 'succeeded'); assert.equal(found.receipt.id, uploads[0].file_id);
  for (const missing of [await lookup('files'), await lookup('task_demo_revision'), await lookup(TASK, 'demo-student-b')]) {
    assert.equal(missing.status, 'not_found'); assert.equal(missing.outcome, 'unknown'); assert.equal(missing.receipt, null);
  }
  assert.equal((await h.upload({ key, bytes: Buffer.from('different'), expected: 409 })).code, 'IDEMPOTENCY_KEY_REUSED');
  const state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.equal(Object.keys(state.files).length, Object.keys(before.files).length + 1);
});

test('学生上传拒绝未开放source/import及串作用域字段，不产生文件', async t => {
  const h = await harness(t);
  const before = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  for (const input of [
    { purpose: 'source', taskId: null, expected: 503 },
    { purpose: 'membership_import', taskId: null, extra: { class_id: 'class_demo_energy' }, expected: 503 },
    { purpose: 'source', extra: { class_id: 'class_demo_energy' }, expected: 422 },
    { purpose: 'submission_material', extra: { class_id: 'class_demo_energy' }, expected: 422 },
    { purpose: 'submission_material', taskId: null, expected: 422 },
    { taskId: 'task_not_visible', expected: 404 },
  ]) await h.upload(input);
  const after = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(after.files, before.files); assert.deepEqual(after.operations, before.operations);
});

test('旧files原操作与回执重启后保留；旧key不能在新task目标产生重复文件', async t => {
  const h = await harness(t), key = KEY(), saved = await h.upload({ key });
  const original = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  let legacy;
  await h.restart(state => {
    const match = Object.entries(state.operations).find(([, operation]) => operation.action === 'upload_file' && operation.key === key);
    assert.ok(match, 'generated upload operation must be persisted');
    const [storeKey, record] = match;
    delete state.operations[storeKey];
    record.target_id = 'files';
    delete record.contract_version;
    state.operations[JSON.stringify([record.owner, record.action, 'files', key])] = record;
    legacy = structuredClone(record);
  });
  const lookup = target => h.api('POST', '/v1/operations/lookup', { action: 'upload_file', target_id: target, idempotency_key: key }, { operation: 'lookupOperation' });
  assert.equal((await lookup('files')).receipt.id, saved.file_id);
  assert.equal((await lookup(TASK)).outcome, 'unknown');
  assert.equal((await h.upload({ key, expected: 503 })).code, 'CAPABILITY_UNAVAILABLE');
  await h.restart();
  const state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(state.operations[JSON.stringify([legacy.owner, legacy.action, 'files', key])], legacy);
  assert.equal(Object.values(state.operations).filter(operation => operation.key === key).length, 1);
  assert.equal(Object.values(state.files).filter(file => file.value.file_id === saved.file_id).length, 1);
  assert.equal(Object.keys(state.files).length, Object.keys(original.files).length);
  assert.equal((await lookup('files')).receipt.id, saved.file_id);
});

test('等待补充仅收等待字段、校验版本与归属，同键补充可恢复且不重复执行', async t => {
  const h = await harness(t), { draft } = await h.prepare();
  await h.scenario({ scenario: 'waiting_input', enabled: true });
  const accepted = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: draft.draft_version, requirement_version: 1 }, { key: KEY(), operation:'startCheck', expected:202 });
  assert.equal(accepted.status,'waiting_input');
  const path = `/v1/runs/${accepted.run_id}/inputs`, key = KEY();
  const request = { resource_version:accepted.resource_version, inputs:[{name:'explanation',value:'虚拟说明'}] };
  await h.api('POST',path,{...request,resource_version:999},{key:KEY(),expected:409});
  await h.api('POST',path,{...request,inputs:[]},{key:KEY(),expected:422});
  await h.api('POST',path,request,{key:KEY(),token:'demo-student-b',expected:404});
  const result = await h.api('POST',path,request,{key,operation:'supplyRunInputs',expected:202});
  const replay = await h.api('POST',path,request,{key,operation:'supplyRunInputs',expected:202});
  assert.equal(replay.run_id,result.run_id); assert.equal(replay.resource_version,result.resource_version);
  assert.equal((await h.waitRun(result.run_id)).status,'succeeded');
  const lookup = await h.api('POST','/v1/operations/lookup',{action:'supply_run_input',target_id:accepted.run_id,idempotency_key:key},{operation:'lookupOperation'});
  assert.equal(lookup.receipt.id,accepted.run_id);
});

test('消息已读同键回放/版本/账号隔离，投递不冒充任务确认，空档案不拼事实', async t => {
  const h=await harness(t), key=KEY();
  const page=await h.api('GET','/v1/me/notifications',undefined,{operation:'listNotifications'});
  assert.equal(page.items.length,4);
  const message=page.items.find(n=>n.target.id===TASK);
  assert.equal(message.read_status,'unread');assert.equal(message.delivery_status,'stored');
  const path=`/v1/notifications/${message.notification_id}/read`,body={resource_version:message.resource_version};
  const read=await h.api('POST',path,body,{key,operation:'readNotification'});
  assert.equal(read.read_status,'read');
  assert.deepEqual(await h.api('POST',path,body,{key,operation:'readNotification'}),read);
  await h.api('POST',path,body,{key:KEY(),expected:409});
  await h.api('GET',`/v1/notifications/${message.notification_id}`,undefined,{token:'demo-student-b',expected:404});
  const task=await h.api('GET',`/v1/tasks/${TASK}`);assert.equal(task.student_state.confirmation_status,'pending');assert.equal(task.student_state.read_status,'unread');
  const profile=await h.api('GET','/v1/me/profile',undefined,{operation:'getMyProfile'});assert.equal(profile.user_id,'user_demo_a');assert.deepEqual(profile.facts,[]);
  await h.restart();const after=await h.api('GET','/v1/me/notifications');assert.equal(after.items.length,4);assert.equal(after.items.find(n=>n.notification_id===message.notification_id).read_status,'read');
});

test('撤销任务访问后fresh cancel拒绝且Run版本与幂等记录不改变', async t => {
  const h = await harness(t, { runDelayMs: 60000 }), { draft } = await h.prepare();
  await h.scenario({ scenario: 'waiting_input', enabled: true });
  const run = await h.api('POST', `/v1/submission-drafts/${draft.draft_id}/checks`, { draft_version: draft.draft_version, requirement_version: 1 }, { key: KEY(), operation: 'startCheck', expected: 202 });
  assert.equal(run.status, 'waiting_input'); assert.equal(run.cancellable, true);
  await h.restart(s => { s.tasks[TASK].recipients = s.tasks[TASK].recipients.filter(user => user !== 'user_demo_a'); });
  const before = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  await h.api('POST', `/v1/runs/${run.run_id}/cancel`, { resource_version: run.resource_version }, { key: KEY(), operation: 'cancelRun', expected: 404 });
  const after = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
  assert.deepEqual(after.runs, before.runs);
  assert.deepEqual(after.operations, before.operations);
});

test('撤权后消息同键回放/原操作查询与旧分页均重验当前权限', async t => {
  const h=await harness(t),key=KEY();
  const page=await h.api('GET','/v1/me/notifications');const message=page.items.find(n=>n.target.id===TASK);
  const path=`/v1/notifications/${message.notification_id}/read`,body={resource_version:message.resource_version};
  await h.api('POST',path,body,{key});
  const first=await h.api('GET','/v1/me/notifications?limit=1');
  const secondPath=`/v1/me/notifications?cursor=${encodeURIComponent(first.next_cursor)}&limit=1`;
  const second=await h.api('GET',secondPath);const laterTask=second.items[0].target.id;
  const taskPage=await h.api('GET','/v1/me/tasks?limit=1');
  const laterTaskPage=`/v1/me/tasks?cursor=${encodeURIComponent(taskPage.next_cursor)}&limit=1`;
  const taskSecond=await h.api('GET',laterTaskPage);
  await h.restart(s=>{for(const taskId of new Set([TASK,laterTask,taskSecond.items[0].task_id]))s.tasks[taskId].recipients=s.tasks[taskId].recipients.filter(u=>u!=='user_demo_a');});
  const replay=await h.api('POST',path,body,{key,expected:404});assert.equal(replay.code,'NOT_FOUND');assert.ok(!JSON.stringify(replay).includes(message.title));
  await h.api('GET',`/v1/notifications/${message.notification_id}`,undefined,{expected:404});
  await h.api('POST','/v1/operations/lookup',{action:'read_notification',target_id:message.notification_id,idempotency_key:key},{expected:404});
  await h.api('GET',secondPath,undefined,{expected:404});await h.api('GET',laterTaskPage,undefined,{expected:404});
});

test('不透明task_id恰为files时，新0.2记录同键重放不被误判为旧协议', async t => {
  const h = await harness(t), key = KEY();
  await h.restart(state => {
    state.tasks.files = structuredClone(state.tasks[TASK]);
    state.tasks.files.value.task_id = 'files';
  });
  const first = await h.upload({ key, taskId: 'files' });
  const replay = await h.upload({ key, taskId: 'files' });
  assert.equal(replay.file_id, first.file_id);
  const result = await h.api('POST', '/v1/operations/lookup', { action: 'upload_file', target_id: 'files', idempotency_key: key }, { operation: 'lookupOperation' });
  assert.equal(result.receipt.id, first.file_id);
});

test('IF-002: on-time pending and approved submissions stay on-time after deadline and same-key replay', async t => {
  for (const review of ['pending', 'approved']) {
    const h = await harness(t), { request } = await h.prepare(), key = KEY();
    const due = '2026-10-15T13:00:00.000Z';
    await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: due, allow_late_submission: false });
    const saved = await h.submit(request, { key });
    assert.equal(saved.is_late, false);
    if (review === 'approved') await h.restart(state => { state.submissions[saved.submission_id].value.review_status = review; });
    h.setTime(Date.parse(due) + 1);
    const current = await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' });
    assert.equal(current.student_state.is_overdue, false, review);
    assert.equal(current.student_state.review_status, review);
    assert.equal(current.student_state.display_status, review === 'approved' ? 'approved' : 'submitted_pending_review');
    const replay = await h.submit(request, { key });
    assert.equal(replay.submission_id, saved.submission_id);
    assert.equal(replay.submitted_at, saved.submitted_at);
    assert.equal(replay.is_late, false);
    const page = await h.api('GET', '/v1/me/tasks', undefined, { operation: 'listMyTasks' });
    assert.equal(page.items.find(item => item.task_id === TASK).student_state.is_overdue, false);
    const state = JSON.parse(await readFile(join(h.dataDir, 'state.json'), 'utf8'));
    assert.equal(Object.values(state.submissions).filter(item => item.value.task_id === TASK).length, 1);
  }
});

test('IF-002: late submission remains late after review; unsubmitted unknown and no-deadline differ', async t => {
  const h = await harness(t), { request } = await h.prepare();
  const due = '2026-10-15T13:00:00.000Z';
  await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: due, allow_late_submission: true });
  h.setTime(Date.parse(due) + 1);
  const saved = await h.submit(request);
  assert.equal(saved.is_late, true);
  for (const review of ['pending', 'approved']) {
    await h.restart(state => { state.submissions[saved.submission_id].value.review_status = review; });
    const current = await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' });
    assert.equal(current.student_state.is_overdue, true);
    assert.equal(current.student_state.review_status, review);
  }
  await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: '2026-10-20T13:00:00.000Z', allow_late_submission: true });
  assert.equal((await h.api('GET', `/v1/tasks/${TASK}`)).student_state.is_overdue, true, 'later deadline edits do not rewrite saved lateness');
  for (const [taskId, canSubmit] of [['task_demo_unknown', false], ['task_demo_no_deadline', true]]) {
    await h.api('POST', `/v1/tasks/${taskId}/confirm`, { requirement_version: 1 }, { key: KEY() });
    const current = await h.api('GET', `/v1/tasks/${taskId}`, undefined, { operation: 'getTask' });
    assert.equal(current.student_state.is_overdue, false);
    assert.equal(current.student_state.allowed_actions.includes('submit'), canSubmit);
  }
});

test('IF-002: unsubmitted deadline boundary and independent late-policy admission', async t => {
  for (const allow of [false, true]) {
    const h = await harness(t), { request } = await h.prepare();
    const due = '2026-10-15T13:00:00.000Z';
    await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: due, allow_late_submission: allow });
    for (const offset of [-1, 0, 1]) {
      h.setTime(Date.parse(due) + offset);
      const state = (await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' })).student_state;
      assert.equal(state.is_overdue, offset > 0);
      assert.equal(state.allowed_actions.includes('submit'), offset <= 0 || allow);
    }
    const result = await h.submit(request, { expected: allow ? 201 : 422 });
    assert.equal(allow ? result.is_late : result.code, allow ? true : 'DEADLINE_PASSED');
  }
});

test('IF-002: on-time effective submission does not grant revision after a closed deadline', async t => {
  for (const allow of [false, true]) {
    for (const invalidation of ['needs_revision', 'requirements_changed']) {
      const h = await harness(t), { request } = await h.prepare();
      const saved = await h.submit(request);
      const due = '2026-10-15T13:00:00.000Z';
      await h.scenario({ scenario: 'set_deadline', task_id: TASK, due_at: due, allow_late_submission: allow });
      if (invalidation === 'needs_revision') await h.scenario({ scenario: 'review_needs_revision', task_id: TASK, expected_effective_submission_id: saved.submission_id, expected_resource_version: saved.resource_version });
      else await h.scenario({ scenario: 'requirements_changed', task_id: TASK });
      h.setTime(Date.parse(due) + 1);
      let task = await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' });
      await h.api('POST', `/v1/tasks/${TASK}/confirm`, { requirement_version: task.requirement_version }, { key: KEY() });
      task = await h.api('GET', `/v1/tasks/${TASK}`, undefined, { operation: 'getTask' });
      assert.equal(task.student_state.is_overdue, false);
      assert.equal(task.student_state.allowed_actions.includes('submit'), allow);
      const next = await h.prepare({ revision: saved.submission_id, requirement: task.requirement_version });
      const result = await h.submit(next.request, { expected: allow ? 201 : 422 });
      assert.equal(allow ? result.is_late : result.code, allow ? true : 'DEADLINE_PASSED');
      const after = await h.api('GET', `/v1/tasks/${TASK}`);
      assert.equal(after.student_state.effective_submission_id, allow ? result.submission_id : saved.submission_id);
    }
  }
});
