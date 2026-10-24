import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spec, validateRequest, validateResponse, validateSchema } from '../contracts/runtime-validation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = ['text/plain', 'text/csv', 'application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
const USERS = { 'demo-student-a': 'user_demo_a', 'demo-student-b': 'user_demo_b' };
const ACTIONS = { confirmTask: 'confirm_notice', submitMaterials: 'submit_materials', uploadFile: 'upload_file', startCheck: 'start_check', retryRun: 'retry_run', cancelRun: 'cancel_run', supplyRunInputs: 'supply_run_input', readNotification: 'read_notification' };
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const id = prefix => `${prefix}_${randomUUID()}`;
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const operationKey = (user, action, target, key) => canonical([user, action, target, key]);
function operationTarget(operationId, parameters, body) {
  if (operationId !== 'uploadFile') return parameters.task_id ?? parameters.draft_id ?? parameters.run_id ?? parameters.notification_id ?? '';
  if (body.purpose === 'submission_material') {
    if (!body.task_id || body.class_id !== undefined) fail(422, 'VALIDATION_FAILED', '材料上传必须指定任务且不能携带班级作用域');
    return body.task_id;
  }
  if (body.purpose === 'source') {
    if (body.task_id !== undefined || body.class_id !== undefined) fail(422, 'VALIDATION_FAILED', '来源上传不能携带任务或班级作用域');
    return 'self';
  }
  return body.class_id ?? '';
}
class ApiFailure extends Error {
  constructor(status, code, message, details = {}) { super(message); Object.assign(this, { status, code, details }); }
}
function fail(status, code, message, details) { throw new ApiFailure(status, code, message, details); }
function own(collection, objectId, user) {
  const item = collection[objectId];
  if (!item || item.owner !== user) fail(404, 'NOT_FOUND', '对象不存在或不可访问');
  return item;
}
const publicValue = item => clone(item.value);
function publicRun(item) {
  const value = publicValue(item);
  // Historical demo failures kept a partial check as a final Run result. Project
  // the adopted response semantics without rewriting durable recovery records.
  if (value.status === 'failed') {
    value.result_ref = null;
    value.check_id = null;
  }
  return value;
}
function taskFor(s, taskId, user) {
  const task = s.tasks[taskId];
  if (!task || !task.recipients.includes(user)) fail(404, 'NOT_FOUND', '对象不存在或不可访问');
  return task;
}
function versionTask(task, expected) {
  if (task.value.requirement_version !== expected) fail(409, 'REQUIREMENT_VERSION_CONFLICT', '任务要求已更新，请重新核对', { current_requirement_version: task.value.requirement_version });
}
function writable(task) {
  if (task.value.status === 'withdrawn') fail(409, 'TASK_WITHDRAWN', '任务已撤销');
  if (task.value.status !== 'published') fail(409, 'RESOURCE_VERSION_CONFLICT', '当前任务不可操作', { current_resource_version: task.value.resource_version });
}
function draftVersion(draft, expected) {
  if (draft.value.draft_version !== expected) fail(409, 'RESOURCE_VERSION_CONFLICT', '草稿已改变，请刷新', { current_draft_version: draft.value.draft_version });
}
function filesFor(s, ids, user) {
  if (ids.length > 5) fail(422, 'VALIDATION_FAILED', '演示环境每份草稿最多 5 个文件');
  return ids.map(fileId => {
    const file = own(s.files, fileId, user);
    if (file.value.state !== 'saved') fail(422, 'VALIDATION_FAILED', '文件尚未保存');
    return file;
  });
}
function stateFor(s, task, user, now) {
  const value = clone(task.states[user]);
  const submission = value.effective_submission_id ? s.submissions[value.effective_submission_id].value : null;
  value.submission_status = submission ? 'submitted' : 'none';
  value.review_status = submission?.review_status ?? null;
  const deadlinePassed = task.value.deadline.kind === 'at' && Date.parse(now) > Date.parse(task.value.deadline.due_at);
  value.is_overdue = submission ? submission.is_late : deadlinePassed;
  const invalidatedSubmission = submission && submission.requirement_version < (task.resubmitFrom ?? 1);
  let status;
  if (['withdrawn', 'archived'].includes(task.value.status)) status = task.value.status;
  else if (value.review_status === 'needs_revision') status = 'needs_revision';
  else if (value.confirmation_status === 'pending') status = value.read_status === 'unread' ? 'unread' : 'awaiting_confirmation';
  else if (task.value.policy.requires_submission && (!submission || invalidatedSubmission)) status = 'awaiting_submission';
  else if (value.review_status === 'pending') status = 'submitted_pending_review';
  else if (value.review_status === 'approved') status = 'approved';
  else status = 'completed';
  value.display_status = status;
  const actions = ['view_source'];
  if (submission) actions.push('view_history');
  if (task.value.status === 'published') {
    if (value.read_status === 'unread') actions.push('read');
    if (value.confirmation_status === 'pending') actions.push('confirm');
    if (task.value.policy.requires_submission && (!submission || value.review_status === 'needs_revision' || invalidatedSubmission)) {
      actions.push(submission ? 'prepare_revision' : 'create_draft', 'upload', 'check');
      if (task.value.deadline.kind !== 'unknown' && (!deadlinePassed || task.value.policy.allow_late_submission) && (!task.value.policy.requires_confirmation_before_submission || value.confirmation_status === 'confirmed')) actions.push('submit');
    }
  }
  value.allowed_actions = actions;
  return value;
}
function taskView(s, task, user, now) { return { ...clone(task.value), student_state: stateFor(s, task, user, now) }; }
function freshStudent() {
  return { read_status: 'unread', read_at: null, read_requirement_version: null, confirmation_status: 'pending', confirmed_at: null, confirmed_requirement_version: null, submission_status: 'none', effective_submission_id: null, review_status: null, is_overdue: false, display_status: 'unread', allowed_actions: [] };
}
function addNotification(s, { eventId, kind, taskId, title, time, recipients }) {
  s.notifications ??= {};
  for (const owner of recipients) {
    if (Object.values(s.notifications).some(item => item.owner === owner && item.value.event_id === eventId)) continue;
    const notificationId = id('notification');
    const value = { notification_id: notificationId, event_id: eventId, recipient_user_id: owner,
      kind, title, target: { kind: 'task', id: taskId, result_path: `/v1/tasks/${taskId}` },
      read_status: 'unread', read_at: null, resource_version: 1, channel: 'in_app',
      delivery_status: 'stored', created_at: time };
    s.notifications[notificationId] = { owner, value };
  }
}
function seedNotifications(s) {
  for (const task of Object.values(s.tasks)) addNotification(s, {
    eventId: `demo_published_${task.value.task_id}`, kind: 'task_published', taskId: task.value.task_id,
    title: `虚拟任务通知：${task.value.title}`, time: task.value.created_at, recipients: task.recipients,
  });
}
function notificationFor(s, notificationId, user) {
  const record = own(s.notifications ?? {}, notificationId, user);
  taskFor(s, record.value.target.id, user);
  return record;
}

