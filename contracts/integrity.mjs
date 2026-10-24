import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDirectory = dirname(fileURLToPath(import.meta.url));
const expectedFiles = ['openapi.json', 'examples.json', 'validate.mjs', 'runtime-validator.mjs'];
export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Read-only integrity check. Never refreshes files or accepts upstream drift. */
export function inspectSnapshot({ checkUpstream = true, contractsDirectory = defaultDirectory } = {}) {
  const errors = [];
  let lock;
  try { lock = readJson(resolve(contractsDirectory, 'source.lock.json')); }
  catch (error) { return { errors: [`Cannot read source.lock.json: ${error.message}`], checkedFiles: 0 }; }
  if (lock.lock_format !== 2 || lock.mode !== 'consumer_snapshot') errors.push('Unsupported snapshot lock format/mode');
  if (!Array.isArray(lock.files) || lock.files.length !== expectedFiles.length) errors.push('Lock must contain exactly the four upstream snapshot files');
  let checkedFiles = 0;
  for (const name of expectedFiles) {
    const relativePath = `upstream/${name}`;
    const entries = Array.isArray(lock.files) ? lock.files.filter(entry => entry.path === relativePath) : [];
    if (entries.length !== 1) { errors.push(`Lock must contain ${relativePath} exactly once`); continue; }
    const entry = entries[0];
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) { errors.push(`Invalid SHA-256 for ${relativePath}`); continue; }
    if (typeof lock.source_root !== 'string' || typeof entry.source_path !== 'string' || resolve(entry.source_path) !== resolve(lock.source_root, name)) {
      errors.push(`Source path does not match the declared source root for ${relativePath}`);
      continue;
    }
    try {
      if (hash(resolve(contractsDirectory, relativePath)) !== entry.sha256) errors.push(`Snapshot drift: ${relativePath}; review differences instead of editing the consumer snapshot`);
      else checkedFiles++;
    } catch (error) { errors.push(`Cannot read snapshot ${relativePath}: ${error.code ?? error.message}`); }
    if (checkUpstream) {
      try {
        if (hash(entry.source_path) !== entry.sha256) errors.push(`Upstream drift: ${name}; review schema/examples and update all consumers before refreshing the lock`);
      } catch (error) { errors.push(`Cannot verify upstream ${name}: ${error.code ?? error.message}; use --snapshot-only explicitly only when upstream is unavailable on this machine`); }
    }
  }
  try {
    const spec = readJson(resolve(contractsDirectory, 'upstream/openapi.json'));
    const fixtures = readJson(resolve(contractsDirectory, 'upstream/examples.json'));
    if (spec.info?.version !== lock.contract_version) errors.push('Contract version differs from source lock');
    if (spec.openapi !== lock.openapi_version) errors.push('OpenAPI version differs from source lock');
    if (fixtures.fixture_version !== lock.fixture_version || fixtures.fixture_version !== spec.info?.version) errors.push('Fixture version differs from contract/lock');
    if (fixtures.mode !== 'demo') errors.push('Consumer fixture set must stay explicitly demo');
  } catch (error) { errors.push(`Cannot inspect snapshot versions: ${error.message}`); }
  return { errors, checkedFiles, lock, upstreamChecked: checkUpstream };
}
