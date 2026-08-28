// Validation against the pinned hostproto-semantics bundles, plus this
// worker's one own contract (the work order). No HostProto type is restated
// in TypeScript: every object that crosses A2A is validated against the
// bundle it claims to be.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AjvModule, { type ValidateFunction } from 'ajv/dist/2020.js';
import FormatsModule from 'ajv-formats';

const Ajv2020 = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as new (opts: object) => import('ajv/dist/2020.js').default;
const addFormats = ((FormatsModule as unknown as { default?: unknown }).default ?? FormatsModule) as (ajv: unknown) => void;

const SCHEMA_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
const CONTRACT_DIR = fileURLToPath(new URL('../contracts/', import.meta.url));
const LOCK = JSON.parse(readFileSync(fileURLToPath(new URL('../hostproto-semantics.lock.json', import.meta.url)), 'utf8')) as {
  repository: string; commit: string; sha256: Record<string, string>;
};
export type JsonSchema = Record<string, unknown>;
export const pinned = { repository: LOCK.repository, commit: LOCK.commit, sha256: LOCK.sha256 };

const loaded = new Map<string, JsonSchema>();
export function bundle(name: string): JsonSchema {
  const cached = loaded.get(name); if (cached) return cached;
  const contract = name.startsWith('contract:');
  const path = contract ? `${CONTRACT_DIR}${name.slice(9)}.schema.json` : `${SCHEMA_DIR}${name}.json`;
  if (!existsSync(path)) throw new Error(`schema missing: ${contract ? path : 'run `npm run schemas` (' + name + ')'}`);
  const text = readFileSync(path, 'utf8');
  if (!contract) {
    const digest = createHash('sha256').update(text).digest('hex');
    if (digest !== LOCK.sha256[name]) throw new Error(`schema bundle ${name} does not match the pinned digest`);
  }
  const parsed = JSON.parse(text) as JsonSchema; loaded.set(name, parsed); return parsed;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();
export function validator(name: string): ValidateFunction {
  const existing = compiled.get(name); if (existing) return existing;
  const fn = ajv.compile(bundle(name)); compiled.set(name, fn); return fn;
}
export function errorsOf(name: string, value: unknown): string | null {
  const fn = validator(name);
  return fn(value) ? null : (fn.errors ?? []).map(e => `${e.instancePath || '$'} ${e.message}`).join('; ');
}
/** Throw if `value` does not satisfy the named bundle. Used on every object that enters or leaves the worker. */
export function assertValid(name: string, value: unknown): void {
  const detail = errorsOf(name, value);
  if (detail) throw new Error(`${name} violates its schema: ${detail}`);
}
