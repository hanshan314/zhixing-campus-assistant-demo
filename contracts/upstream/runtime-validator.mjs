// Shared dependency-free schema subset and object-local invariants. No fixture or I/O dependency.
import { createHash } from 'node:crypto';

const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stable = value => Array.isArray(value) ? value.map(stable) : objectValue(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const same = (a, b) => equal(stable(a), stable(b));
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const textHash = text => createHash('sha256').update(text, 'utf8').digest('hex');


// The caller must load these records through an authorized business service.
// Structural validity alone never proves that a related record exists or is authorized.
export function validateReportBinding(report, snapshot, path = '$') {
  if (!objectValue(report) || !objectValue(snapshot)
    || !['task_id', 'snapshot_id', 'as_of'].every(key => typeof snapshot[key] === 'string' && snapshot[key].length))
    return [`${path}: trusted task snapshot required`];
  return ['task_id', 'snapshot_id', 'as_of'].every(key => report[key] === snapshot[key])
    ? [] : [`${path}: report must bind immutable task snapshot`];
}

export function validateArtifactBinding(artifact, report, path = '$') {
  if (!objectValue(artifact) || !objectValue(report)
    || !['report_id', 'snapshot_id'].every(key => typeof report[key] === 'string' && report[key].length))
    return [`${path}: trusted report required`];
  return artifact.report_id === report.report_id && artifact.snapshot_id === report.snapshot_id
    ? [] : [`${path}: artifact report/snapshot reference mismatch`];
}

export function createValidator(spec, { semanticChecks } = {}) {
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

function intrinsicSemantics(name, v, path) {
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
    const l = v.location;
    if (l.kind === 'text' && (l.start === null || l.end === null || l.end <= l.start || l.sheet !== null || l.cell !== null || l.page !== null)) fail('invalid text evidence location');
    else if (l.kind === 'cell' && (!l.sheet || !l.cell || v.file_id === null)) fail('cell evidence requires file/sheet/cell');
    else if (l.kind === 'page' && (l.page === null || v.file_id === null)) fail('page evidence requires file/page');
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
    if (v.candidate && v.candidate.evidence.some(e => e.source_id !== v.source_id || e.source_version !== v.source_version)) fail('extraction evidence version mismatch');
    if (v.status === 'ready' && v.candidate?.missing_fields.length) fail('ready extraction still has missing fields');
    if (name === 'ExtractionResult') {
      if ((v.status === 'converted') !== (v.task_id !== null)) fail('converted extraction must reference task');
      if ((v.corrected_by === null) !== (v.correction_reason === null)) fail('correction requires actor and reason');
    }
  }
  if (name === 'NoticeExtractorInput') {
    if (v.source.context?.class_id !== v.authorized_class_id || (v.source.original_text !== null && v.source_hash !== textHash(v.source.original_text))) fail('extractor input must bind source text and class context');
  }
  if (name === 'ImportRow') {
    const matched = ['ready', 'imported'].includes(v.status);
    if (matched && (v.matched_user_id === null || v.match_basis !== 'verified_identity_link' || v.issues.length)) fail('ready import row requires verified identity without issues');
    if (v.match_basis === 'unresolved' && v.matched_user_id !== null) fail('unresolved import cannot grant identity');
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
  }
  if (name === 'Artifact') {
    if (v.status === 'ready') {
      if (!v.file_id || !v.content_hash || !v.size || v.download_path !== `/v1/artifacts/${v.artifact_id}/content` || v.error) fail('ready artifact requires saved file and authorized download route');
    } else if (v.file_id !== null || v.content_hash !== null || v.size !== null || v.download_path !== null) fail('unready artifact cannot advertise download');
    if ((v.status === 'failed') !== (v.error !== null)) fail('artifact failure requires error');
  }
  if (name === 'ActionConfirmation' && ((v.status === 'consumed') !== (v.consumed_by !== null))) fail('consumed confirmation requires operation');
  if (name === 'ActionProposal') {
    if (v.binding_digest !== digest(v.binding) || v.binding.parameters_hash !== digest(v.intent.parameters) || v.binding.action !== v.intent.action || v.binding.target_id !== v.intent.target_id) fail('proposal binding digest or intent mismatch');
    const p = v.intent.parameters, b = v.binding;
    for (const k of ['requirement_version', 'draft_id', 'draft_version', 'resource_version', 'expected_effective_submission_id']) if (Object.hasOwn(p, k) && p[k] !== b[k]) fail(`proposal binding ${k} mismatch`);
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
    errors.push(...intrinsicSemantics('ReceiptReference', v.reference, path + '.reference'));
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

function namedSemantics(name, value, path) {
  return [...intrinsicSemantics(name, value, path), ...(semanticChecks?.(name, value, path) ?? [])];
}

function validate(schema, value, path = '$') {
  const errors = [];
  const fail = message => errors.push(`${path}: ${message}`);
  if (schema === true) return errors;
  if (schema === false) return [`${path}: prohibited value`];
  if (schema.$ref) {
    errors.push(...validate(resolve(schema.$ref), value, path));
    if (!errors.length) errors.push(...namedSemantics(schema.$ref.split('/').at(-1), value, path));
    const siblings = { ...schema }; delete siblings.$ref;
    if (Object.keys(siblings).length) errors.push(...validate(siblings, value, path));
    return errors;
  }
  if (schema.allOf) for (const child of schema.allOf) errors.push(...validate(child, value, path));
  for (const combinator of ['anyOf', 'oneOf']) if (schema[combinator]) {
    const branches = schema[combinator].map(child => validate(child, value, path));
    const matches = branches.filter(branch => branch.length === 0).length;
    if ((combinator === 'anyOf' && matches === 0) || (combinator === 'oneOf' && matches !== 1)) {
      fail(`${combinator} matched ${matches} alternatives`);
      if (!matches) errors.push(...branches.flat().slice(0, 30));
    }
  }
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) fail(`expected constant ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(item => equal(item, value))) fail(`value is outside enum`);
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  const matchesType = type => ({ null: value === null, object: objectValue(value), array: Array.isArray(value), string: typeof value === 'string', boolean: typeof value === 'boolean', number: typeof value === 'number' && Number.isFinite(value), integer: Number.isSafeInteger(value) })[type];
  if (types.length && !types.some(matchesType)) { fail(`expected ${types.join('|')}`); return errors; }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail(`does not match pattern ${schema.pattern}`);
    if (schema.format === 'date-time') {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
      let valid = Boolean(match) && Number.isFinite(Date.parse(value));
      if (match) {
        const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        valid &&= month >= 1 && month <= 12 && day >= 1 && day <= days && Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 && (!match[8] || (Number(match[8]) <= 23 && Number(match[9]) <= 59));
      }
      if (!valid) fail('invalid date-time with timezone');
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`maxItems ${schema.maxItems}`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('duplicate array items');
    if (schema.items) value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)));
  }
  if (objectValue(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing required property ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], child, `${path}.${key}`));
      else if (schema.additionalProperties === false) fail(`unexpected property ${key}`);
      else if (objectValue(schema.additionalProperties)) errors.push(...validate(schema.additionalProperties, child, `${path}.${key}`));
    }
  }
  return errors;
}

return validate;
}
