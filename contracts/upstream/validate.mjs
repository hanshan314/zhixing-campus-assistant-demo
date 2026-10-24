// Runtime imports are pure; the complete fixed-fixture suite runs only at the CLI entry.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from './runtime-validator.mjs';

const spec = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
export const validate = createValidator(spec);

export function runFixtureSuite() {
const fixtures = JSON.parse(readFileSync(new URL('./examples.json', import.meta.url), 'utf8'));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
function resolve(reference) {
  if (!reference.startsWith('#/')) throw new Error(`Only local references allowed: ${reference}`);
  let target = spec;
  for (const part of reference.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!target || !Object.hasOwn(target, key)) throw new Error(`Unresolved reference: ${reference}`);
    target = target[key];
  }
  return target;
}
function deref(value) { return value?.$ref ? deref(resolve(value.$ref)) : value; }
const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stable = value => Array.isArray(value) ? value.map(stable) : objectValue(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => equal(stable(a), stable(b));
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const textHash = text => createHash('sha256').update(text, 'utf8').digest('hex');

// These invariants validate actual fixture values, including nested response objects.
// They are acceptance checks, not a substitute for authorization in the business server.
function namedSemantics(name, v, path) {
  const errors = [], fail = message => errors.push(`${path}: ${message}`);
  if (name === 'ReceiptReference') {
    const template = spec['x-receipt-routes']?.[v.kind];
    if (!template) fail('unknown receipt kind route');
    else {
      const pattern = '^' + template.replace(/\{[^}]+\}/g, '[A-Za-z0-9][A-Za-z0-9._:-]*') + '$';
      if (!new RegExp(pattern).test(v.result_path)) fail('receipt route does not match kind');
      if (template.includes('{id}')) {
        const position = template.split('/').indexOf('{id}');
        if (v.result_path.split('/')[position] !== v.id) fail('receipt route id mismatch');
      }
    }
  }
  if (name === 'SourceContext' && ((v.scope === 'private') !== (v.class_id === null))) fail('source scope and class context disagree');
  if (name === 'SourceCreate') {
    if (v.original_text === null && v.file_id === null) fail('source requires original text or saved file');
    if (v.scope === 'private' && Object.hasOwn(v, 'class_id')) fail('private source cannot select class scope');
  }
  if (name === 'SourceEvidence') {
    const s = fixtures.protocol_entities.source_records.find(source => source.source_id === v.source_id && source.resource_version === v.source_version);
    if (!s) { fail('evidence source/version/file mismatch'); return errors; }
    if (v.file_id !== s.file_id) fail('evidence source/version/file mismatch');
    if (v.location.kind === 'text') {
      const l = v.location;
      if (l.start === null || l.end === null || l.end <= l.start || l.sheet !== null || l.cell !== null || l.page !== null) fail('invalid text evidence location');
      if (s.original_text?.slice(l.start, l.end) !== v.quote || v.content_hash !== textHash(s.original_text)) fail('evidence quote/hash must match saved source');
    } else if (v.location.kind === 'cell' && (!v.location.sheet || !v.location.cell || v.file_id === null)) fail('cell evidence requires file/sheet/cell');
    else if (v.location.kind === 'page' && (v.location.page === null || v.file_id === null)) fail('page evidence requires file/page');
  }
  if (name === 'NoticeCandidate') {
    if (v.deadline.kind === 'unknown' && !v.missing_fields.includes('deadline')) fail('unknown deadline requires missing field');
    if (v.title === null && !v.missing_fields.includes('title')) fail('missing title not declared');
    if (v.audience_text === null && !v.missing_fields.includes('audience')) fail('missing audience not declared');
    if (!v.requirements.length && !v.missing_fields.includes('requirements')) fail('missing requirements not declared');
    if (!v.evidence.length) fail('notice candidate requires source evidence');
  }
  if (['ExtractionResult', 'NoticeExtractorOutput'].includes(name)) {
    if (v.status === 'failed' ? v.error === null || v.candidate !== null : v.error !== null || v.candidate === null) fail('extraction status/candidate/error contradiction');
    if (v.mode !== 'demo') fail('fixture extractor cannot claim live');
    if (v.candidate && v.candidate.evidence.some(e => e.source_id !== v.source_id || e.source_version !== v.source_version)) fail('extraction evidence version mismatch');
    if (v.status === 'ready' && v.candidate?.missing_fields.length) fail('ready extraction still has missing fields');
    if (name === 'ExtractionResult') {
      if ((v.status === 'converted') !== (v.task_id !== null)) fail('converted extraction must reference task');
      if ((v.corrected_by === null) !== (v.correction_reason === null)) fail('correction requires actor and reason');
    }
  }
  if (name === 'NoticeExtractorInput') {
    const expectedHash = v.source.original_text === null ? fixtures.entities.file.content_hash : textHash(v.source.original_text);
    if (v.source_hash !== expectedHash || v.source.context?.class_id !== v.authorized_class_id || (v.source.original_text === null && v.source.file_id !== fixtures.entities.file.file_id)) fail('extractor input must bind saved source and trusted class');
  }
  if (name === 'ImportRow') {
    const matched = ['ready', 'imported'].includes(v.status);
    if (matched && (v.matched_user_id === null || v.match_basis !== 'verified_identity_link' || v.issues.length)) fail('ready import row requires verified identity without issues');
    if (v.match_basis === 'unresolved' && v.matched_user_id !== null) fail('unresolved import cannot grant identity');
    if (v.match_basis === 'verified_identity_link' && !fixtures.protocol_truth.verified_identity_links.some(l => l.student_number === v.student_number && l.user_id === v.matched_user_id)) fail('import identity must match verified stable link, not name');
  }
  if (name === 'MembershipImport') {
    if (new Set(v.rows.map(r => r.row_number)).size !== v.rows.length) fail('duplicate import row');
    const ids = v.rows.filter(r => r.status === 'imported').map(r => r.matched_user_id);
    if (!same([...ids].sort(), [...v.imported_user_ids].sort()) || new Set(ids).size !== ids.length) fail('imported identities disagree with selected rows');
    if (v.status === 'confirmed' ? !v.confirmed_by || !v.confirmed_at || !ids.length : v.confirmed_by !== null || v.confirmed_at !== null || ids.length) fail('import confirmation state contradiction');
    if ((v.status === 'failed') !== (v.error !== null)) fail('import failure requires error');
  }
  if (name === 'Profile') {
    if (v.facts.some(f => f.user_id !== v.user_id || f.class_id !== v.class_id || !v.visible_fields.includes(f.field))) fail('profile facts exceed user/class/field scope');
    if (new Set(v.facts.map(f => f.field)).size !== v.facts.length) fail('profile contains multiple current field values');
  }
  if (name === 'ProfileFact') {
    if (v.fact_version === 1 ? v.supersedes_fact_id !== null || v.correction_reason !== null : v.supersedes_fact_id === null || v.correction_reason === null || v.fact_id === v.supersedes_fact_id) fail('profile correction must preserve distinct previous fact');
  }
  if (name === 'ProfileProvenance' && !same(v, fixtures.protocol_truth.approved_provenance)) fail('profile source must match approved submission version and review');
  if (name === 'Statistics') {
    if (v.submitted_students + v.not_submitted_students !== v.total_students || v.approved_students + v.needs_revision_students + v.pending_review_students + v.review_not_required_students !== v.submitted_students) fail('snapshot statistics partition mismatch');
  }
  if (name === 'StatisticsSnapshot') {
    if (new Set(v.members.map(m => m.user_id)).size !== v.members.length) fail('snapshot duplicate member');
    const counts = { total_students: v.members.length, submitted_students: v.members.filter(m => m.effective_submission_id !== null).length, not_submitted_students: v.members.filter(m => m.effective_submission_id === null).length };
    for (const [state, field] of Object.entries({ approved: 'approved_students', needs_revision: 'needs_revision_students', pending: 'pending_review_students', not_required: 'review_not_required_students' })) counts[field] = v.members.filter(m => m.review_status === state).length;
    if (Object.entries(counts).some(([k, count]) => v.statistics[k] !== count)) fail('snapshot counts disagree with immutable member facts');
  }
  if (name === 'SnapshotMember' && ((v.effective_submission_id === null) !== (v.review_status === null))) fail('snapshot member submission/review mismatch');
  if (name === 'Notification' && ((v.read_status === 'read') !== (v.read_at !== null))) fail('notification read state contradiction');
  if (name === 'Report') {
    if ((v.status === 'ready') !== (v.artifact_id !== null) || (v.status === 'failed') !== (v.error !== null)) fail('report status/artifact/error contradiction');
    if (v.snapshot_id !== fixtures.entities.statistics.snapshot_id || v.task_id !== fixtures.entities.task.task_id || v.as_of !== fixtures.entities.statistics.as_of) fail('report must bind immutable task snapshot');
  }
  if (name === 'Artifact') {
    if (v.status === 'ready') {
      if (!v.file_id || !v.content_hash || !v.size || v.download_path !== `/v1/artifacts/${v.artifact_id}/content` || v.error) fail('ready artifact requires saved file and authorized download route');
    } else if (v.file_id !== null || v.content_hash !== null || v.size !== null || v.download_path !== null) fail('unready artifact cannot advertise download');
    if ((v.status === 'failed') !== (v.error !== null)) fail('artifact failure requires error');
    if (v.report_id !== fixtures.protocol_entities.report.report_id || v.snapshot_id !== fixtures.protocol_entities.report.snapshot_id) fail('artifact report/snapshot reference mismatch');
    if (v.mode !== 'demo') fail('fixture artifact cannot claim live');
  }
  if (name === 'ActionConfirmation' && ((v.status === 'consumed') !== (v.consumed_by !== null))) fail('consumed confirmation requires operation');
  if (name === 'ActionProposal') {
    if (v.binding_digest !== digest(v.binding) || v.binding.parameters_hash !== digest(v.intent.parameters) || v.binding.action !== v.intent.action || v.binding.target_id !== v.intent.target_id) fail('proposal binding digest or intent mismatch');
    const p = v.intent.parameters, b = v.binding;
    for (const k of ['requirement_version', 'draft_id', 'draft_version', 'resource_version', 'expected_effective_submission_id']) if (Object.hasOwn(p, k) && p[k] !== b[k]) fail(`proposal binding ${k} mismatch`);
    if (v.intent.action === 'submit_materials' && (b.actor_id !== fixtures.protocol_truth.private_owner || b.recipient_scope_digest !== fixtures.entities.task.audience.recipient_scope_digest || !same(b.files, [{ file_id: fixtures.entities.file.file_id, content_hash: fixtures.entities.file.content_hash }]))) fail('proposal must bind trusted file manifest and recipients');
    if (v.status === 'consumed' ? !v.receipt || v.confirmation?.status !== 'consumed' : v.receipt !== null) fail('proposal consumption state contradiction');
    if (['confirmed', 'consumed'].includes(v.status) && !v.confirmation) fail('confirmed proposal requires confirmation');
    if (v.confirmation && (v.confirmation.binding_digest !== v.binding_digest || v.confirmation.proposal_id !== v.proposal_id || v.confirmation.proposal_version !== v.resource_version)) fail('confirmation must bind exact proposal');
  }
  if (name === 'Run') {
    const kinds = { extract_notice: ['extraction'], check_materials: ['check'], generate_report: ['report'], coordinate_conversation: ['message', 'proposal'] };
    if (v.status === 'succeeded' && (!v.result_ref || !kinds[v.action]?.includes(v.result_ref.kind) || v.error !== null)) fail('successful Run requires result kind matching action');
    if (v.status !== 'succeeded' && v.result_ref !== null) fail('unfinished Run cannot advertise final result');
    if (v.status === 'failed' && v.error === null) fail('failed Run requires actual error');
    if (['succeeded', 'failed', 'cancelled'].includes(v.status) && (v.poll_after_seconds !== null || v.cancellable)) fail('terminal Run cannot poll or cancel');
    if (v.check_id !== null && (v.action !== 'check_materials' || v.result_ref?.id !== v.check_id)) fail('check Run reference mismatch');
  }
  if (name === 'ResultCard') {
    errors.push(...namedSemantics('ReceiptReference', v.reference, path + '.reference'));
    const allowed = { task: ['open'], check: ['open', 'retry'], confirmation: ['open', 'confirm'], receipt: ['open'], recovery: ['open', 'lookup', 'retry', 'cancel'], artifact: ['open', 'download'] };
    if (v.allowed_actions.some(a => !allowed[v.kind].includes(a))) fail('card action does not match kind');
    if (v.allowed_actions.includes('download') && v.state !== 'ready') fail('card cannot download unready artifact');
  }
  if (name === 'ModelOutput') {
    if (['resume', 'retry', 'cancel'].includes(v.intent) && v.steps.length) fail('model control intent cannot contain executable steps');
    if (v.steps.some(s => s.target_id !== v.target_id)) fail('model steps must bind selected target');
    if (v.missing_fields.length && v.steps.length) fail('model cannot execute with missing fields');
  }
  if (name === 'ModelInput') {
    if (v.available_actions.some(action => !spec['x-workflow-run-map'].find(m => m.action === action)?.registry_enabled)) fail('model input cannot enable disabled workflow');
    if (v.current_object_id !== null && !v.objects.some(o => o.id === v.current_object_id)) fail('selected model object must be in authorized context');
  }
  return errors;
}

