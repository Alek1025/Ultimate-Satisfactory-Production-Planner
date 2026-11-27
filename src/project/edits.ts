// Journal ops ("pending edits") and how they apply to a working plan.
//
// The charter and network documents are opaque JSON objects at this layer; their schemas arrive in
// M2. Edits are path-based and applied immutably (only the touched path is copied), so a cached
// working state can be shared safely.
import { canonicalJson, isJsonObject, type Json, type JsonObject } from './canonical';
import { ProjectError } from './errors';

export type PlanDoc = 'charter' | 'network';
export type JsonPath = readonly (string | number)[];

export type PlanEdit =
  /** Set an object key or array index (index === length appends). `path: []` replaces the doc. */
  | { kind: 'set'; doc: PlanDoc; path: JsonPath; value: Json }
  /** Remove an existing object key or array item. */
  | { kind: 'remove'; doc: PlanDoc; path: JsonPath }
  /** Insert into an array at an index in 0..length. */
  | { kind: 'insert'; doc: PlanDoc; path: JsonPath; value: Json }
  /** Point the plan at a different world snapshot (or none). */
  | { kind: 'setWorldBase'; snapshot: string | null };

export interface PlanContent {
  worldBase: string | null;
  charter: JsonObject;
  network: JsonObject;
}

function bad(message: string): never {
  throw new ProjectError('BAD_EDIT', message);
}

function parsePath(v: unknown): JsonPath {
  if (!Array.isArray(v)) bad('path must be an array');
  for (const seg of v) {
    if (typeof seg === 'string') continue;
    if (typeof seg === 'number' && Number.isInteger(seg) && seg >= 0) continue;
    bad(`path segment ${JSON.stringify(seg)} must be a string or a non-negative integer`);
  }
  return v as JsonPath;
}

function parseValue(v: unknown): Json {
  try {
    canonicalJson(v);
  } catch (e) {
    bad(`value is not JSON: ${(e as Error).message}`);
  }
  if (v === undefined) bad('value is required');
  return v as Json;
}

/** Validate untrusted input (CLI, IPC) as a `PlanEdit`. Unknown fields are rejected. */
export function parsePlanEdit(input: unknown): PlanEdit {
  if (!isJsonObject(input)) bad('edit must be an object');
  const o = input as Record<string, unknown>;
  const allow = (keys: string[]) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) bad(`unknown field "${k}"`);
  };
  const doc = (): PlanDoc => {
    if (o.doc !== 'charter' && o.doc !== 'network') bad('doc must be "charter" or "network"');
    return o.doc;
  };
  switch (o.kind) {
    case 'set':
    case 'insert':
      allow(['kind', 'doc', 'path', 'value']);
      if (!('value' in o)) bad('value is required');
      return { kind: o.kind, doc: doc(), path: parsePath(o.path), value: parseValue(o.value) };
    case 'remove':
      allow(['kind', 'doc', 'path']);
      return { kind: 'remove', doc: doc(), path: parsePath(o.path) };
    case 'setWorldBase':
      allow(['kind', 'snapshot']);
      if (o.snapshot !== null && typeof o.snapshot !== 'string') bad('snapshot must be a string or null');
      return { kind: 'setWorldBase', snapshot: o.snapshot };
    default:
      return bad(`unknown edit kind ${JSON.stringify(o.kind)}`);
  }
}

type Container = JsonObject | Json[];

function child(node: Json, seg: string | number, at: string): Json {
  if (Array.isArray(node)) {
    if (typeof seg !== 'number' || seg >= node.length) bad(`no array item ${String(seg)} at ${at}`);
    return node[seg] as Json;
  }
  if (isJsonObject(node)) {
    if (typeof seg !== 'string' || !Object.hasOwn(node, seg)) bad(`no key ${JSON.stringify(seg)} at ${at}`);
    return node[seg] as Json;
  }
  return bad(`cannot descend into a ${node === null ? 'null' : typeof node} at ${at}`);
}

function shallowCopy(node: Container): Container {
  return Array.isArray(node) ? node.slice() : { ...node };
}

function update(node: Json, path: JsonPath, depth: number, leaf: (parent: Container, seg: string | number, at: string) => void): Json {
  const at = '/' + path.slice(0, depth).join('/');
  const seg = path[depth]!;
  if (!Array.isArray(node) && !isJsonObject(node)) bad(`cannot descend into a ${node === null ? 'null' : typeof node} at ${at}`);
  const copy = shallowCopy(node);
  if (depth === path.length - 1) {
    leaf(copy, seg, at);
  } else {
    const next = update(child(node, seg, at), path, depth + 1, leaf);
    (copy as Record<string | number, Json>)[seg] = next;
  }
  return copy;
}

function applyToDoc(doc: JsonObject, edit: Exclude<PlanEdit, { kind: 'setWorldBase' }>): JsonObject {
  const { path } = edit;
  if (path.length === 0) {
    if (edit.kind !== 'set') bad(`cannot ${edit.kind} the document root`);
    if (!isJsonObject(edit.value)) bad('a document root must be an object');
    return edit.value;
  }
  const out = update(doc, path, 0, (parent, seg, at) => {
    if (Array.isArray(parent)) {
      if (typeof seg !== 'number') bad(`array index must be a number at ${at}`);
      if (edit.kind === 'set') {
        if (seg > parent.length) bad(`index ${seg} is past the end (${parent.length}) at ${at}`);
        parent[seg] = edit.value;
      } else if (edit.kind === 'insert') {
        if (seg > parent.length) bad(`index ${seg} is past the end (${parent.length}) at ${at}`);
        parent.splice(seg, 0, edit.value);
      } else {
        if (seg >= parent.length) bad(`no array item ${seg} at ${at}`);
        parent.splice(seg, 1);
      }
    } else {
      if (typeof seg !== 'string') bad(`object key must be a string at ${at}`);
      if (edit.kind === 'insert') bad(`insert needs an array at ${at}`);
      if (edit.kind === 'set') parent[seg] = edit.value;
      else {
        if (!Object.hasOwn(parent, seg)) bad(`no key ${JSON.stringify(seg)} at ${at}`);
        delete parent[seg];
      }
    }
  });
  return out as JsonObject;
}

/** Apply one edit, returning new content. The input is never mutated. Throws `BAD_EDIT`. */
export function applyEdit(content: PlanContent, edit: PlanEdit): PlanContent {
  if (edit.kind === 'setWorldBase') return { ...content, worldBase: edit.snapshot };
  return { ...content, [edit.doc]: applyToDoc(content[edit.doc], edit) };
}

export function applyEdits(content: PlanContent, edits: Iterable<PlanEdit>): PlanContent {
  let c = content;
  for (const e of edits) c = applyEdit(c, e);
  return c;
}
