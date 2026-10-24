import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectSnapshot, readJson } from './integrity.mjs';

const contractsDirectory = dirname(fileURLToPath(import.meta.url));

function isolatedSnapshot(run) {
  const temporaryDirectory = mkdtempSync(join(contractsDirectory, '.integrity-test-'));
  try {
    const upstreamDirectory = join(temporaryDirectory, 'source');
    const snapshotDirectory = join(temporaryDirectory, 'consumer');
    mkdirSync(upstreamDirectory);
    mkdirSync(join(snapshotDirectory, 'upstream'), { recursive: true });
    const lock = structuredClone(readJson(join(contractsDirectory, 'source.lock.json')));
    lock.source_root = upstreamDirectory;
    for (const entry of lock.files) {
      const name = basename(entry.path);
      entry.source_path = join(upstreamDirectory, name);
      for (const target of [entry.source_path, join(snapshotDirectory, entry.path)]) {
        copyFileSync(join(contractsDirectory, entry.path), target);
        chmodSync(target, 0o600);
      }
    }
    writeFileSync(join(snapshotDirectory, 'source.lock.json'), JSON.stringify(lock), 'utf8');
    run({ upstreamDirectory, snapshotDirectory });
  } finally {
    // Recursive removal is restricted to this test's verified immediate child.
    const resolved = resolve(temporaryDirectory);
    assert.equal(dirname(resolved), resolve(contractsDirectory));
    assert.ok(basename(resolved).startsWith('.integrity-test-'));
    rmSync(resolved, { recursive: true, force: true });
  }
}

test('local snapshot drift fails even when the changed JSON remains parseable', () => {
  isolatedSnapshot(({ snapshotDirectory }) => {
    assert.deepEqual(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors, []);
    appendFileSync(join(snapshotDirectory, 'upstream/openapi.json'), '\n');
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors.some(error => error.includes('Snapshot drift')));
  });
});

test('upstream drift fails without changing or refreshing the consumer lock', () => {
  isolatedSnapshot(({ upstreamDirectory, snapshotDirectory }) => {
    const originalLock = readJson(join(snapshotDirectory, 'source.lock.json'));
    appendFileSync(join(upstreamDirectory, 'examples.json'), '\n');
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors.some(error => error.includes('Upstream drift')));
    assert.deepEqual(readJson(join(snapshotDirectory, 'source.lock.json')), originalLock);
  });
});

test('missing upstream fails by default and only explicit snapshot-only skips freshness', () => {
  isolatedSnapshot(({ upstreamDirectory, snapshotDirectory }) => {
    rmSync(join(upstreamDirectory, 'validate.mjs'));
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors.some(error => error.includes('Cannot verify upstream')));
    const report = inspectSnapshot({ contractsDirectory: snapshotDirectory, checkUpstream: false });
    assert.deepEqual(report.errors, []);
    assert.equal(report.upstreamChecked, false);
  });
});

test('IF-003: four-file lock includes the runtime library and rejects its snapshot or upstream drift', () => {
  isolatedSnapshot(({ upstreamDirectory, snapshotDirectory }) => {
    const initial = inspectSnapshot({ contractsDirectory: snapshotDirectory });
    assert.equal(initial.lock.lock_format, 2);
    assert.equal(initial.checkedFiles, 4);
    assert.deepEqual(initial.errors, []);
    appendFileSync(join(upstreamDirectory, 'runtime-validator.mjs'), '\n');
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors.some(error => error.includes('Upstream drift: runtime-validator.mjs')));
    appendFileSync(join(snapshotDirectory, 'upstream/runtime-validator.mjs'), '\n');
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory, checkUpstream: false }).errors.some(error => error.includes('Snapshot drift: upstream/runtime-validator.mjs')));
  });
});

test('IF-003: missing runtime library or omitted/duplicated lock entry cannot bypass checks', () => {
  isolatedSnapshot(({ snapshotDirectory }) => {
    rmSync(join(snapshotDirectory, 'upstream/runtime-validator.mjs'));
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory, checkUpstream: false }).errors.some(error => error.includes('Cannot read snapshot upstream/runtime-validator.mjs')));
  });
  for (const duplicate of [false, true]) isolatedSnapshot(({ snapshotDirectory }) => {
    const lockPath = join(snapshotDirectory, 'source.lock.json');
    const lock = readJson(lockPath);
    const entry = lock.files.find(item => item.path === 'upstream/runtime-validator.mjs');
    lock.files = lock.files.filter(item => item.path !== entry.path);
    if (duplicate) lock.files.push(entry, entry);
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.ok(inspectSnapshot({ contractsDirectory: snapshotDirectory }).errors.some(error => error.includes('runtime-validator.mjs exactly once')));
  });
});
