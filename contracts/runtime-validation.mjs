import { inspectSnapshot, readJson } from './integrity.mjs';

const integrity = inspectSnapshot({ checkUpstream: false });
if (integrity.errors.length) throw new Error(`Contract snapshot integrity failed:\n${integrity.errors.join('\n')}`);

// Import the shared validator only after the entire snapshot has passed integrity checks.
// Fixed-fixture acceptance remains an explicit CLI check, never runtime validation.
const { createValidator } = await import('./upstream/runtime-validator.mjs');
export const { validateReportBinding, validateArtifactBinding } = await import('./upstream/runtime-validator.mjs');

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

export const spec = freezeDeep(readJson(new URL('./upstream/openapi.json', import.meta.url)));
export const fixtures = freezeDeep(readJson(new URL('./upstream/examples.json', import.meta.url)));
export const contractVersion = spec.info.version;
const upstreamValidate = createValidator(spec);
const operations = new Map();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    operations.set(operation.operationId, Object.freeze({ path, method, operation }));
  }
}

function dereference(schema) {
  if (!schema?.$ref) return schema;
  let value = spec;
  for (const token of schema.$ref.slice(2).split('/')) value = value[token.replace(/~1/g, '/').replace(/~0/g, '~')];
  return dereference(value);
}

export function getOperation(operationId) {
  const entry = operations.get(operationId);
  if (!entry) throw new Error(`Unknown operationId: ${operationId}`);
  return entry;
}

/** Returns validation errors; [] means shape-valid, not business-authorized. */
export function validateSchema(nameOrSchema, value) {
  const schema = typeof nameOrSchema === 'string' ? spec.components.schemas[nameOrSchema] : nameOrSchema;
  if (!schema) return [`Unknown schema: ${String(nameOrSchema)}`];
  return upstreamValidate(typeof nameOrSchema === 'string' ? { $ref: `#/components/schemas/${nameOrSchema}` } : schema, value);
}

const transportHeaders = new Set([
  'accept', 'accept-encoding', 'accept-language', 'authorization', 'cache-control',
  'connection', 'content-length', 'content-type', 'cookie', 'host', 'origin',
  'pragma', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via', 'dnt',
]);
const normalizedMediaType = value => value?.split(';', 1)[0].trim().toLowerCase();
function parameterValue(schema, value) {
  const resolved = dereference(schema);
  if (typeof value === 'string' && resolved?.type === 'integer' && /^-?(0|[1-9]\d*)$/.test(value)) return Number(value);
  if (typeof value === 'string' && resolved?.type === 'boolean' && ['true', 'false'].includes(value)) return value === 'true';
  return value;
}

/** body is decoded JSON/multipart metadata; this does not parse or validate file bytes. */
export function validateRequest(operationId, request = {}) {
  if (!operations.has(operationId)) return [`Unknown operationId: ${operationId}`];
  const { operation } = getOperation(operationId);
  const errors = [];
  const groups = { path: request.pathParameters ?? request.path_parameters ?? {}, query: request.query ?? {}, header: request.headers ?? {} };
  for (const [location, values] of Object.entries(groups)) {
    const parameters = operation.parameters.filter(parameter => parameter.in === location);
    for (const parameter of parameters) {
      const key = Object.keys(values).find(name => location === 'header' ? name.toLowerCase() === parameter.name.toLowerCase() : name === parameter.name);
      if (key === undefined) {
        if (parameter.required) errors.push(`request.${location}: missing ${parameter.name}`);
      } else errors.push(...upstreamValidate(parameter.schema, parameterValue(parameter.schema, values[key]), `request.${location}.${parameter.name}`));
    }
    for (const name of Object.keys(values)) {
      const declared = parameters.some(parameter => location === 'header' ? parameter.name.toLowerCase() === name.toLowerCase() : parameter.name === name);
      const transport = location === 'header' && (transportHeaders.has(name.toLowerCase()) || name.toLowerCase().startsWith('sec-'));
      if (!declared && !transport) errors.push(`request.${location}: unexpected ${name}`);
    }
  }
  if (operation.requestBody) {
    if (!Object.hasOwn(request, 'body')) errors.push('request: missing body');
    else {
      const content = operation.requestBody.content;
      const headerType = Object.entries(groups.header).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
      const mediaType = normalizedMediaType(request.mediaType ?? headerType ?? Object.keys(content)[0]);
      if (!content[mediaType]) errors.push(`request: undeclared media type ${mediaType}`);
      else errors.push(...upstreamValidate(content[mediaType].schema, request.body, 'request.body'));
    }
  } else if (Object.hasOwn(request, 'body')) errors.push('request: unexpected body');
  return errors;
}

export function validateResponse(operationId, status, body, mediaType = 'application/json') {
  if (!operations.has(operationId)) return [`Unknown operationId: ${operationId}`];
  const rawResponse = getOperation(operationId).operation.responses[String(status)];
  if (!rawResponse) return [`response: undeclared status ${status}`];
  const response = dereference(rawResponse);
  const media = response.content[normalizedMediaType(mediaType)];
  if (!media) return [`response: undeclared media type ${mediaType}`];
  return upstreamValidate(media.schema, body, 'response.body');
}
