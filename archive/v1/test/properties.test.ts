import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/save/binary-reader';
import { newStats, readPropertyList } from '../src/save/properties';

/** Tiny writer for synthetic property streams. */
class W {
  bytes: number[] = [];
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.bytes.push(...b); return this; }
  u8(v: number) { this.bytes.push(v); return this; }
  f64(v: number) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.bytes.push(...b); return this; }
  str(s: string) { if (!s) return this.i32(0); this.i32(s.length + 1); for (const c of s) this.bytes.push(c.charCodeAt(0)); this.bytes.push(0); return this; }
  node(name: string, children: Array<[string, unknown[]]> = []) { this.str(name).i32(children.length); for (const [n, c] of children) this.node(n, c as never); return this; }
  tag(name: string, type: () => void, size: number, flags = 0) { this.str(name); type(); this.i32(size).u8(flags); return this; }
}

const ctx = () => ({ completeTags: true, doubleVectors: true, stats: newStats() });

describe('complete-type-name property tags', () => {
  it('decodes bool from the tag flag (0x10), ints, arrays and native vectors', () => {
    const w = new W();
    w.tag('bTrue', () => w.node('BoolProperty'), 0, 0x10);
    w.tag('bFalse', () => w.node('BoolProperty'), 0, 0);
    w.tag('Count', () => w.node('IntProperty'), 4).i32(42);
    w.tag('List', () => w.node('ArrayProperty', [['IntProperty', []]]), 12).i32(2).i32(7).i32(9);
    w.tag('Loc', () => w.node('StructProperty', [['Vector', [['/Script/CoreUObject', []]]]]), 24, 0x08).f64(1).f64(2).f64(3);
    w.str('None');
    const c = ctx();
    const bag = readPropertyList(new BinaryReader(new Uint8Array(w.bytes)), c);
    expect(bag.bTrue!.value).toBe(true);
    expect(bag.bFalse!.value).toBe(false);
    expect(bag.Count!.value).toBe(42);
    expect(bag.List!.value).toEqual([7, 9]);
    expect(bag.Loc!.value).toEqual({ struct: 'Vector', value: { x: 1, y: 2, z: 3 } });
    expect(c.stats.rawProperties).toBe(0);
  });

  it('keeps undecodable values as raw bytes and stays aligned', () => {
    const w = new W();
    w.tag('Weird', () => w.node('MysteryProperty'), 3).u8(1).u8(2).u8(3);
    w.tag('After', () => w.node('IntProperty'), 4).i32(5);
    w.str('None');
    const c = ctx();
    const bag = readPropertyList(new BinaryReader(new Uint8Array(w.bytes)), c);
    expect((bag.Weird!.value as { raw: Uint8Array }).raw).toEqual(new Uint8Array([1, 2, 3]));
    expect(bag.After!.value).toBe(5);
    expect(c.stats.rawProperties).toBe(1);
  });
});