const validate = createValidator(spec, { semanticChecks: namedSemantics });

const schemaKeywords = new Set(['$ref', 'type', 'description', 'title', 'enum', 'const', 'default', 'examples', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items', 'properties', 'required', 'additionalProperties', 'oneOf', 'anyOf', 'allOf']);
function auditSchema(schema, path) {
  check(objectValue(schema), `${path}: schema must be an object`);
  if (!objectValue(schema)) return;
  for (const key of Object.keys(schema)) check(schemaKeywords.has(key), `${path}: unsupported validator keyword ${key}; extend validator before using it`);
  check(Boolean(schema.$ref || schema.type || schema.oneOf || schema.anyOf || schema.allOf || Object.hasOwn(schema, 'const')), `${path}: unconstrained/placeholder schema`);
  if (schema.$ref) resolve(schema.$ref);
  if (schema.pattern) new RegExp(schema.pattern, 'u');
  if (schema.format) check(['date-time', 'binary'].includes(schema.format), `${path}: unvalidated format ${schema.format}`);
  if (schema.type === 'object') {
    check(objectValue(schema.properties), `${path}: object needs properties`);
    check(schema.additionalProperties === false, `${path}: explicit closed object required`);
    for (const key of schema.required ?? []) check(Object.hasOwn(schema.properties, key), `${path}: required key ${key} is undefined`);
  }
  if (schema.type === 'array') check(Boolean(schema.items), `${path}: array needs items`);
  for (const [key, child] of Object.entries(schema.properties ?? {})) auditSchema(child, `${path}.${key}`);
  if (schema.items) auditSchema(schema.items, `${path}[]`);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) schema[keyword]?.forEach((child, i) => auditSchema(child, `${path}.${keyword}[${i}]`));
}
function walkReferences(node) {
  if (Array.isArray(node)) node.forEach(walkReferences);
  else if (objectValue(node)) {
    if (node.$ref) resolve(node.$ref);
    Object.values(node).forEach(walkReferences);
  }
}

check(spec.openapi === '3.1.0', 'OpenAPI 3.1.0 is required');
check(fixtures.mode === 'demo', 'Fixtures must be explicitly demo');
check(spec['x-scope']?.included?.length > 0 && spec['x-scope']?.excluded?.length > 0, 'Explicit scope boundaries are required');
walkReferences(spec);
for (const [name, schema] of Object.entries(spec.components.schemas)) auditSchema(schema, name);

const operations = new Map();
for (const [path, methods] of Object.entries(spec.paths)) for (const [method, operation] of Object.entries(methods)) {
  const label = `${method.toUpperCase()} ${path}`;
  check(['get', 'post', 'patch', 'delete', 'put'].includes(method), `${label}: unsupported method`);
  check(Boolean(operation.operationId) && !operations.has(operation.operationId), `${label}: missing/duplicate operationId`);
  operations.set(operation.operationId, { path, method, operation });
  check(operation.security?.some(item => Object.hasOwn(item, 'sessionBearer')), `${label}: missing session security`);
  const protocol = operation['x-protocol'];
  check(protocol && ['authentication', 'state_rule', 'idempotency', 'lookup_target', 'recovery'].every(k => typeof protocol[k] === 'string' && protocol[k].length > 0) && Array.isArray(protocol.version_fields) && objectValue(protocol.errors), `${label}: missing per-endpoint protocol`);
  check(['self', 'owner', 'source', 'artifact', 'class_admin', 'self_or_authorized_object'].includes(operation['x-access']), `${label}: missing access scope`);
  if (operation['x-idempotency-required']) check(operation['x-operation-action'] === 'bound_action' || spec.components.schemas.OperationAction.enum.includes(operation['x-operation-action']), `${label}: missing operation lookup action`);
  const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  for (const name of pathNames) check(operation.parameters.some(p => p.in === 'path' && p.name === name && p.required), `${label}: path parameter ${name} not defined/required`);
  for (const parameter of operation.parameters) {
    check(Boolean(parameter.schema), `${label}: ${parameter.name} needs schema`);
    check(parameter.in !== 'path' || pathNames.includes(parameter.name), `${label}: extraneous path parameter`);
    auditSchema(parameter.schema, `${label}.${parameter.name}`);
  }
  if (operation['x-idempotency-required']) check(operation.parameters.some(p => p.name === 'Idempotency-Key' && p.required), `${label}: formal write needs Idempotency-Key`);
  for (const media of Object.values(operation.requestBody?.content ?? {})) auditSchema(media.schema, `${label}.request`);
  check(Object.keys(operation.responses).some(code => /^2\d\d$/.test(code)), `${label}: missing success response`);
  check(operation.responses['401'] && operation.responses['403'] && operation.responses['404'], `${label}: missing auth/object errors`);
  for (const [status, raw] of Object.entries(operation.responses)) {
    const response = deref(raw);
    check(Boolean(response.description), `${label}.${status}: missing response description`);
    check(Object.keys(response.content ?? {}).length > 0, `${label}.${status}: missing response schema`);
    for (const media of Object.values(response.content ?? {})) auditSchema(media.schema, `${label}.${status}`);
  }
}

const errorStatus = { AUTH_REQUIRED: [401], FORBIDDEN: [403], NOT_FOUND: [404], REQUIREMENT_VERSION_CONFLICT: [409], RESOURCE_VERSION_CONFLICT: [409], TASK_WITHDRAWN: [409], IDEMPOTENCY_KEY_REUSED: [409], FILE_TOO_LARGE: [413], FILE_TYPE_UNSUPPORTED: [415], VALIDATION_FAILED: [400, 422], DEADLINE_PASSED: [422], DEADLINE_UNKNOWN: [422], ACTION_CONFIRMATION_REQUIRED: [422], RATE_LIMITED: [429], SERVICE_UNAVAILABLE: [503], CAPABILITY_UNAVAILABLE: [422, 503], RUN_NOT_CANCELLABLE: [409], RUN_NOT_RETRYABLE: [409], RUN_NOT_WAITING_INPUT: [409] };
errorStatus.ACTION_CONFIRMATION_REQUIRED = [409, 422];
function protocolErrors(c, op) {
  const errors = [], fail = message => errors.push(`protocol: ${message}`);
  const name = op.operationId, truth = fixtures.protocol_truth, saved = fixtures.protocol_entities;
  const input = c.request.body, params = c.request.path_parameters, data = c.response.body?.data;
  const success = c.response.status < 300;
  if (['self', 'owner', 'source', 'artifact', 'class_admin'].includes(op['x-access']) && !['createSource', 'getSource', 'extractSource', 'createTask', 'patchTask', 'publishTask', 'changeRequirements', 'withdrawTask', 'listTaskSubmissions', 'reviewSubmission', 'getTaskStatistics'].includes(name) && typeof c.protocol_actor !== 'string') fail('protocol fixture requires trusted actor');
  if (c.protocol_actor !== undefined) {
    const actor = truth.actors.find(a => a.id === c.protocol_actor);
    let allowed = actor?.active === true;
    if (['class_admin', 'artifact'].includes(op['x-access'])) allowed &&= ['teacher', 'class_admin'].includes(actor?.role) && actor.class_id === truth.class_id;
    if (op['x-access'] === 'owner') allowed &&= actor.id === truth.private_owner;
    if (op['x-access'] === 'source') {
      if (name === 'createSource') {
        allowed &&= input?.scope === 'private' || (['teacher', 'class_admin'].includes(actor?.role) && (input.class_id ?? actor.class_id) === actor.class_id);
      } else {
        const extraction = saved.extraction_records.find(item => item.extraction_id === params.extraction_id);
        const sourceId = params.source_id ?? extraction?.source_id;
        const sourceAccess = truth.source_access.find(item => item.source_id === sourceId);
        allowed &&= Boolean(sourceAccess) && (sourceAccess.scope === 'private'
          ? actor.id === sourceAccess.owner_id
          : ['teacher', 'class_admin'].includes(actor?.role) && actor.class_id === sourceAccess.class_id);
      }
    }
    if (params.class_id) allowed &&= params.class_id === actor?.class_id;
    if (input?.class_id) allowed &&= input.class_id === actor?.class_id;
    if (!allowed && ![403, 404].includes(c.response.status)) fail('unauthorized success must be rejected');
    if (!allowed && (data !== undefined || !same(c.response.body?.error?.details, {}))) fail('denied access must not disclose object');
    if (success) {
      if (name === 'selectActiveClass' && (data.user_id !== actor.id || data.active_class_id !== input.class_id || !data.memberships.some(m => m.class_id === input.class_id && m.role === data.active_role && m.membership_status === 'active'))) fail('active class requires current trusted membership');
      if (name === 'getMyProfile' && (data.user_id !== actor.id || data.writable_fields.length)) fail('profile must be read-only for current student');
      if (name === 'listMyProfileHistory' && data.items.some(f => f.user_id !== actor.id)) fail('profile history owner mismatch');
      if (['getNotification', 'readNotification', 'listNotifications'].includes(name) && (data.items ?? [data]).some(n => n.recipient_user_id !== actor.id)) fail('notification recipient mismatch');
      if (name === 'createSource' && data.context && (data.context.recorded_by !== actor.id || data.context.class_id !== (input.scope === 'private' ? null : input.class_id ?? actor.class_id))) fail('source context must derive from current trusted actor');
      if (name === 'patchExtraction' && data.corrected_by !== actor.id) fail('extraction correction actor must match current authorized actor');
    }
  }
  if (c.replay_scenario) {
    const r = truth.replay;
    if (!success || !same(data?.receipt, r.receipt) || c.protocol_actor !== r.actor_id || c.request.headers['Idempotency-Key'] !== r.key) fail('successful replay must return original receipt before new preconditions');
  }
  if (!success) return errors;
  if (name === 'getSource') {
    const source = saved.source_records.find(item => item.source_id === params.source_id);
    if (!source || data.source_id !== params.source_id || (data.context && !same(data.context, source.context))) fail('source response must match trusted saved source context');
  }
  if (name === 'getExtraction' && data.extraction_id !== params.extraction_id) fail('extraction requested object mismatch');
  if (name === 'getProfileFact' && (data.fact_id !== params.fact_id || data.user_id !== params.student_id || data.class_id !== params.class_id)) fail('profile fact must match immutable requested version');
  if (name === 'patchExtraction' && (data.resource_version !== input.resource_version + 1 || !same(data.candidate, input.candidate) || data.correction_reason !== input.reason)) fail('extraction correction must increase version and preserve reason');
  if (name === 'convertExtraction') {
    const extraction = saved.extraction_records.find(item => item.extraction_id === params.extraction_id);
    const sourceAccess = truth.source_access.find(item => item.source_id === extraction?.source_id);
    if (!extraction || input.resource_version !== extraction.resource_version || extraction.status !== 'ready' || data.status !== 'draft'
      || sourceAccess?.scope !== 'class' || input.task.class_id !== sourceAccess.class_id) fail('conversion requires ready class candidate and creates draft only');
    if (!extraction || !input.task.source_ids.includes(extraction.source_id)) fail('conversion must retain extraction source link');
    if (input.task.source_ids.some(sourceId => !truth.source_access.some(source => source.source_id === sourceId && source.scope === 'class' && source.class_id === input.task.class_id))) fail('conversion source scope must match task class');
    if (!same(data.source_ids, input.task.source_ids)) fail('conversion task response source_ids mismatch');
    if (data.audience.class_id !== input.task.class_id || data.audience.recipient_count !== input.task.recipient_user_ids.length
      || ['title', 'description', 'requirements', 'deadline', 'policy'].some(field => !same(data[field], input.task[field]))) fail('conversion task response must preserve complete task request');
  }
  if (name === 'confirmMembershipImport') {
    const rows = saved.roster.rows.filter(r => input.selected_row_numbers.includes(r.row_number));
    if (input.resource_version !== saved.roster.resource_version || rows.length !== input.selected_row_numbers.length || rows.some(r => r.status !== 'ready')) fail('import confirmation can only select current ready rows');
    if (!input.allow_partial && rows.length !== saved.roster.rows.length) fail('partial import requires explicit allow_partial');
    if (data.resource_version !== input.resource_version + 1 || !same([...data.imported_user_ids].sort(), rows.map(r => r.matched_user_id).sort())) fail('import confirmation effect mismatch');
  }
  if (['confirmProfile', 'correctProfile'].includes(name)) {
    // Correction has no request.field. Resolve the immutable original fact
    // selected by the path and expected_fact_id under the same student/class.
    const originalFact = name === 'correctProfile' ? saved.profile_fact_records.find(record =>
      record.fact_id === params.fact_id && record.fact_id === input.expected_fact_id
      && record.user_id === params.student_id && record.class_id === params.class_id) : null;
    const field = name === 'confirmProfile' ? input.field : originalFact?.field;
    if (data.user_id !== params.student_id || data.class_id !== params.class_id || data.value !== input.value || !same(data.provenance, input.provenance)) fail('profile write must bind student/class/value/provenance');
    if (data.field !== field) fail('profile response field must match requested field or trusted original fact');
    if (['student_number', 'display_name'].includes(field) && !truth.identity_verifications.some(record =>
      record.verification_id === input.identity_verification_ref && record.verified === true && record.user_id === params.student_id
      && record.class_id === params.class_id && record.field === field && record.value === input.value)) fail('identity field requires trusted verified record bound to student/class/field/value');
    if (name === 'correctProfile' && (!originalFact || input.expected_fact_version !== originalFact.fact_version || data.fact_id === originalFact.fact_id
      || data.fact_version !== input.expected_fact_version + 1 || data.supersedes_fact_id !== originalFact.fact_id || data.correction_reason !== input.reason)) fail('profile correction must append history version');
  }
  if (name === 'readNotification' && (data.read_status !== 'read' || data.resource_version !== input.resource_version + 1 || data.notification_id !== params.notification_id)) fail('read only updates notification version');
  if (name === 'generateReport' && (input.snapshot_id !== fixtures.entities.statistics.snapshot_id || params.task_id !== fixtures.entities.statistics.task_id || data.snapshot_id !== input.snapshot_id || data.action !== 'generate_report')) fail('report request must use snapshot belonging to task');
  if (name === 'downloadArtifact' && saved.artifact.status !== 'ready') fail('download requires ready artifact');
  if (name === 'sendMessage' && (data.action !== 'coordinate_conversation' || input.resource_version !== saved.conversation.resource_version)) fail('message must bind conversation version and coordinator Run');
  if (name === 'listMessages' && data.items.some(m => m.conversation_id !== params.conversation_id)) fail('message conversation mismatch');
  if (name === 'confirmProposal' && (input.resource_version !== saved.proposal.resource_version || input.binding_digest !== saved.proposal.binding_digest || data.proposal_id !== params.proposal_id || data.proposal_version !== input.resource_version || data.binding_digest !== input.binding_digest)) fail('confirmation must bind exact proposal version and digest');
  if (name === 'consumeProposal') {
    if (input.resource_version !== saved.proposal.resource_version || input.confirmation_id !== saved.confirmation.confirmation_id || c.request.headers['Idempotency-Key'] !== saved.proposal.binding.idempotency_key || params.proposal_id !== saved.proposal.proposal_id) fail('confirmation consume actor/version/key/id binding mismatch');
    if (!same(data.receipt, truth.original_receipt)) fail('consume must return original real receipt');
  }
  return errors;
}
function semanticErrors(fixture, operation) {
  const errors = [], data = fixture.response.body?.data;
  const fail = message => errors.push(`semantic: ${message}`);
  errors.push(...protocolErrors(fixture, operation));
  const actor = fixture.trusted_fixture_context?.authenticated_user_id;
  if (actor !== undefined && !fixtures.isolation_truth.principals.includes(actor)) fail('unknown trusted fixture identity');
  if (operation.operationId === 'getMe' && fixture.response.status === 200 && actor !== data.user_id) fail('same display name must not merge distinct authenticated user_id');
  if (operation.operationId === 'getDraft') {
    const owner = fixtures.isolation_truth.draft_owners.find(item => item.draft_id === fixture.request.path_parameters.draft_id)?.owner_id;
    if (!actor || !owner) fail('draft isolation fixture requires trusted actor and owner');
    else if (owner !== actor) {
      if (![403, 404].includes(fixture.response.status)) fail('same-name cross-account draft access must be rejected');
      else if (data !== undefined || !equal(fixture.response.body.error.details, {})) fail('forbidden response must not disclose private draft data');
    } else if (fixture.response.status === 200 && data.draft_id !== fixture.request.path_parameters.draft_id) fail('draft response must match authorized requested object');
  }
  if (fixture.response.status >= 400) {
    const code = fixture.response.body?.error?.code;
    if (!errorStatus[code]?.includes(fixture.response.status)) fail(`error code ${code} does not match HTTP ${fixture.response.status}`);
    return errors;
  }
  if (['downloadFile', 'downloadArtifact'].includes(operation.operationId)) return errors;
  if (fixture.response.body?.meta?.mode !== 'demo') fail('fixtures must not claim live operation');
  if (data?.items && typeof data.has_more === 'boolean' && data.has_more !== (data.next_cursor !== null)) fail('pagination cursor and has_more disagree');
  const tasks = operation.operationId === 'listMyTasks' ? data.items : (data?.task_id && data?.policy ? [data] : []);
  for (const task of tasks) {
    const state = task.student_state;
    if (['listMyTasks', 'getTask'].includes(operation.operationId) && state === null) fail('student task query requires own state');
    if (state) {
      if (state.submission_status === 'none' && (state.effective_submission_id !== null || state.review_status !== null)) fail('no submission must have null effective submission and review');
      if (state.submission_status === 'submitted' && (state.effective_submission_id === null || state.review_status === null)) fail('submitted must reference effective submission and its review');
      if (state.confirmation_status === 'confirmed' && (state.confirmed_at === null || state.confirmed_requirement_version === null)) fail('confirmation requires actual receipt/version');
      if (state.read_status === 'unread' && state.read_at !== null) fail('unread cannot have read_at');
      if (task.deadline.kind === 'unknown' && state.allowed_actions.includes('submit')) fail('unknown deadline cannot allow submission');
      if (task.status === 'withdrawn' && state.allowed_actions.includes('submit')) fail('withdrawn task cannot allow submission');
      // Only reject factual contradictions. Requirement changes may legitimately
      // request reconfirmation even while an older effective submission exists.
      const label = state.display_status;
      if (task.status === 'withdrawn' && label !== 'withdrawn') fail('withdrawn task must display withdrawn');
      if (task.status === 'archived' && label !== 'archived') fail('archived task must display archived');
      if (label === 'withdrawn' && task.status !== 'withdrawn') fail('withdrawn display needs withdrawn task');
      if (label === 'archived' && task.status !== 'archived') fail('archived display needs archived task');
      if (label === 'unread' && state.read_status !== 'unread') fail('unread display needs unread relation');
      if (label === 'awaiting_confirmation' && (!task.policy.requires_confirmation || state.confirmation_status !== 'pending')) fail('awaiting confirmation display needs required pending confirmation');
      if (label === 'awaiting_submission' && (!task.policy.requires_submission || state.submission_status !== 'none')) fail('awaiting submission display needs required missing submission');
      const reviewLabels = { submitted_pending_review: 'pending', needs_revision: 'needs_revision', approved: 'approved' };
      if (Object.hasOwn(reviewLabels, label) && (state.submission_status !== 'submitted' || state.effective_submission_id === null || state.review_status !== reviewLabels[label])) fail(`${label} display requires effective submission and matching review state`);
      if (label === 'completed' && ((task.policy.requires_confirmation && state.confirmation_status !== 'confirmed') || (task.policy.requires_submission && state.submission_status !== 'submitted') || (task.policy.requires_review && state.review_status !== 'approved'))) fail('completed display cannot have required confirmation/submission/review outstanding');
    }
  }
  if (operation.operationId === 'getCheck') {
    const draft = fixtures.entities.draft;
    if (data.submission_draft_id !== draft.draft_id || data.draft_version !== draft.draft_version || data.requirement_version !== draft.requirement_version) fail('check must bind exact draft_id and versions');
  }
  if (operation.operationId === 'patchDraft') {
    if (data.draft_version !== fixture.request.body.draft_version + 1) fail('draft edit must increase version');
    if (data.current_check_id !== null) fail('draft edit must invalidate previous check');
  }
  if (operation.operationId === 'submitMaterials') {
    const input = fixture.request.body;
    const savedDraft = [fixtures.entities.draft, fixtures.entities.revision_draft].find(item => item.draft_id === input.draft_id);
    if (data.draft_id !== input.draft_id || data.draft_version !== input.draft_version || data.requirement_version !== input.requirement_version) fail('receipt versions must match submitted draft');
    if (data.effective_submission_id !== data.submission_id) fail('new receipt must identify committed effective version');
    if (!savedDraft || !equal(data.file_ids, savedDraft.file_ids)) fail('submission files must come from saved draft');
    if (input.expected_effective_submission_id !== null) {
      if (input.expected_effective_submission_id !== fixtures.entities.submission.submission_id || savedDraft.revision_of_submission_id !== input.expected_effective_submission_id) fail('revision must bind seen effective submission and revision draft');
      if (data.submission_version !== fixtures.entities.submission.submission_version + 1 || data.submission_id === input.expected_effective_submission_id || data.review_status !== 'pending') fail('revision must create new submission version for new review');
    }
  }
  if (operation.operationId === 'lookupOperation') {
    if (data.status === 'not_found' && (data.outcome !== 'unknown' || data.next_action !== 'lookup_same_operation')) fail('not_found is not proof of no business effect');
    if (data.status === 'failed' && data.outcome === 'unknown' && data.next_action !== 'lookup_same_operation') fail('failed with unknown business effect must reconcile');
  }
  if (operation.operationId === 'retryRun') {
    if (data.run_id === fixture.request.path_parameters.run_id || data.retry_of !== fixture.request.path_parameters.run_id) fail('retry must create a new run linked to original');
  }
  if (operation.operationId === 'getRun' || operation.operationId === 'retryRun' || operation.operationId === 'cancelRun' || operation.operationId === 'supplyRunInputs') {
    if (data.status === 'failed' && data.error === null) fail('failed Run requires actual error');
    if (['succeeded', 'failed', 'cancelled'].includes(data.status) && data.poll_after_seconds !== null) fail('terminal Run must stop polling');
    if (data.status === 'waiting_input' && !data.input_fields.length) fail('waiting_input requires declared input fields');
  }
  if (operation.operationId === 'getTaskStatistics') {
    if (data.submitted_students + data.not_submitted_students !== data.total_students) fail('submitted + missing must equal unique audience');
    if (data.approved_students + data.needs_revision_students + data.pending_review_students + data.review_not_required_students !== data.submitted_students) fail('review partitions must equal unique submitted students');
  }
  if (operation.operationId === 'createSource' || operation.operationId === 'getSource') {
    if (data.original_text === null && data.file_id === null) fail('source requires original text or saved file');
  }
  if (operation.operationId === 'uploadFile' && data.state !== 'saved') fail('successful upload response must confirm saved file');
  return errors;
}

function validateCase(fixture) {
  const errors = [];
  const operation = spec.paths[fixture.path]?.[fixture.method.toLowerCase()];
  if (!operation) return ['unknown endpoint'];
  const groups = { path: fixture.request.path_parameters, query: fixture.request.query, header: fixture.request.headers };
  for (const [location, values] of Object.entries(groups)) {
    for (const parameter of operation.parameters.filter(p => p.in === location)) {
      const key = Object.keys(values).find(k => location === 'header' ? k.toLowerCase() === parameter.name.toLowerCase() : k === parameter.name);
      if (key === undefined) { if (parameter.required) errors.push(`missing required ${location} ${parameter.name}`); }
      else errors.push(...validate(parameter.schema, values[key], `request.${location}.${key}`));
    }
    for (const name of Object.keys(values)) {
      const allowed = operation.parameters.some(p => p.in === location && (location === 'header' ? p.name.toLowerCase() === name.toLowerCase() : p.name === name));
      if (!allowed) errors.push(`unexpected ${location} parameter ${name}`);
    }
  }
  if (operation.requestBody) {
    if (!Object.hasOwn(fixture.request, 'body')) errors.push('missing request body');
    else errors.push(...validate(Object.values(operation.requestBody.content)[0].schema, fixture.request.body, 'request.body'));
  } else if (Object.hasOwn(fixture.request, 'body')) errors.push('unexpected request body');
  const response = operation.responses[String(fixture.response.status)];
  if (!response) errors.push('undeclared response status');
  else {
    const media = deref(response).content[fixture.response.media_type];
    if (!media) errors.push('undeclared response media type');
    else errors.push(...validate(media.schema, fixture.response.body, 'response.body'));
  }
  // Run cross-object assertions only once structural validation has succeeded.
  if (!errors.length) errors.push(...semanticErrors(fixture, operation));
  return errors;
}

const schemaOfEntity = { identity: 'Identity', identity_same_name: 'Identity', task: 'Task', source: 'Source', file: 'File', draft: 'Draft', other_student_draft: 'Draft', revision_draft: 'Draft', submission: 'Submission', check: 'CheckResult', run: 'Run', statistics: 'Statistics' };
for (const name of Object.keys(schemaOfEntity)) check(Object.hasOwn(fixtures.entities, name), `Missing required entity ${name}`);
for (const [name, value] of Object.entries(fixtures.entities)) {
  check(Boolean(schemaOfEntity[name]), `Unmapped entity ${name}`);
  failures.push(...validate({ $ref: `#/components/schemas/${schemaOfEntity[name]}` }, value, `entities.${name}`));
}
check(fixtures.entities.identity.display_name === fixtures.entities.identity_same_name.display_name, 'Required two students must share exactly the same display_name');
check(fixtures.entities.identity.user_id !== fixtures.entities.identity_same_name.user_id, 'Same-name students must have distinct stable user_id');
check(new Set(fixtures.isolation_truth.principals).size === 2 && fixtures.isolation_truth.principals.includes(fixtures.entities.identity.user_id) && fixtures.isolation_truth.principals.includes(fixtures.entities.identity_same_name.user_id), 'Isolation truth must declare both distinct principals');
check(fixtures.isolation_truth.draft_owners.find(item => item.draft_id === fixtures.entities.draft.draft_id)?.owner_id === fixtures.entities.identity.user_id, 'First student draft owner mismatch');
check(fixtures.isolation_truth.draft_owners.find(item => item.draft_id === fixtures.entities.other_student_draft.draft_id)?.owner_id === fixtures.entities.identity_same_name.user_id, 'Second student draft owner mismatch');
check(fixtures.entities.draft.draft_id !== fixtures.entities.other_student_draft.draft_id, 'Same-name students must not share a private draft');
check(equal([fixtures.entities.statistics.total_students, fixtures.entities.statistics.submitted_students, fixtures.entities.statistics.approved_students, fixtures.entities.statistics.needs_revision_students, fixtures.entities.statistics.not_submitted_students], [30, 24, 22, 2, 6]), 'Required 30/24/22/2/6 statistics sample changed or missing');
const protocolEntitySchemas = { extraction: 'ExtractionResult', roster: 'MembershipImport', fact: 'ProfileFact', correctedFact: 'ProfileFact', profile: 'Profile', snapshot: 'StatisticsSnapshot', notification: 'Notification', report: 'Report', artifact: 'Artifact', conversation: 'Conversation', proposal: 'ActionProposal', confirmation: 'ActionConfirmation', card: 'ResultCard', sourceWithContext: 'Source' };
for (const [key, schema] of [['source_records', 'Source'], ['extraction_records', 'ExtractionResult']]) {
  check(Array.isArray(fixtures.protocol_entities[key]) && fixtures.protocol_entities[key].length >= 2, `Missing trusted ${key}`);
  for (const record of fixtures.protocol_entities[key] ?? []) failures.push(...validate({ $ref: `#/components/schemas/${schema}` }, record, `protocol_entities.${key}`));
}
check(Array.isArray(fixtures.protocol_truth.source_access) && new Set(fixtures.protocol_truth.source_access.map(record => record.source_id)).size === fixtures.protocol_truth.source_access.length, 'Trusted source access records must be present and unique');
for (const source of fixtures.protocol_entities.source_records ?? []) {
  const access = fixtures.protocol_truth.source_access.find(record => record.source_id === source.source_id);
  check(Boolean(access) && access.scope === source.context.scope && access.class_id === source.context.class_id && access.owner_id === source.context.recorded_by, 'Saved source context must agree with independent source access truth');
}
check(Array.isArray(fixtures.protocol_truth.identity_verifications) && new Set(fixtures.protocol_truth.identity_verifications.map(record => record.verification_id)).size === fixtures.protocol_truth.identity_verifications.length, 'Trusted identity verification records must be present and unique');
for (const [name, schema] of Object.entries(protocolEntitySchemas)) {
  check(Object.hasOwn(fixtures.protocol_entities ?? {}, name), `Missing protocol entity ${name}`);
  failures.push(...validate({ $ref: `#/components/schemas/${schema}` }, fixtures.protocol_entities?.[name], `protocol_entities.${name}`));
}
check(Array.isArray(fixtures.protocol_entities.profile_fact_records) && fixtures.protocol_entities.profile_fact_records.length >= 2, 'Missing trusted original profile fact records');
for (const record of fixtures.protocol_entities.profile_fact_records ?? []) failures.push(...validate({ $ref: '#/components/schemas/ProfileFact' }, record, 'protocol_entities.profile_fact_records'));
check(new Set(fixtures.protocol_entities.profile_fact_records.map(record => record.fact_id)).size === fixtures.protocol_entities.profile_fact_records.length, 'Trusted original profile fact IDs must be unique');
const requiredNewOperations = ['selectActiveClass', 'getExtraction', 'patchExtraction', 'convertExtraction', 'createMembershipImport', 'getMembershipImport', 'confirmMembershipImport', 'getMyProfile', 'getProfile', 'confirmProfile', 'correctProfile', 'listMyProfileHistory', 'listStatisticsSnapshots', 'getStatisticsSnapshot', 'listNotifications', 'getNotification', 'readNotification', 'generateReport', 'getReport', 'getArtifact', 'downloadArtifact', 'createConversation', 'listMessages', 'sendMessage', 'getProposal', 'confirmProposal', 'consumeProposal'];
requiredNewOperations.push('getProfileFact');
for (const name of ['getMe', 'getCapabilities', 'listMyTasks', 'getTask', 'readTask', 'confirmTask', 'createSource', 'getSource', 'extractSource', 'uploadFile', 'getFile', 'downloadFile', 'createDraft', 'getDraft', 'patchDraft', 'startCheck', 'getCheck', 'submitMaterials', 'listMySubmissions', 'lookupOperation', 'listMyRuns', 'getRun', 'supplyRunInputs', 'retryRun', 'cancelRun', 'createTask', 'patchTask', 'publishTask', 'changeRequirements', 'withdrawTask', 'listTaskSubmissions', 'reviewSubmission', 'getTaskStatistics']) check(operations.has(name), `Missing DEV-001 operation ${name}`);
for (const name of requiredNewOperations) {
  check(operations.has(name), `Missing required protocol operation ${name}`);
  for (const [suffix, expected] of [['_forbidden', 'valid'], ['_reject_unauthorized_success', 'invalid']]) check(fixtures.cases.some(c => c.name === name + suffix && c.expected === expected), `Missing required acceptance case ${name + suffix}`);
  const positive = fixtures.cases.find(c => c.name === name);
  check(typeof positive?.protocol_actor === 'string', `${name}: missing trusted protocol fixture actor`);
}
const requiredInternal = { extractor_input: 'valid', extractor_output: 'valid', extractor_failure: 'valid', model_input: 'valid', model_output: 'valid', confirmation_consumed: 'valid', reject_extractor_success_error: 'invalid', reject_extractor_failure_no_error: 'invalid', reject_model_self_authorization: 'invalid', reject_model_disabled_action: 'invalid', reject_model_control_with_steps: 'invalid', reject_consumed_without_operation: 'invalid' };
for (const kind of ['task', 'check', 'confirmation', 'receipt', 'recovery', 'artifact']) requiredInternal[`card_${kind}`] = 'valid';
for (const [name, expected] of Object.entries(requiredInternal)) check(fixtures.internal_cases?.some(c => c.name === name && c.expected === expected), `Missing required internal case ${name}`);
const internalNames = new Set();
for (const c of fixtures.internal_cases ?? []) {
  check(!internalNames.has(c.name), `Duplicate internal fixture ${c.name}`); internalNames.add(c.name);
  check(['valid', 'invalid'].includes(c.expected), `Unknown internal expectation ${c.name}`);
  const errors = validate({ $ref: `#/components/schemas/${c.schema}` }, c.value, `internal.${c.name}`);
  if (c.expected === 'valid') failures.push(...errors);
  else check(errors.length > 0, `${c.name}: invalid internal fixture incorrectly accepted`);
}
const workflowNames = ['query_tasks', 'explain_notice', 'confirm_notice', 'check_materials', 'submit_materials', 'prepare_revision', 'recover_run', 'cancel_run', 'activity_registration', 'manage_memory', 'manage_goal', 'campus_search', 'generate_artifact', 'publish_task', 'review_submission', 'archive_records', 'class_report', 'group_presentation', 'arrange_people_venue'];
const mapping = spec['x-workflow-run-map'];
check(Array.isArray(mapping) && mapping.length === workflowNames.length && new Set(mapping.map(m => m.action)).size === workflowNames.length && workflowNames.every(n => mapping.some(m => m.action === n)), 'Complete workflow-to-Run action mapping required');
for (const row of mapping ?? []) {
  check(row.run_action === null || spec.components.schemas.Run.properties.action.enum.includes(row.run_action), `Unsupported Run mapping ${row.action}`);
  check(row.enabled_by_contract === false, `Contract must not enable runtime workflow ${row.action}`);
  for (const op of row.operation_ids) check(operations.has(op), `Unknown mapped operation ${op}`);
  check(row.run_action === ({ explain_notice: 'extract_notice', check_materials: 'check_materials', class_report: 'generate_report' }[row.action] ?? null), `Wrong workflow Run mapping ${row.action}`);
}
check(same(Object.keys(spec['x-receipt-routes'] ?? {}).sort(), [...spec.components.schemas.ReceiptReference.properties.kind.enum].sort()), 'Receipt kind routing must be exhaustive');
check(fixtures.protocol_truth?.replay?.confirmation_consumed && fixtures.protocol_truth?.replay?.confirmation_expired && fixtures.protocol_truth?.replay?.current_task_status === 'withdrawn' && fixtures.protocol_truth?.replay?.current_requirement_version === 2, 'Replay truth must exercise consumed/expired/withdrawn/revised preconditions');
const caseNames = new Set();
let positive = 0, negative = 0;
for (const fixture of fixtures.cases) {
  check(!caseNames.has(fixture.name), `Duplicate fixture name ${fixture.name}`); caseNames.add(fixture.name);
  check(['valid', 'invalid'].includes(fixture.expected), `Unknown fixture expectation: ${fixture.name}`);
  const errors = validateCase(fixture);
  if (fixture.expected === 'valid') { positive++; for (const error of errors) failures.push(`${fixture.name}: ${error}`); }
  else {
    negative++;
    check(errors.length > 0, `${fixture.name}: invalid fixture was incorrectly accepted`);
    if (fixture.required_error) check(errors.some(error => error.includes(fixture.required_error)), `${fixture.name}: rejected for unrelated reason; expected ${fixture.required_error}`);
  }
}
for (const [name, { path, method }] of operations) {
  check(fixtures.cases.some(c => c.name === name && c.expected === 'valid' && c.method.toLowerCase() === method && c.path === path && c.response.status < 300), `${name}: missing named successful endpoint fixture`);
}
const requiredCases = {
  same_name_second_identity: 'valid', same_name_second_student_own_draft: 'valid', forbidden_other_student_draft: 'valid',
  reject_same_name_cross_account_success: 'invalid', reject_same_name_identity_merge: 'invalid',
  create_revision_draft: 'valid', submit_revision_success: 'valid', submit_effective_version_conflict: 'valid',
  submit_requirement_conflict: 'valid', run_ai_failed_keeps_draft: 'valid', operation_processing: 'valid', operation_succeeded: 'valid', operation_failed_no_effect: 'valid',
  reject_external_absent: 'invalid', reject_not_found_as_safe_retry: 'invalid', reject_missing_expected_effective_submission: 'invalid', reject_client_owner: 'invalid', reject_missing_idempotency_key: 'invalid', reject_zero_draft_version: 'invalid', reject_duplicate_submission_counts: 'invalid',
  reject_deadline_without_timezone: 'invalid', reject_mismatched_draft_reference: 'invalid', reject_review_without_submission: 'invalid', reject_stale_check_after_edit: 'invalid', reject_retry_reusing_run_id: 'invalid', reject_upload_claiming_submission: 'invalid', reject_internal_storage_path: 'invalid', reject_other_student_query: 'invalid', reject_invalid_calendar_date: 'invalid', reject_upload_pending_as_saved: 'invalid',
  reject_approved_display_without_submission: 'invalid', reject_completed_display_with_pending_submission: 'invalid', reject_withdrawn_display_for_published_task: 'invalid',
};
for (const [name, expected] of Object.entries(requiredCases)) check(fixtures.cases.some(c => c.name === name && c.expected === expected), `Missing required acceptance case ${name}`);
for (const name of ['reject_client_role', 'reject_untrusted_active_class', 'reject_source_other_class', 'reject_extraction_evidence_version', 'reject_extraction_invented_quote', 'reject_ready_with_missing_fields', 'reject_import_conflict_row', 'reject_import_implicit_partial', 'reject_import_name_identity', 'reject_import_same_name_collapse', 'reject_profile_other_student', 'reject_profile_field_scope', 'reject_profile_unreviewed_source', 'reject_profile_overwrite_history', 'reject_snapshot_duplicate_member', 'reject_snapshot_current_counts', 'reject_report_wrong_snapshot', 'reject_fake_download_url', 'reject_unready_download', 'reject_other_conversation', 'reject_card_unsupported_reference', 'reject_message_read_as_task_confirmation', 'reject_other_recipient', 'reject_proposal_tampered_binding', 'reject_confirmation_wrong_digest', 'reject_confirmation_other_key', 'reject_confirmation_other_actor', 'reject_confirmation_other_id', 'reject_replay_invented_receipt', 'reject_run_result_wrong_kind']) check(fixtures.cases.some(c => c.name === name && c.expected === 'invalid'), `Missing required acceptance case ${name}`);
for (const name of ['source_class_context', 'source_private_context', 'extraction_unknown_deadline', 'extraction_failed_keeps_source', 'replay_success_after_changes', 'confirmation_expired_conflict', 'import_version_conflict', 'profile_version_conflict', 'report_capability_unavailable', 'run_extraction_succeeded', 'run_report_succeeded']) check(fixtures.cases.some(c => c.name === name && c.expected === 'valid'), `Missing required acceptance case ${name}`);
for (const name of ['source_private_owner_get', 'source_private_teacher_forbidden', 'source_private_same_name_forbidden', 'source_private_owner_extract', 'extraction_private_owner_get', 'extraction_private_owner_patch', 'extraction_missing_requirements', 'profile_identity_verified', 'profile_identity_correction_verified', 'proposal_publish_resource_version_bound']) check(fixtures.cases.some(c => c.name === name && c.expected === 'valid'), `Missing required acceptance case ${name}`);
for (const name of ['reject_private_source_teacher_success', 'reject_private_source_same_name_success', 'reject_private_extraction_teacher_success', 'reject_source_response_scope_spoof', 'reject_empty_requirements_unmarked', 'reject_conversion_missing_source_link', 'reject_conversion_response_source_ids', 'reject_conversion_response_content', 'reject_conversion_private_source', 'reject_identity_reference_invented', 'reject_identity_reference_other_student', 'reject_identity_reference_unverified', 'reject_identity_reference_wrong_value', 'reject_identity_reference_wrong_field', 'reject_identity_reference_wrong_class', 'reject_profile_response_field', 'reject_profile_correction_response_field', 'reject_correction_identity_reference', 'reject_proposal_resource_version_binding']) check(fixtures.cases.some(c => c.name === name && c.expected === 'invalid' && typeof c.required_error === 'string'), `Missing required acceptance case ${name}`);
for (const name of ['reject_correction_client_field', 'reject_correction_identity_field_swap', 'reject_correction_unknown_original_fact']) check(fixtures.cases.some(c => c.name === name && c.expected === 'invalid' && typeof c.required_error === 'string'), `Missing required acceptance case ${name}`);
const forbiddenCase = fixtures.cases.find(c => c.name === 'forbidden_other_student_draft');
check(forbiddenCase?.response.status === 403 && forbiddenCase?.response.body.error?.code === 'FORBIDDEN', 'Required explicit 403/FORBIDDEN example missing');
// Independent tiny validator controls prevent a no-op checker from passing the suite.
assert.ok(validate({ type: 'integer', minimum: 1 }, 0).length);
assert.ok(validate({ type: 'string', format: 'date-time' }, '2026-02-30T00:00:00Z').length);
assert.ok(validate({ type: 'object', properties: {}, required: [], additionalProperties: false }, { owner_id: 'someone' }).length);
assert.equal(validate({ type: 'integer', minimum: 1 }, 1).length, 0);
assert.equal(validate({ type: 'string', format: 'date-time' }, '2026-10-15T20:00:00+08:00').length, 0);

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`FAIL: ${failures.length} contract/fixture errors.`);
  process.exitCode = 1;
} else {
  console.log(`PASS: OpenAPI local structure + refs; ${operations.size} endpoint fixtures; ${Object.keys(spec.components.schemas).length} schemas; ${positive} positive and ${negative} negative cases; same-name identity isolation/403/revision/versions/unknown-operation/30-24-22-2-6 statistics invariants.`);
  console.log(`PASS: ${internalNames.size} internal fixtures; source evidence/import/profile/snapshot/conversation/confirmation/replay/report/card invariants; exhaustive workflow mapping.`);
  console.log('Scope: schema/fixture checks only. No HTTP service, authentication, persistence, real multipart stream or AI integration tested.');
}

return { passed: failures.length === 0, failures: [...failures] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1])) runFixtureSuite();
