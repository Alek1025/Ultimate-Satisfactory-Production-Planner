/** Property-tag traps from rewrite-notes §1, on synthetic property streams. */
import { describe, expect, it } from 'vitest';
import { BinaryReader } from '../src/save/binary-reader';
import { newStats, readPropertyList, type PropertyContext, type StructValue, type TextValue } from '../src/save/properties';
import { ByteWriter } from './helpers/save-bytes';

const ctx = (): PropertyContext => ({ completeTags: true, doubleVectors: true, stats: newStats() });
const read = (w: ByteWriter, c = ctx()) => {
  const bytes = w.str('None').done();
  const r = new BinaryReader(bytes);
  const bag = readPropertyList(r, c);
  expect(r.remaining).toBe(0);
  return bag;
};

describe('complete-type-name property tags', () => {
  it('decodes a top-level bool from the tag flags (0x10), ints, arrays and native vectors', () => {
    const w = new ByteWriter();
    w.tag('bTrue', (x) => x.node('BoolProperty'), 0, 0x10);
    w.tag('bFalse', (x) => x.node('BoolProperty'), 0, 0);
    w.tag('Count', (x) => x.node('IntProperty'), 4).i32(42);
    w.tag('List', (x) => x.node('ArrayProperty', [['IntProperty', []]]), 12).i32(2).i32(7).i32(9);
    w.tag('Loc', (x) => x.node('StructProperty', [['Vector', [['/Script/CoreUObject', []]]]]), 24, 0x08).f64(1).f64(2).f64(3);
    const c = ctx();
    const bag = read(w, c);
    expect(bag.bTrue!.value).toBe(true);
    expect(bag.bFalse!.value).toBe(false);
    expect(bag.Count!.value).toBe(42);
    expect(bag.List!.value).toEqual([7, 9]);
    expect(bag.Loc!.value).toEqual({ struct: 'Vector', value: { x: 1, y: 2, z: 3 } });
    expect(c.stats.rawProperties).toBe(0);
  });

  it('reads a bool inside a container as a byte', () => {
    const w = new ByteWriter();
    w.tag('Flags', (x) => x.node('ArrayProperty', [['BoolProperty', []]]), 7).i32(3).u8(1).u8(0).u8(1);
    expect(read(w).Flags!.value).toEqual([true, false, true]);
  });

  it('reads enum-backed bytes as FStrings and plain bytes as numbers', () => {
    const w = new ByteWriter();
    const purity = 'EResourcePurity::RP_Pure';
    w.tag('Purity', (x) => x.node('ByteProperty', [['EResourcePurity', [['/Script/FactoryGame', []]]]]), 4 + purity.length + 1).str(purity);
    w.tag('Plain', (x) => x.node('ByteProperty', [['None', []]]), 1).u8(7);
    const bag = read(w);
    expect(bag.Purity!.value).toBe(purity);
    expect(bag.Plain!.value).toBe(7);
  });

  it('tells raw byte arrays from enum-string byte arrays by size − 4 === count', () => {
    const w = new ByteWriter();
    w.tag('Raw', (x) => x.node('ArrayProperty', [['ByteProperty', []]]), 4 + 3).i32(3).u8(1).u8(2).u8(3);
    w.tag('Enums', (x) => x.node('ArrayProperty', [['ByteProperty', []]]), 4 + 2 * (4 + 2)).i32(2).str('A').str('B');
    const bag = read(w);
    expect(bag.Raw!.value).toEqual([1, 2, 3]);
    expect(bag.Enums!.value).toEqual(['A', 'B']);
  });

  it('skips removed entries that sets and maps write first', () => {
    const w = new ByteWriter();
    w.tag('Set', (x) => x.node('SetProperty', [['IntProperty', []]]), 4 + 4 + 4 + 8).i32(1).i32(99).i32(2).i32(5).i32(6);
    w.tag('Map', (x) => x.node('MapProperty', [['StrProperty', []], ['IntProperty', []]]), 4 + 6 + 4 + 6 + 4)
      .i32(1).str('x').i32(1).str('k').i32(3);
    const bag = read(w);
    expect(bag.Set!.value).toEqual([5, 6]);
    expect(bag.Map!.value).toEqual({ entries: [['k', 3]] });
  });

  it('decodes native structs inside containers without a size', () => {
    const w = new ByteWriter();
    w.tag('Points', (x) => x.node('ArrayProperty', [['StructProperty', [['Vector', [['/Script/CoreUObject', []]]]]]]), 4 + 48)
      .i32(2).f64(1).f64(2).f64(3).f64(4).f64(5).f64(6);
    expect((read(w).Points!.value as StructValue[]).map((s) => s.value)).toEqual([{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }]);
  });

  it('decodes tagged structs as nested property bags', () => {
    const w = new ByteWriter();
    const inner = new ByteWriter().tag('Amount', (x) => x.node('IntProperty'), 4).i32(12).str('None').done();
    w.tag('Cost', (x) => x.node('StructProperty', [['ItemAmount', [['/Script/FactoryGame', []]]]]), inner.length).bytes(inner);
    const v = read(w).Cost!.value as StructValue;
    expect(v.struct).toBe('ItemAmount');
    expect((v.value as Record<string, { value: unknown }>).Amount!.value).toBe(12);
  });

  it('reads object refs (two FStrings) and soft refs (plus a sub-path)', () => {
    const w = new ByteWriter();
    w.tag('Ref', (x) => x.node('ObjectProperty'), 4 + 2 + 4 + 2).str('L').str('P');
    w.tag('Soft', (x) => x.node('SoftObjectProperty'), 18).str('L').str('P').str('S');
    const bag = read(w);
    expect(bag.Ref!.value).toEqual({ levelName: 'L', pathName: 'P' });
    expect(bag.Soft!.value).toEqual({ levelName: 'L', pathName: 'P', subPath: 'S' });
  });

  it('reads FText history types −1, 0, 11 and a format (1) with arguments', () => {
    const t = (build: (x: ByteWriter) => void) => { const x = new ByteWriter(); build(x); return x.done(); };
    const none = t((x) => x.u32(0).i8(-1).i32(1).str('culture invariant'));
    const base = t((x) => x.u32(0).i8(0).str('NS').str('KEY').str('Hello'));
    const table = t((x) => x.u32(0).i8(11).str('Table').str('Row'));
    const fmt = t((x) => x.u32(0).i8(1).bytes(base).i32(1).str('n').i8(0).i64(5));
    const w = new ByteWriter();
    for (const [name, b] of [['A', none], ['B', base], ['C', table], ['D', fmt]] as const) w.tag(name, (x) => x.node('TextProperty'), b.length).bytes(b);
    const bag = read(w);
    expect((bag.A!.value as TextValue).text).toBe('culture invariant');
    expect((bag.B!.value as TextValue)).toMatchObject({ historyType: 0, namespace: 'NS', key: 'KEY', text: 'Hello' });
    expect((bag.C!.value as TextValue)).toMatchObject({ historyType: 11, tableId: 'Table', text: 'Row' });
    expect((bag.D!.value as TextValue)).toMatchObject({ historyType: 1, text: 'Hello', args: [{ name: 'n', value: 5n }] });
  });

  it('keys repeated static-array properties by index', () => {
    const w = new ByteWriter();
    w.tag('Slot', (x) => x.node('IntProperty'), 4).i32(1);
    w.str('Slot').node('IntProperty').i32(4).u8(0x01).i32(2).i32(9);
    const bag = read(w);
    expect(bag.Slot!.value).toBe(1);
    expect(bag['Slot#2']).toMatchObject({ index: 2, value: 9 });
  });

  it('keeps undecodable values as raw bytes and stays aligned', () => {
    const w = new ByteWriter();
    w.tag('Weird', (x) => x.node('MysteryProperty'), 3).u8(1).u8(2).u8(3);
    w.tag('After', (x) => x.node('IntProperty'), 4).i32(5);
    const c = ctx();
    const bag = read(w, c);
    expect((bag.Weird!.value as { raw: Uint8Array }).raw).toEqual(new Uint8Array([1, 2, 3]));
    expect(bag.After!.value).toBe(5);
    expect(c.stats.rawProperties).toBe(1);
    expect([...c.stats.rawReasons.keys()][0]).toMatch(/MysteryProperty/);
  });

  it('keeps a value raw when its decoded size disagrees with the tag', () => {
    const w = new ByteWriter();
    w.tag('Short', (x) => x.node('IntProperty'), 6).i32(1).u8(0).u8(0);
    w.tag('After', (x) => x.node('IntProperty'), 4).i32(5);
    const bag = read(w);
    expect((bag.Short!.value as { raw: Uint8Array; reason: string }).reason).toMatch(/read 4 of 6/);
    expect(bag.After!.value).toBe(5);
  });

  it('reads a known native struct that a third-party editor wrote without the native flag', () => {
    const w = new ByteWriter();
    w.tag('Color', (x) => x.node('StructProperty', [['LinearColor', [['/Script/CoreUObject', []]]]]), 16, 0).f32(0.5).f32(0.25).f32(1).f32(1);
    const c = ctx();
    expect((read(w, c).Color!.value as StructValue).value).toEqual({ r: 0.5, g: 0.25, b: 1, a: 1 });
    expect(c.stats.rawProperties).toBe(0);
  });

  it('refuses legacy (pre-UE5.4) property tags', () => {
    expect(() => readPropertyList(new BinaryReader(new Uint8Array(8)), { ...ctx(), completeTags: false })).toThrow(/Legacy/);
  });
});
