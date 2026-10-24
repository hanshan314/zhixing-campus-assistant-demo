import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtures, spec, getOperation, validateRequest, validateResponse, validateSchema, validateReportBinding, validateArtifactBinding } from './runtime-validation.mjs';

const fixture = name => structuredClone(fixtures.cases.find(item => item.name === name));

test('all 61 adopted upstream operations have exactly one success fixture with matching wire shape', () => {
  const expectedIds = Object.values(spec.paths).flatMap(methods => Object.values(methods).map(operation => operation.operationId));
  assert.equal(spec.info.version, '0.2.0');
  assert.equal(expectedIds.length, 61);
  const seen = new Set();
  for (const sample of fixtures.cases) {
    let entry;
    try { entry = getOperation(sample.name); } catch { continue; }
    assert.equal(sample.path, entry.path);
    assert.equal(sample.method.toLowerCase(), entry.method);
    assert.equal(seen.has(sample.name), false, `duplicate fixture: ${sample.name}`);
    assert.deepEqual(validateRequest(sample.name, sample.request), [], sample.name);
    assert.deepEqual(validateResponse(sample.name, sample.response.status, sample.response.body, sample.response.media_type), [], sample.name);
    seen.add(sample.name);
  }
  assert.deepEqual([...seen].sort(), expectedIds.sort());
});

test('reject prior technical-draft names and missing formal idempotency key', () => {
  const submit = fixture('submitMaterials');
  delete submit.request.headers['Idempotency-Key'];
  assert.ok(validateRequest('submitMaterials', submit.request).some(error => error.includes('Idempotency-Key')));
  const lookup = fixture('lookupOperation');
  lookup.request.body = { operation_type: 'submissions.create', target_id: 'task_demo_001', idempotency_key: 'op_demo_submit_001' };
  assert.ok(validateRequest('lookupOperation', lookup.request).length > 0);
  const draft = fixture('createDraft');
  draft.request.body = { requirement_version: 1, base_submission_id: null };
  assert.ok(validateRequest('createDraft', draft.request).length > 0);
  const upload = fixture('uploadFile');
  delete upload.request.body.purpose;
  assert.ok(validateRequest('uploadFile', upload.request).length > 0);
});

test('submission requires explicit effective version and rejects identity injection', () => {
  const body = fixture('submitMaterials').request.body;
  assert.deepEqual(validateSchema('SubmissionRequest', body), []);
  assert.ok(validateSchema('SubmissionRequest', { ...body, owner_id: 'another_student' }).length > 0);
  delete body.expected_effective_submission_id;
  assert.ok(validateSchema('SubmissionRequest', body).length > 0);
});

test('parse wire query integers while rejecting undeclared filters and out-of-range values', () => {
  assert.deepEqual(validateRequest('listMyTasks', { query: { limit: '20', status: 'published' } }), []);
  assert.ok(validateRequest('listMyTasks', { query: { limit: '101' } }).length > 0);
  assert.ok(validateRequest('listMyTasks', { query: { filter: 'needs_revision' } }).length > 0);
  assert.ok(validateRequest('getTask', { pathParameters: { task_id: 'task_demo_001' }, query: { comparison_requirement_version: '1' } }).length > 0);
});

test('202 requires full Run and does not accept a small AcceptedRun substitute', () => {
  const sample = fixture('startCheck');
  assert.deepEqual(validateResponse('startCheck', 202, sample.response.body), []);
  sample.response.body.data = { run_id: 'run_demo_001', status: 'queued' };
  assert.ok(validateResponse('startCheck', 202, sample.response.body).length > 0);
});

test('not_found cannot masquerade as no effect; immutable demo snapshots are not state stores', () => {
  const sample = fixture('lookupOperation');
  sample.response.body.data.outcome = 'no_effect';
  assert.ok(validateResponse('lookupOperation', 200, sample.response.body).length > 0);
  assert.equal(Object.isFrozen(fixtures.entities.task.student_state), true);
  assert.throws(() => { fixtures.entities.task.title = 'changed'; }, TypeError);
});

test('normal transport headers are accepted but unsupported draft idempotency is not claimed', () => {
  const draft = fixture('createDraft');
  draft.request.headers = { authorization: 'Bearer DEMO_TEST_VALUE', 'content-type': 'application/json', 'user-agent': 'node' };
  assert.deepEqual(validateRequest('createDraft', draft.request), []);
  draft.request.headers['Idempotency-Key'] = 'op_demo_draft_001';
  assert.ok(validateRequest('createDraft', draft.request).length > 0);
});

test('IF-003: legitimate reports/artifacts with different task, snapshot and time pass runtime schema and wire validation', () => {
  for (const suffix of ['alpha', 'beta']) {
    const sample = fixture('getReport');
    const report = sample.response.body.data;
    Object.assign(report, { report_id: `report_${suffix}`, task_id: `task_${suffix}`, snapshot_id: `snapshot_${suffix}`, as_of: suffix === 'alpha' ? '2026-10-16T08:00:00Z' : '2026-10-17T08:00:00Z' });
    assert.deepEqual(validateSchema('Report', report), []);
    assert.deepEqual(validateResponse('getReport', 200, sample.response.body), []);
    assert.deepEqual(validateReportBinding(report, { task_id: report.task_id, snapshot_id: report.snapshot_id, as_of: report.as_of }), []);
    const artifactSample = fixture('getArtifact');
    const artifact = artifactSample.response.body.data;
    Object.assign(artifact, { artifact_id: `artifact_${suffix}`, report_id: report.report_id, snapshot_id: report.snapshot_id, download_path: `/v1/artifacts/artifact_${suffix}/content`, mode: 'live' });
    assert.deepEqual(validateSchema('Artifact', artifact), []);
    assert.deepEqual(validateResponse('getArtifact', 200, artifactSample.response.body), []);
    assert.deepEqual(validateArtifactBinding(artifact, report), []);
  }
});

test('IF-003: cross-record mismatch needs trusted context and object-local contradictions still fail', () => {
  const report = structuredClone(fixtures.protocol_entities.report);
  const snapshot = { task_id: report.task_id, snapshot_id: report.snapshot_id, as_of: report.as_of };
  for (const field of ['task_id', 'snapshot_id', 'as_of']) assert.ok(validateReportBinding({ ...report, [field]: 'different' }, snapshot).length);
  for (const missing of [undefined, null, {}]) assert.ok(validateReportBinding(report, missing).length);
  const artifact = structuredClone(fixtures.protocol_entities.artifact);
  for (const field of ['report_id', 'snapshot_id']) assert.ok(validateArtifactBinding({ ...artifact, [field]: 'different' }, report).length);
  for (const missing of [undefined, null, {}]) assert.ok(validateArtifactBinding(artifact, missing).length);
  assert.ok(validateSchema('Report', { ...report, artifact_id: null }).length);
  assert.ok(validateSchema('Report', { ...report, status: 'failed', error: null, artifact_id: null }).length);
  assert.ok(validateSchema('Artifact', { ...artifact, download_path: '/v1/artifacts/wrong/content' }).length);
  assert.ok(validateSchema('Artifact', { ...artifact, status: 'queued' }).length);
});
