import { describe, expect, it } from 'vitest';
import { applyEdit, canonicalJson, hashCanonical, parsePlanEdit, ProjectError, type PlanContent } from '../../src/project';
import { EMPTY } from './support';

function shuffleKeys(v: unknown, seed: { n: number }): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    for (let i = entries.length - 1; i > 0; i--) {
      seed.n = (seed.n * 9301 + 49297) % 233280;
      const j = seed.n % (i + 1);
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, shuffleKeys(x, seed)]));
  }
  return v;
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it('gives the same hash for any key order (property)', () => {
    const doc = { z: 1, goals: { g2: { rate: 2.5, item: 'Desc_IronPlate_C' }, g1: { rate: 1 } }, sites: [{ y: 1, x: 2 }], 'é': true };
    const h = hashCanonical(doc);
    for (let n = 1; n < 50; n++) expect(hashCanonical(shuffleKeys(doc, { n }))).toBe(h);
  });

  it('normalises -0 and drops undefined properties', () => {
    expect(canonicalJson({ a: -0, b: undefined })).toBe('{"a":0}');
  });

  it.each([[NaN], [Infinity], [10n], [new Date(0)], [new Map()], [[undefined]], [() => 1]])('rejects %s', (bad) => {
    expect(() => canonicalJson({ v: bad })).toThrow();
  });

  it('rejects cycles', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });

  it('a different value always gives a different hash', () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 1.0000001 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
});

describe('plan edits', () => {
  const base: PlanContent = { worldBase: null, charter: { goals: { a: 1 } }, network: { sites: [{ id: 's1' }] } };

  it('set, insert and remove apply without mutating the input', () => {
    const frozen = structuredClone(base);
    let c = applyEdit(base, { kind: 'set', doc: 'charter', path: ['goals', 'b'], value: 2 });
    c = applyEdit(c, { kind: 'insert', doc: 'network', path: ['sites', 0], value: { id: 's0' } });
    c = applyEdit(c, { kind: 'set', doc: 'network', path: ['sites', 2], value: { id: 's2' } });
    c = applyEdit(c, { kind: 'remove', doc: 'charter', path: ['goals', 'a'] });
    c = applyEdit(c, { kind: 'setWorldBase', snapshot: 'abc' });
    expect(c).toEqual({ worldBase: 'abc', charter: { goals: { b: 2 } }, network: { sites: [{ id: 's0' }, { id: 's1' }, { id: 's2' }] } });
    expect(base).toEqual(frozen);
  });

  it('replaces a whole document with an empty path', () => {
    expect(applyEdit(EMPTY, { kind: 'set', doc: 'charter', path: [], value: { x: 1 } }).charter).toEqual({ x: 1 });
  });

  it.each([
    [{ kind: 'remove', doc: 'charter', path: ['goals', 'missing'] }],
    [{ kind: 'set', doc: 'charter', path: ['nope', 'deeper'], value: 1 }],
    [{ kind: 'set', doc: 'network', path: ['sites', 5], value: 1 }],
    [{ kind: 'insert', doc: 'charter', path: ['goals', 'x'], value: 1 }],
    [{ kind: 'set', doc: 'network', path: ['sites', 'id'], value: 1 }],
    [{ kind: 'remove', doc: 'charter', path: [] }],
    [{ kind: 'set', doc: 'charter', path: [], value: [1] }],
  ])('rejects an edit that does not apply: %j', (edit) => {
    expect(() => applyEdit(base, parsePlanEdit(edit))).toThrow(ProjectError);
  });

  it.each([
    [null],
    [{ kind: 'set', doc: 'charter', path: ['a'] }],
    [{ kind: 'set', doc: 'other', path: ['a'], value: 1 }],
    [{ kind: 'set', doc: 'charter', path: [-1], value: 1 }],
    [{ kind: 'set', doc: 'charter', path: [1.5], value: 1 }],
    [{ kind: 'set', doc: 'charter', path: ['a'], value: 1, extra: true }],
    [{ kind: 'set', doc: 'charter', path: ['a'], value: NaN }],
    [{ kind: 'setWorldBase', snapshot: 3 }],
    [{ kind: 'drop', doc: 'charter', path: [] }],
  ])('rejects malformed input: %j', (input) => {
    expect(() => parsePlanEdit(input)).toThrow(expect.objectContaining({ code: 'BAD_EDIT' }));
  });
});