function authorizeRecordedOperation(s, user, action, target, snapshot) {
  if (action === 'read_notification') notificationFor(s, target, user);
  else if (['confirm_notice','submit_materials'].includes(action)) taskFor(s, target, user);
  else if (action === 'start_check') taskFor(s, own(s.drafts, target, user).value.task_id, user);
  else if (['retry_run','cancel_run','supply_run_input'].includes(action)) {
    const record = own(s.runs, target, user);
    if (record.draft_snapshot) taskFor(s, record.draft_snapshot.task_id, user);
  } else if (action === 'upload_file' && snapshot?.purpose === 'submission_material') taskFor(s, snapshot.task_id, user);
}

async function writeDurable(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
async function seed(dataDir, now) {
  const state = { format: 1, mode: 'demo', tasks: {}, sources: {}, files: {}, drafts: {}, submissions: {}, checks: {}, runs: {}, operations: {}, confirmations: [], events: [], scenarios: {}, pages: {} };
  const upcoming = new Date(Date.parse(now) + 3 * 86400000).toISOString();
  const settings = [
    ['pending', '新能源项目实践材料', { kind: 'at', due_at: upcoming, unknown_reason: null }],
    ['revision', '实践记录补正', { kind: 'at', due_at: upcoming, unknown_reason: null }],
    ['no_deadline', '个人实践记录归档', { kind: 'no_deadline', due_at: null, unknown_reason: null }],
    ['unknown', '活动材料通知（期限待核实）', { kind: 'unknown', due_at: null, unknown_reason: '原通知未说明具体截止时间，请等待发布方核实' }]
  ];
  for (const [suffix, title, deadline] of settings) {
    const taskId = `task_demo_${suffix}`, sourceId = `source_demo_${suffix}`;
    const requirements = [{ requirement_id: `requirement_demo_${suffix}`, label: '实践记录文件', required: true, kind: 'file', accepted_mime_types: MIME_TYPES, max_bytes: MAX_BYTES, instructions: '至少上传一份实践记录。内容真实性、姓名等信息由人工审核；演示服务不解析文件内容。' }];
    const value = { task_id: taskId, title, description: '虚拟演示任务。请核对要求、保存材料并明确确认正式提交。', source_ids: [sourceId], status: 'published', requirement_version: 1, resource_version: 1, requirements, deadline, policy: { requires_confirmation: true, requires_submission: true, requires_confirmation_before_submission: true, requires_review: true, allow_late_submission: true }, audience: { class_id: 'class_demo_energy', recipient_count: 2, recipient_scope_digest: digest('user_demo_a,user_demo_b'), description: '新能源演示班（虚拟）' }, student_state: null, withdrawn_reason: null, created_at: now, updated_at: now };
    state.tasks[taskId] = { value, recipients: Object.values(USERS), states: Object.fromEntries(Object.values(USERS).map(user => [user, freshStudent()])) };
    state.sources[sourceId] = { task_id: taskId, value: { source_id: sourceId, original_text: `【虚拟通知】${title}。请提供一份实践记录文件，正式提交后由人工审核。${deadline.kind === 'unknown' ? '期限待核实。' : deadline.kind === 'no_deadline' ? '本任务无截止期限。' : `截止 ${deadline.due_at}；允许迟交并保留逾期标识。`}`, file_id: null, origin: 'manual_text', captured_at: now, resource_version: 1 } };
  }
  for (const user of Object.values(USERS)) {
    const suffix = user.endsWith('_a') ? 'a' : 'b';
    const fileId = `file_demo_old_${suffix}`, draftId = `draft_demo_old_${suffix}`, subId = `submission_demo_old_${suffix}`;
    const bytes = Buffer.from(`虚拟实践记录 ${suffix}\n材料需要补正，由人工审核。\n`);
    await writeDurable(join(dataDir, 'files', `${fileId}.bin`), bytes);
    state.files[fileId] = { owner: user, purpose: 'submission_material', value: { file_id: fileId, filename: '实践记录.txt', mime: 'text/plain', size: bytes.length, content_hash: digest(bytes), state: 'saved', processing_status: 'unsupported', parse_supported: false, preview_supported: false, created_at: now } };
    state.drafts[draftId] = { owner: user, value: { draft_id: draftId, task_id: 'task_demo_revision', draft_version: 1, requirement_version: 1, file_ids: [fileId], text: '', revision_of_submission_id: null, current_check_id: null, created_at: now, updated_at: now } };
    state.submissions[subId] = { owner: user, review_note: '虚拟审核意见：请补充实践过程说明。当前公共契约尚未提供学生审核意见字段。', value: { submission_id: subId, task_id: 'task_demo_revision', submission_version: 1, requirement_version: 1, effective_submission_id: subId, submitted_at: now, is_late: false, review_status: 'needs_revision', file_ids: [fileId], resource_version: 2, draft_id: draftId, draft_version: 1 } };
    Object.assign(state.tasks.task_demo_revision.states[user], { read_status: 'read', read_at: now, read_requirement_version: 1, confirmation_status: 'confirmed', confirmed_at: now, confirmed_requirement_version: 1, effective_submission_id: subId });
  }
  seedNotifications(state);
  return state;
}
function capabilities() {
  const unavailable = reason => ({ available: false, mode: 'unavailable', reason, supported_mime_types: [], max_bytes: null });
  return { upload: { available: true, mode: 'demo', reason: '仅本机保存虚拟文件；单文件 20 MB，每份草稿最多 5 个文件', supported_mime_types: MIME_TYPES, max_bytes: MAX_BYTES }, preview: unavailable('尚未实现安全内嵌预览，可鉴权下载原文件'), parse: unavailable('真实 AI 和文件内容解析均未接通'), generate: unavailable('成果生成尚未接通'), push: unavailable('推送尚未接通'), checks: { available: true, mode: 'demo', reason: '仅确定性文件存在、数量、类型和大小规则；AI 未接通，内容由人工审核', supported_mime_types: MIME_TYPES, max_bytes: MAX_BYTES }, refresh_after_seconds: 60 };
}
function issuesFor(s, task, draft, user) {
  const files = filesFor(s, draft.file_ids, user), issues = [];
  const issue = (code, message, field) => issues.push({ code, message, field, evidence: [] });
  for (const rule of task.value.requirements) {
    if (rule.kind === 'file' && rule.required && !files.length) issue('FILE_REQUIRED', `请提供${rule.label}`, 'file_ids');
    if (rule.kind === 'text' && rule.required && !draft.text.trim()) issue('TEXT_REQUIRED', `请填写${rule.label}`, 'text');
    if (rule.kind === 'file') for (const file of files) {
      if (rule.accepted_mime_types.length && !rule.accepted_mime_types.includes(file.value.mime)) issue('FILE_TYPE_UNSUPPORTED', '文件类型不符合任务要求', 'file_ids');
      if (rule.max_bytes && file.value.size > rule.max_bytes) issue('FILE_TOO_LARGE', '文件超过任务上限', 'file_ids');
    }
  }
  return issues;
}
function makeRun(s, user, draft, now, retryOf = null) {
  const runId = id('run'), aiFailure = s.scenarios[user]?.ai_failure === true;
  const value = { run_id: runId, action: 'check_materials', status: 'queued', resource_version: 1, steps: [{ step_id: id('step'), name: '校验已保存文件和任务规则', status: 'queued', error: null }], result_ref: null, check_id: null, error: null, retry_of: retryOf, cancellable: true, input_fields: [], poll_after_seconds: 1, created_at: now, updated_at: now };
  s.runs[runId] = { owner: user, draft_snapshot: clone(draft.value), ai_failure: aiFailure, value };
  if (s.scenarios[user]?.waiting_input) {
    value.status = 'waiting_input';
    value.poll_after_seconds = null;
    value.input_fields = [{ name: 'explanation', label: '补充材料说明（虚拟检查）', type: 'text', required: true, choices: [] }];
  }
  return value;
}
function finishRun(s, runId, now) {
  const record = s.runs[runId];
  if (!record || TERMINAL.has(record.value.status) || record.value.status === 'waiting_input') return;
  const run = record.value;
  run.resource_version++;
  run.updated_at = now;
  run.cancellable = false;
  run.poll_after_seconds = null;
  if (run.status === 'cancelling') { run.status = 'cancelled'; run.steps.forEach(step => { step.status = 'cancelled'; }); return; }
  const draft = record.draft_snapshot, task = taskFor(s, draft.task_id, record.owner), checkId = id('check');
  const ruleIssues = issuesFor(s, task, draft, record.owner);
  if (draft.requirement_version !== task.value.requirement_version) ruleIssues.push({ code: 'REQUIREMENT_VERSION_CONFLICT', message: '检查期间要求已更新，请重新核对', field: 'requirement_version', evidence: [] });
  const check = { check_id: checkId, submission_draft_id: draft.draft_id, draft_version: draft.draft_version, requirement_version: draft.requirement_version, rule_status: ruleIssues.length ? 'blocked' : 'passed', rule_issues: ruleIssues, ai_suggestions: [], manual_checks: [{ code: 'AI_NOT_CONNECTED', message: '真实 AI 未接通，文件内容与真实性请交人工审核', field: null, evidence: [] }], model_run_id: null, created_at: now };
  s.checks[checkId] = { owner: record.owner, value: check };
  const current = s.drafts[draft.draft_id]?.value;
  if (current?.draft_version === draft.draft_version && current.requirement_version === draft.requirement_version) current.current_check_id = checkId;
  run.check_id = checkId;
  run.result_ref = { kind: 'check', id: checkId, result_path: `/v1/checks/${checkId}` };
  run.steps[0].status = 'succeeded';
  run.status = record.ai_failure ? 'failed' : 'succeeded';
  if (record.ai_failure) {
    // A failed Run cannot advertise a final result under the adopted contract.
    // The saved deterministic check remains reachable through the draft.
    run.check_id = null;
    run.result_ref = null;
    run.error = { code: 'AI_TIMEOUT', message: '演示故障：模拟 AI 超时；规则检查已保存，真实 AI 未接通', retryable: true };
    run.steps.push({ step_id: id('step'), name: '模拟 AI 预检故障', status: 'failed', error: clone(run.error) });
  }
}
function paginate(s, user, kind, items, query, now) {
  const limit = Number(query.limit ?? 20);
  let snapshot;
  let offset = 0;
  if (query.cursor) {
    const match = /^([A-Za-z0-9_-]+):(\d+)$/.exec(query.cursor);
    snapshot = match && s.pages[match[1]];
    if (!snapshot || snapshot.owner !== user || snapshot.kind !== kind) fail(422, 'VALIDATION_FAILED', '分页游标无效');
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset > snapshot.items.length) fail(422, 'VALIDATION_FAILED', '分页游标无效');
  } else {
    const pageId = randomUUID();
    snapshot = { page_id: pageId, owner: user, kind, items: clone(items), as_of: now };
    s.pages[pageId] = snapshot;
  }
  const next = offset + limit, more = next < snapshot.items.length;
  const slice = snapshot.items.slice(offset, next);
  // A stable as_of snapshot never freezes authorization. Revalidate each object
  // before exposing an old page, rather than returning revoked cached content.
  if (kind === 'notifications') slice.forEach(item => notificationFor(s,item.notification_id,user));
  if (kind.startsWith('tasks:')) slice.forEach(item => taskFor(s,item.task_id,user));
  return { items: clone(slice), next_cursor: more ? `${snapshot.page_id}:${next}` : null, has_more: more, as_of: snapshot.as_of };
}
function matchRoute(method, path) {
  for (const [pattern, methods] of Object.entries(spec.paths)) {
    const operation = methods[method.toLowerCase()];
    if (!operation) continue;
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/\{([^}]+)\}/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
    const match = regex.exec(path);
    if (match) return { operationId: operation.operationId, operation, pathParameters: Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])])) };
  }
  return null;
}
async function readBody(request, maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) fail(413, 'FILE_TOO_LARGE', '请求超过大小限制', { max_bytes: MAX_BYTES }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function decodeBody(request, route) {
  if (request.method === 'GET' || request.method === 'HEAD') return { body: undefined };
  const multipart = route?.operationId === 'uploadFile';
  const bytes = await readBody(request, multipart ? MAX_BYTES + 65536 : 1024 * 1024);
  const mediaType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (multipart) {
    if (mediaType !== 'multipart/form-data') fail(422, 'VALIDATION_FAILED', '上传必须使用 multipart/form-data');
    let form;
    try { form = await new Response(bytes, { headers: { 'Content-Type': request.headers['content-type'] } }).formData(); } catch { fail(422, 'VALIDATION_FAILED', 'multipart 数据格式不正确'); }
    const body = {}, seen = new Set(); let upload;
    for (const [key, value] of form.entries()) {
      if (seen.has(key)) fail(422, 'VALIDATION_FAILED', 'multipart 字段不能重复');
      seen.add(key);
      if (key === 'file' && typeof value !== 'string') { upload = { filename: value.name, mime: value.type.toLowerCase(), bytes: Buffer.from(await value.arrayBuffer()) }; body.file = 'multipart-file'; }
      else body[key] = value;
    }
    if (!upload) fail(422, 'VALIDATION_FAILED', '缺少原始文件 part');
    return { body, upload, mediaType };
  }
  if (mediaType !== 'application/json') fail(422, 'VALIDATION_FAILED', '请求必须使用 application/json');
  try { return { body: JSON.parse(bytes.toString('utf8')), mediaType }; } catch { fail(422, 'VALIDATION_FAILED', 'JSON 格式不正确'); }
}

export async function createDemoServer({ dataDir = join(HERE, '.data'), clock = () => new Date(), runDelayMs = 80 } = {}) {
  dataDir = resolve(dataDir);
  await mkdir(join(dataDir, 'files'), { recursive: true });
  const lockPath = join(dataDir, '.lock');
  try { const lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousPid = Number(await readFile(lockPath, 'utf8'));
    let alive = true; try { process.kill(previousPid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('演示数据目录已有进程使用；请使用不同 DEMO_DATA_DIR');
    await unlink(lockPath);
    const lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close();
  }
  const now = () => new Date(clock()).toISOString(), statePath = join(dataDir, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); if (state.mode !== 'demo' || state.format !== 1) throw new Error('Unsupported demo state'); }
  catch (error) { if (error.code !== 'ENOENT') { await unlink(lockPath); throw error; } state = await seed(dataDir, now()); await writeDurable(statePath, JSON.stringify(state)); }
  if (!state.notifications) {
    seedNotifications(state);
    await writeDurable(statePath, JSON.stringify(state));
  }
  let chain = Promise.resolve(), closing = false;
  const timers = new Map();
  function transaction(callback) {
    const operation = chain.then(async () => { const next = clone(state); const result = await callback(next); await writeDurable(statePath, JSON.stringify(next)); state = next; return result; });
    chain = operation.catch(() => {});
    return operation;
  }
  function schedule(runId) {
    if (closing || timers.has(runId)) return;
    const timer = setTimeout(() => {
      timers.delete(runId);
      transaction(s => finishRun(s, runId, now())).catch(() => { /* Persisted queued run resumes on server restart. */ });
    }, runDelayMs);
    timer.unref(); timers.set(runId, timer);
  }
  for (const run of Object.values(state.runs)) if (!TERMINAL.has(run.value.status) && run.value.status !== 'waiting_input') schedule(run.value.run_id);

  async function dispatch(s, operationId, user, p, body, query, upload, receivedAt) {
    const target = operationTarget(operationId, p, body);
    let data, status = 200, receipt = null, runId = null;
    if (operationId === 'getMe') data = { user_id: user, display_name: '林同学（虚拟）', memberships: [{ class_id: 'class_demo_energy', role: 'student', membership_status: 'active' }], active_class_id: 'class_demo_energy', active_role: 'student' };
    else if (operationId === 'getCapabilities') data = capabilities();
    else if (operationId === 'getMyProfile') data = { user_id: user, class_id: 'class_demo_energy', resource_version: 1, visible_fields: [], writable_fields: [], facts: [] };
    else if (operationId === 'listNotifications') {
      const items = Object.values(s.notifications).filter(item => item.owner === user && s.tasks[item.value.target.id]?.recipients.includes(user))
        .map(publicValue).sort((a,b) => b.created_at.localeCompare(a.created_at) || a.notification_id.localeCompare(b.notification_id));
      data = paginate(s, user, 'notifications', items, query, receivedAt);
    } else if (operationId === 'getNotification' || operationId === 'readNotification') {
      const record = notificationFor(s, p.notification_id, user);
      if (operationId === 'readNotification') {
        if (record.value.resource_version !== body.resource_version) fail(409, 'RESOURCE_VERSION_CONFLICT', '消息状态已更新，请刷新', { current_resource_version: record.value.resource_version });
        if (record.value.read_status !== 'read') Object.assign(record.value, { read_status: 'read', read_at: receivedAt, resource_version: record.value.resource_version + 1 });
        receipt = { kind:'notification',id:p.notification_id,result_path:`/v1/notifications/${p.notification_id}` };
      }
      data = publicValue(record);
    }
    else if (operationId === 'listMyTasks') {
      const items = Object.values(s.tasks).filter(t => t.recipients.includes(user) && (!query.status || t.value.status === query.status)).map(t => taskView(s, t, user, receivedAt)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.task_id.localeCompare(b.task_id));
      data = paginate(s, user, `tasks:${query.status ?? ''}`, items, query, receivedAt);
    } else if (operationId === 'getTask') data = taskView(s, taskFor(s, p.task_id, user), user, receivedAt);
    else if (operationId === 'getSource') {
      const source = s.sources[p.source_id];
      if (!source) fail(404, 'NOT_FOUND', '对象不存在或不可访问');
      taskFor(s, source.task_id, user); data = publicValue(source);
    } else if (operationId === 'readTask' || operationId === 'confirmTask') {
      const task = taskFor(s, p.task_id, user); versionTask(task, body.requirement_version);
      const student = task.states[user];
      if (operationId === 'readTask') {
        Object.assign(student, { read_status: 'read', read_at: receivedAt, read_requirement_version: body.requirement_version });
        data = { task_id: p.task_id, read_at: student.read_at, read_requirement_version: student.read_requirement_version, read_status: 'read' };
      } else {
        writable(task);
        if (body.confirmation_id) fail(422, 'ACTION_CONFIRMATION_REQUIRED', '对话提案确认协议尚未接通，请使用明确页面确认按钮');
        Object.assign(student, { confirmation_status: task.value.policy.requires_confirmation ? 'confirmed' : 'not_required', confirmed_at: task.value.policy.requires_confirmation ? receivedAt : null, confirmed_requirement_version: task.value.policy.requires_confirmation ? body.requirement_version : null });
        data = { task_id: p.task_id, confirmation_status: student.confirmation_status, confirmed_at: student.confirmed_at, confirmed_requirement_version: student.confirmed_requirement_version };
        receipt = { kind: 'confirmation', id: p.task_id, result_path: `/v1/tasks/${p.task_id}` };
        s.confirmations.push({ owner: user, action: 'confirm_notice', target_id: p.task_id, requirement_version: body.requirement_version, created_at: receivedAt });
      }
    } else if (operationId === 'uploadFile') {
      if (body.purpose !== 'submission_material') fail(503, 'CAPABILITY_UNAVAILABLE', '学生端演示仅开放任务材料上传，来源与名单导入未开放');
      if (body.task_id) { const task = taskFor(s, body.task_id, user); writable(task); }
      if (upload.bytes.length > MAX_BYTES) fail(413, 'FILE_TOO_LARGE', '文件超过 20 MB 演示限制', { max_bytes: MAX_BYTES });
      if (!upload.bytes.length) fail(422, 'VALIDATION_FAILED', '不能上传空文件');
      if (!MIME_TYPES.includes(upload.mime)) fail(415, 'FILE_TYPE_UNSUPPORTED', '演示环境尚不支持该文件类型', { supported_mime_types: MIME_TYPES });
      const fileId = id('file');
      await writeDurable(join(dataDir, 'files', `${fileId}.bin`), upload.bytes);
      data = { file_id: fileId, filename: upload.filename.replace(/[\r\n\x00]/g, '').split(/[\\/]/).pop() || 'material', mime: upload.mime, size: upload.bytes.length, content_hash: digest(upload.bytes), state: 'saved', processing_status: 'unsupported', parse_supported: false, preview_supported: false, created_at: receivedAt };
      s.files[fileId] = { owner: user, purpose: body.purpose, task_id: body.task_id ?? null, value: clone(data) };
      status = 201; receipt = { kind: 'file', id: fileId, result_path: `/v1/files/${fileId}` };
    } else if (operationId === 'getFile') data = publicValue(own(s.files, p.file_id, user));
    else if (operationId === 'downloadFile') {
      const file = own(s.files, p.file_id, user).value;
      return { status: 200, binary: await readFile(join(dataDir, 'files', `${p.file_id}.bin`)), mime: file.mime, filename: file.filename };
    } else if (operationId === 'createDraft') {
      const task = taskFor(s, p.task_id, user); writable(task); versionTask(task, body.requirement_version); filesFor(s, body.file_ids, user);
      if (body.revision_of_submission_id) { const old = own(s.submissions, body.revision_of_submission_id, user); if (old.value.task_id !== p.task_id) fail(422, 'VALIDATION_FAILED', '补交版本不属于当前任务'); }
      const draftId = id('draft');
      data = { draft_id: draftId, task_id: p.task_id, draft_version: 1, ...body, current_check_id: null, created_at: receivedAt, updated_at: receivedAt };
      s.drafts[draftId] = { owner: user, value: clone(data) }; status = 201;
    } else if (operationId === 'getDraft') data = publicValue(own(s.drafts, p.draft_id, user));
    else if (operationId === 'patchDraft') {
      const draft = own(s.drafts, p.draft_id, user), task = taskFor(s, draft.value.task_id, user);
      writable(task); versionTask(task, body.requirement_version); draftVersion(draft, body.draft_version); filesFor(s, body.file_ids, user);
      if (Object.values(s.submissions).some(sub => sub.owner === user && sub.value.draft_id === p.draft_id && sub.value.draft_version === body.draft_version)) fail(409, 'RESOURCE_VERSION_CONFLICT', '已提交草稿不可修改，请创建补交草稿', { current_draft_version: body.draft_version });
      Object.assign(draft.value, body, { draft_version: body.draft_version + 1, current_check_id: null, updated_at: receivedAt }); data = publicValue(draft);
    } else if (operationId === 'startCheck') {
      const draft = own(s.drafts, p.draft_id, user), task = taskFor(s, draft.value.task_id, user);
      writable(task); versionTask(task, body.requirement_version); draftVersion(draft, body.draft_version);
      if (draft.value.requirement_version !== body.requirement_version) fail(409, 'REQUIREMENT_VERSION_CONFLICT', '草稿要求版本已失效', { current_requirement_version: task.value.requirement_version });
      data = makeRun(s, user, draft, receivedAt); status = 202; runId = data.run_id;
      receipt = { kind: 'run', id: runId, result_path: `/v1/runs/${runId}` };
    } else if (operationId === 'getCheck') data = publicValue(own(s.checks, p.check_id, user));
    else if (operationId === 'submitMaterials') {
      const task = taskFor(s, p.task_id, user), draft = own(s.drafts, body.draft_id, user);
      writable(task); versionTask(task, body.requirement_version); draftVersion(draft, body.draft_version);
      if (draft.value.task_id !== p.task_id) fail(422, 'VALIDATION_FAILED', '草稿不属于当前任务');
      if (draft.value.requirement_version !== body.requirement_version) fail(409, 'REQUIREMENT_VERSION_CONFLICT', '草稿要求版本已失效', { current_requirement_version: task.value.requirement_version });
      const student = task.states[user];
      if (student.effective_submission_id !== body.expected_effective_submission_id) fail(409, 'RESOURCE_VERSION_CONFLICT', '另一操作已更新有效提交，请刷新后重新核对', { current_effective_submission_id: student.effective_submission_id });
      if (body.confirmation_id) fail(422, 'ACTION_CONFIRMATION_REQUIRED', '对话提案协议未接通，请使用明确页面提交按钮');
      if (task.value.policy.requires_confirmation_before_submission && student.confirmation_status !== 'confirmed') fail(422, 'ACTION_CONFIRMATION_REQUIRED', '请先明确确认当前通知要求');
      if (!task.value.policy.requires_submission) fail(422, 'VALIDATION_FAILED', '此任务不要求材料提交');
      if (student.effective_submission_id && s.submissions[student.effective_submission_id].value.review_status !== 'needs_revision' && !(s.submissions[student.effective_submission_id].value.requirement_version < (task.resubmitFrom ?? 1))) fail(409, 'RESOURCE_VERSION_CONFLICT', '当前有效提交未要求补交', { current_effective_submission_id: student.effective_submission_id });
      if (student.effective_submission_id !== draft.value.revision_of_submission_id) fail(409, 'RESOURCE_VERSION_CONFLICT', '补交草稿必须引用当前有效提交', { current_effective_submission_id: student.effective_submission_id });
      if (task.value.deadline.kind === 'unknown') fail(422, 'DEADLINE_UNKNOWN', '期限尚未明确，请联系发布方核实');
      const late = task.value.deadline.kind === 'at' && Date.parse(receivedAt) > Date.parse(task.value.deadline.due_at);
      if (late && !task.value.policy.allow_late_submission) fail(422, 'DEADLINE_PASSED', '已过截止时间，任务不允许迟交');
      const problems = issuesFor(s, task, draft.value, user);
      if (!draft.value.file_ids.length || problems.length) fail(422, 'VALIDATION_FAILED', '材料存在确定性规则问题', { field_errors: problems.map(issue => ({ field: issue.field ?? 'file_ids', code: issue.code, message: issue.message })) });
      if (Object.values(s.submissions).some(sub => sub.owner === user && sub.value.draft_id === body.draft_id && sub.value.draft_version === body.draft_version)) fail(409, 'RESOURCE_VERSION_CONFLICT', '该草稿版本已有正式提交', { current_effective_submission_id: student.effective_submission_id });
      const versions = Object.values(s.submissions).filter(sub => sub.owner === user && sub.value.task_id === p.task_id).map(sub => sub.value.submission_version);
      const submissionId = id('submission');
      data = { submission_id: submissionId, task_id: p.task_id, submission_version: Math.max(0, ...versions) + 1, requirement_version: body.requirement_version, effective_submission_id: submissionId, submitted_at: receivedAt, is_late: late, review_status: task.value.policy.requires_review ? 'pending' : 'not_required', file_ids: clone(draft.value.file_ids), resource_version: 1, draft_id: body.draft_id, draft_version: body.draft_version };
      s.submissions[submissionId] = { owner: user, value: clone(data) }; student.effective_submission_id = submissionId;
      s.confirmations.push({ owner: user, action: 'submit_materials', target_id: p.task_id, request: clone(body), file_ids: clone(draft.value.file_ids), created_at: receivedAt });
      s.events.push({ event_id: id('event'), type: 'submission_saved', submission_id: submissionId, owner: user, created_at: receivedAt });
      status = 201; receipt = { kind: 'submission', id: submissionId, result_path: `/v1/tasks/${p.task_id}/my-submissions` };
    } else if (operationId === 'listMySubmissions') {
      const task = taskFor(s, p.task_id, user), effective = task.states[user].effective_submission_id;
      const items = Object.values(s.submissions).filter(sub => sub.owner === user && sub.value.task_id === p.task_id).map(sub => ({ ...publicValue(sub), effective_submission_id: effective })).sort((a, b) => b.submission_version - a.submission_version);
      data = paginate(s, user, `submissions:${p.task_id}`, items, query, receivedAt);
    } else if (operationId === 'lookupOperation') {
      const found = s.operations[operationKey(user, body.action, body.target_id, body.idempotency_key)];
      if (found) {
        authorizeRecordedOperation(s,user,found.action,found.target_id,found.request_snapshot);
        data = { status: 'succeeded', outcome: 'effect_recorded', receipt: clone(found.receipt), retry_after_seconds: null, next_action: 'read_receipt' };
      }
      else data = { status: 'not_found', outcome: 'unknown', receipt: null, retry_after_seconds: 1, next_action: 'lookup_same_operation' };
    } else if (operationId === 'listMyRuns') {
      const items = Object.values(s.runs).filter(run => run.owner === user && (!query.status || run.value.status === query.status)).map(publicRun).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.run_id.localeCompare(b.run_id));
      data = paginate(s, user, `runs:${query.status ?? ''}`, items, query, receivedAt);
    } else if (operationId === 'getRun') data = publicRun(own(s.runs, p.run_id, user));
    else if (operationId === 'retryRun' || operationId === 'cancelRun' || operationId === 'supplyRunInputs') {
      const record = own(s.runs, p.run_id, user), run = record.value;
      if (run.resource_version !== body.resource_version) fail(409, 'RESOURCE_VERSION_CONFLICT', '执行状态已改变，请刷新', { current_resource_version: run.resource_version });
      if (operationId === 'supplyRunInputs') {
        if (run.status !== 'waiting_input') fail(409, 'RESOURCE_VERSION_CONFLICT', '当前执行不在等待补充状态');
        const names = body.inputs.map(item => item.name);
        if (new Set(names).size !== names.length || names.some(name => !run.input_fields.some(field => field.name === name))) fail(422, 'VALIDATION_FAILED', '补充字段不能重复或超出等待范围');
        for (const field of run.input_fields) {
          const item = body.inputs.find(value => value.name === field.name);
          if (field.required && !item?.value.trim()) fail(422, 'VALIDATION_FAILED', '请补齐执行要求的字段');
          if (item && field.type === 'choice' && !field.choices.includes(item.value)) fail(422, 'VALIDATION_FAILED', '补充选项不在允许范围');
          if (item && field.type === 'file_id') own(s.files, item.value, user);
        }
        const task = taskFor(s, record.draft_snapshot.task_id, user);
        writable(task); versionTask(task, record.draft_snapshot.requirement_version);
        record.supplied_inputs = clone(body.inputs);
        Object.assign(run, { status: 'queued', input_fields: [], resource_version: run.resource_version + 1, poll_after_seconds: 1, updated_at: receivedAt });
        data = clone(run); runId = run.run_id;
      } else if (operationId === 'retryRun') {
        if (!['failed', 'cancelled'].includes(run.status) || (run.status === 'failed' && !run.error?.retryable)) fail(409, 'RUN_NOT_RETRYABLE', '此执行不可重试');
        const draft = own(s.drafts, record.draft_snapshot.draft_id, user), task = taskFor(s, draft.value.task_id, user);
        writable(task); versionTask(task, record.draft_snapshot.requirement_version); draftVersion(draft, record.draft_snapshot.draft_version);
        data = makeRun(s, user, draft, receivedAt, p.run_id); runId = data.run_id;
      } else {
        if (record.draft_snapshot) taskFor(s, record.draft_snapshot.task_id, user);
        if (!run.cancellable || TERMINAL.has(run.status)) fail(409, 'RUN_NOT_CANCELLABLE', '此执行已经结束或不可取消');
        Object.assign(run, { status: 'cancelling', resource_version: run.resource_version + 1, cancellable: false, updated_at: receivedAt }); data = clone(run); runId = run.run_id;
      }
      status = 202; receipt = { kind: 'run', id: runId, result_path: `/v1/runs/${runId}` };
    } else fail(503, 'CAPABILITY_UNAVAILABLE', '此能力尚未在学生端演示服务实现');
    return { status, data: clone(data), receipt, runId, target };
  }

  async function scenario(s, user, body) {
    if (!body || typeof body.scenario !== 'string' || Object.keys(body).some(key => !['scenario', 'task_id', 'enabled', 'due_at', 'allow_late_submission', 'expected_effective_submission_id', 'expected_resource_version'].includes(key))) fail(422, 'VALIDATION_FAILED', '演示控制参数不正确');
    s.scenarios[user] ??= {};
    if (['drop_next_submit_response', 'drop_next_upload_response', 'drop_next_patch_response', 'drop_next_run_response', 'drop_next_notification_response', 'waiting_input', 'ai_failure'].includes(body.scenario)) {
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(422, 'VALIDATION_FAILED', 'enabled 必须是布尔值');
      s.scenarios[user][body.scenario] = body.enabled ?? true;
      return { scenario: body.scenario, enabled: s.scenarios[user][body.scenario], mode: 'demo' };
    }
    const task = taskFor(s, body.task_id, user), time = now();
    if (body.scenario === 'requirements_changed') {
      task.value.requirement_version++; task.value.resource_version++; task.value.updated_at = time; task.resubmitFrom = task.value.requirement_version;
      task.value.requirements[0].instructions = `演示要求版本 ${task.value.requirement_version}：请重新核对文件并提交，由人工审核内容。`;
      for (const student of Object.values(task.states)) student.confirmation_status = 'pending';
      const eventId = `demo_requirements_${body.task_id}_${task.value.requirement_version}`;
      s.events.push({ event_id:eventId, type:'requirements_changed',task_id:body.task_id,created_at:time });
      addNotification(s, {eventId,kind:'requirements_changed',taskId:body.task_id,title:'虚拟任务要求已更新，请重新核对',time,recipients:task.recipients});
    } else if (body.scenario === 'review_needs_revision') {
      const effective = task.states[user].effective_submission_id;
      if (!effective) fail(422, 'VALIDATION_FAILED', '尚无有效提交可退回');
      const submission = s.submissions[effective];
      if (body.expected_effective_submission_id !== undefined && effective !== body.expected_effective_submission_id) fail(409, 'RESOURCE_VERSION_CONFLICT', '有效提交已改变', { current_effective_submission_id: effective });
      if (body.expected_resource_version !== undefined && submission.value.resource_version !== body.expected_resource_version) fail(409, 'RESOURCE_VERSION_CONFLICT', '审核版本已改变', { current_resource_version: submission.value.resource_version });
      submission.value.review_status = 'needs_revision'; submission.value.resource_version++; submission.review_note = '演示退回：请补充实践过程说明';
      const eventId = `demo_review_${effective}_${submission.value.resource_version}`;
      s.events.push({event_id:eventId,type:'review_feedback',submission_id:effective,owner:user,created_at:time});
      addNotification(s,{eventId,kind:'review_feedback',taskId:body.task_id,title:'虚拟材料需要补正，请查看关联提交版本',time,recipients:[user]});
    } else if (body.scenario === 'withdraw_task') {
      task.value.status = 'withdrawn'; task.value.withdrawn_reason = '演示控制：发布方已撤销任务'; task.value.resource_version++; task.value.updated_at = time;
    } else if (body.scenario === 'set_deadline') {
      if (typeof body.due_at !== 'string' || validateSchema('Timestamp', body.due_at).length || typeof body.allow_late_submission !== 'boolean') fail(422, 'VALIDATION_FAILED', '截止参数必须包含带时区时间和迟交开关');
      task.value.deadline = { kind: 'at', due_at: body.due_at, unknown_reason: null }; task.value.policy.allow_late_submission = body.allow_late_submission; task.value.resource_version++; task.value.updated_at = time;
    } else fail(422, 'VALIDATION_FAILED', '未知演示场景');
    return { scenario: body.scenario, mode: 'demo', task: taskView(s, task, user, time) };
  }

  const server = http.createServer(async (request, response) => {
    const requestId = id('req');
    let route;
    const envelope = value => ({ ...value, meta: { request_id: requestId, server_time: now(), mode: 'demo' } });
    function send(status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.headers.origin) {
        let origin; try { origin = new URL(request.headers.origin); } catch { fail(403, 'FORBIDDEN', '浏览器来源无效'); }
        if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost'].includes(origin.hostname)) fail(403, 'FORBIDDEN', '演示服务仅允许本机浏览器来源');
        response.setHeader('Access-Control-Allow-Origin', origin.origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1], user = Object.hasOwn(USERS, token) ? USERS[token] : null;
      if (!user) fail(401, 'AUTH_REQUIRED', '请选择演示账号；真实身份认证尚未接通');
      if (url.pathname === '/__demo/scenario' && request.method === 'POST') {
        const decoded = await decodeBody(request, null);
        const data = await transaction(s => scenario(s, user, decoded.body)); send(200, envelope({ data })); return;
      }
      route = matchRoute(request.method, url.pathname);
      if (!route) fail(404, 'NOT_FOUND', '接口不存在');
      const query = Object.fromEntries(url.searchParams.entries());
      if (url.searchParams.size !== Object.keys(query).length) fail(422, 'VALIDATION_FAILED', '查询参数不能重复');
      const { body, upload, mediaType } = await decodeBody(request, route);
      const requestErrors = validateRequest(route.operationId, { pathParameters: route.pathParameters, query, headers: request.headers, ...(body === undefined ? {} : { body }), ...(mediaType ? { mediaType } : {}) });
      if (requestErrors.length) fail(422, 'VALIDATION_FAILED', '请求不符合接口契约', { field_errors: requestErrors.slice(0, 10).map(message => ({ field: 'request', code: 'SCHEMA_INVALID', message })) });
      const receivedAt = now(), action = ACTIONS[route.operationId], key = request.headers['idempotency-key'];
      const target = operationTarget(route.operationId, route.pathParameters, body);
      const snapshot = upload ? { ...body, file: { filename: upload.filename, mime: upload.mime, size: upload.bytes.length, sha256: digest(upload.bytes) } } : body;
      const fingerprint = digest(canonical(snapshot ?? null));
      const result = await transaction(async s => {
        // A v0.1 upload used the private "files" target. Never reinterpret that
        // unresolved intent as a new v0.2 task-scoped write, even with identical bytes.
        const legacyUpload = route.operationId === 'uploadFile' ? s.operations[operationKey(user, action, 'files', key)] : null;
        if (legacyUpload && legacyUpload.contract_version !== spec.info.version) {
          fail(503, 'CAPABILITY_UNAVAILABLE', '发现旧协议上传记录，请保留原键并使用原 files 目标查询；不能按新目标重新上传');
        }
        const storeKey = action ? operationKey(user, action, target, key) : null;
        if (storeKey && s.operations[storeKey]) {
          const previous = s.operations[storeKey];
          authorizeRecordedOperation(s,user,previous.action,previous.target_id,previous.request_snapshot);
          if (previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同内容');
          return { status: previous.status, data: clone(previous.data), replayed: true };
        }
        const result = await dispatch(s, route.operationId, user, route.pathParameters, body, query, upload, receivedAt);
        if (!result.binary) {
          const errors = validateResponse(route.operationId, result.status, envelope({ data: result.data }));
          if (errors.length) throw new Error(`Response contract failure: ${errors.join('; ')}`);
        }
        if (storeKey) s.operations[storeKey] = { owner: user, action, target_id: target, key, fingerprint, request_snapshot: clone(snapshot), status: result.status, data: clone(result.data), receipt: clone(result.receipt), created_at: receivedAt, contract_version: spec.info.version };
        if (route.operationId === 'submitMaterials' && s.scenarios[user]?.drop_next_submit_response) { s.scenarios[user].drop_next_submit_response = false; result.drop = true; }
        if (route.operationId === 'readNotification' && s.scenarios[user]?.drop_next_notification_response) { s.scenarios[user].drop_next_notification_response = false; result.drop = true; }
        if (route.operationId === 'uploadFile' && s.scenarios[user]?.drop_next_upload_response) { s.scenarios[user].drop_next_upload_response = false; result.drop = true; }
        if (route.operationId === 'patchDraft' && s.scenarios[user]?.drop_next_patch_response) { s.scenarios[user].drop_next_patch_response = false; result.drop = true; }
        if (['cancelRun', 'retryRun', 'supplyRunInputs'].includes(route.operationId) && s.scenarios[user]?.drop_next_run_response) { s.scenarios[user].drop_next_run_response = false; result.drop = true; }
        return result;
      });
      if (result.runId) schedule(result.runId);
      if (result.drop) { response.destroy(); return; }
      if (result.binary) {
        response.writeHead(200, { 'Content-Type': result.mime, 'Content-Length': result.binary.length, 'Content-Disposition': `attachment; filename="material"; filename*=UTF-8''${encodeURIComponent(result.filename)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(result.binary); return;
      }
      send(result.status, envelope({ data: result.data }));
    } catch (error) {
      const known = error instanceof ApiFailure;
      if (!known) console.error(`[demo] ${requestId} ${error.message}`);
      const status = known ? error.status : 503;
      const result = envelope({ error: { code: known ? error.code : 'SERVICE_UNAVAILABLE', message: known ? error.message : '演示服务暂时不可用，正式操作请使用原键查询', retryable: !known, details: known ? error.details : {} } });
      if (!response.destroyed) send(status, result);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {
    server,
    async listen(port = 18765) { await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolveListen(); }); }); return `http://127.0.0.1:${server.address().port}`; },
    async close() { closing = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); await new Promise(resolveClose => { if (!server.listening) resolveClose(); else server.close(resolveClose); server.closeIdleConnections(); }); await chain; await unlink(lockPath); }
  };
}

// Node canonicalizes the imported module path; argv[1] can retain a Windows
// junction alias. Canonicalize both sides so direct execution still starts.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const fixed = process.env.DEMO_CLOCK;
  if (fixed && validateSchema('Timestamp', fixed).length) throw new Error('DEMO_CLOCK 必须是带时区的有效时间');
  const app = await createDemoServer({ dataDir: process.env.DEMO_DATA_DIR || join(HERE, '.data'), ...(fixed ? { clock: () => new Date(fixed) } : {}) });
  const address = await app.listen(Number(process.env.PORT || 18765));
  console.log(`学生端本机演示服务 ${address} (mode=demo；真实身份与 AI 未接通)`);
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
