// Canonical JSON and content hashes for the `.ussp` project file.
//
// Canonical form: object keys sorted by UTF-16 code unit order, no whitespace, `-0` written as `0`,
// object properties whose value is `undefined` dropped. Anything JSON can't represent exactly
// (NaN, Infinity, bigint, functions, class instances, `undefined` in arrays) is rejected rather
// than silently coerced, so two equal inputs can never hash differently and an unequal pair can
// never hash the same.
import { sha256Hex } from '../util/hash';

export { sha256Hex };

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || '$'}`);
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, out: string[], seen: Set<object>): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number ${value}`, path);
      out.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value}`, path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError('circular reference', path);
  seen.add(obj);
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(',');
      const item: unknown = obj[i];
      if (item === undefined) throw new CanonicalJsonError('undefined array item', `${path}[${i}]`);
      write(item, `${path}[${i}]`, out, seen);
    }
    out.push(']');
  } else {
    if (!isPlainObject(obj)) {
      throw new CanonicalJsonError(`unsupported object ${obj.constructor?.name ?? '?'}`, path);
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
    out.push('{');
    keys.forEach((k, i) => {
      if (i > 0) out.push(',');
      out.push(JSON.stringify(k), ':');
      write(rec[k], `${path}.${k}`, out, seen);
    });
    out.push('}');
  }
  seen.delete(obj);
}

/** Serialise `value` to canonical JSON. Throws `CanonicalJsonError` for non-JSON input. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, '', out, new Set());
  return out.join('');
}

/** SHA-256 of the canonical JSON of `value`. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Parse JSON text and return it in canonical form (useful for normalising stored text). */
export function canonicalize(text: string): string {
  return canonicalJson(JSON.parse(text));
}

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
