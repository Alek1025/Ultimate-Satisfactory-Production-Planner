/**
 * Save-format traps from rewrite-notes §1, built as synthetic inputs (mostly by taking a real
 * fixture apart and putting it back together differently).
 */
import { describe, expect, it } from 'vitest';
import { BinaryReader, SaveFormatError } from '../src/save/binary-reader';
import { inflateSaveBody } from '../src/save/decompress';
import { readSave } from '../src/save/save-reader';
import { summarizeSave } from '../src/save/extract';
import { ByteWriter, concat, joinSave, splitSave, withBodyLength } from './helpers/save-bytes';
import { fixture, gameData, parsedSave, saveSummary } from './fixtures';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return e instanceof SaveFormatError ? e.code : `not a SaveFormatError: ${(e as Error).message}`; }
  return 'no error';
};

/** Offset of `needle` inside `hay` (both views), or -1. */
const offsetIn = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(Buffer.from(needle.buffer, needle.byteOffset, needle.byteLength));

describe('BinaryReader', () => {
  it('reads FStrings: 0 = empty, positive = latin1 incl. NUL, negative = UTF-16LE code units', () => {
    const b = new ByteWriter().i32(0).str('Grüße').wstr('Ωmega ✓').done();
    const r = new BinaryReader(b);
    expect(r.fstring()).toBe('');
    expect(r.fstring()).toBe('Grüße');
    expect(r.fstring()).toBe('Ωmega ✓');
    expect(r.remaining).toBe(0);
  });

  it('rejects FString lengths past the end of the data', () => {
    expect(() => new BinaryReader(new ByteWriter().i32(50).str('x').done()).fstring()).toThrow(SaveFormatError);
    expect(() => new BinaryReader(new ByteWriter().i32(-50).done()).fstring()).toThrow(/UTF-16/);
  });

  it('rejects int64 sizes outside the safe integer range', () => {
    expect(() => new BinaryReader(new ByteWriter().i64(2n ** 60n).done()).i64n()).toThrow(/safe range/);
    expect(new BinaryReader(new ByteWriter().i64(2 ** 40).done()).i64n()).toBe(2 ** 40);
  });

  it('throws corrupt SaveFormatErrors on reads past the end', () => {
    expect(codeOf(() => new BinaryReader(new Uint8Array(3)).i32())).toBe('corrupt');
  });
});

describe('compressed body chunks', () => {
  const { header, body } = splitSave(fixture('default.sav'));
  const reference = JSON.stringify(summarizeSave(readSave(fixture('default.sav')), gameData()));

  it('reads archive version 0x22222222 (compressor byte) and 0 (none), with any chunk size', () => {
    for (const archiveVersion of [0x22222222, 0]) {
      for (const chunkSize of [4096, 131072, body.length]) {
        const file = joinSave(header, body, { archiveVersion, chunkSize });
        expect(inflateSaveBody(file, header.length)).toEqual(body);
        expect(JSON.stringify(summarizeSave(readSave(file), gameData()))).toBe(reference);
      }
    }
  });

  it("checks each chunk's inflated size", () => {
    const file = joinSave(header, body, { uncompressedSizeDelta: 1 });
    expect(() => readSave(file)).toThrow(/inflated to .* expected/);
    expect(codeOf(() => readSave(file))).toBe('corrupt');
  });

  it('rejects a bad chunk tag, an unknown archive version and an unknown compressor', () => {
    const good = joinSave(header, body);
    const at = header.length;
    const patch = (offset: number, value: number, width: 1 | 4) => {
      const f = new Uint8Array(good);
      if (width === 4) new DataView(f.buffer).setUint32(at + offset, value, true); else f[at + offset] = value;
      return f;
    };
    expect(() => readSave(patch(0, 0x12345678, 4))).toThrow(/Bad chunk tag/);
    expect(() => readSave(patch(4, 7, 4))).toThrow(/Unknown archive header version/);
    expect(() => readSave(patch(16, 1, 1))).toThrow(/Unsupported compressor/);
  });

  it('wraps a zlib failure as a corrupt save, not an engine crash', () => {
    const f = joinSave(header, body);
    const zStart = header.length + 4 + 4 + 8 + 1 + 32;
    for (let i = 0; i < 64; i++) f[zStart + 2 + i] = 0xff;
    expect(codeOf(() => readSave(f))).toBe('corrupt');
  });

  it("checks the body's leading int64 length (it excludes its own 8 bytes)", () => {
    const wrong = new Uint8Array(body);
    new DataView(wrong.buffer).setBigInt64(0, BigInt(body.length), true); // counts its own 8 bytes
    expect(() => readSave(joinSave(header, wrong))).toThrow(/Body size mismatch/);
  });

  it('reports a truncated file as corrupt', () => {
    for (const f of ['default.sav', 'obsidian-gears.sav'] as const) {
      const bytes = fixture(f);
      expect(codeOf(() => readSave(bytes.subarray(0, Math.floor(bytes.length / 2))))).toBe('corrupt');
      expect(codeOf(() => readSave(bytes.subarray(0, 40)))).toBe('corrupt');
    }
  });

  it('reports a file with a header but no body as corrupt', () => {
    expect(codeOf(() => readSave(header))).toBe('corrupt');
  });
});

describe('fail soft: an undecodable object is kept, flagged and isolated', () => {
  const file = 'max-milestone-multiplier.sav';
  const { header, body } = splitSave(fixture(file));
  const original = parsedSave(file);
  const gs = original.levels.flatMap((l) => l.objects).find((o) => o.className === 'BP_GameState_C')!;

  // Corrupt the length of the first property name inside BP_GameState_C's record.
  const firstProp = Object.values(gs.properties)[0]!.name;
  const nameBytes = new ByteWriter().str(firstProp).done();
  const recordAt = offsetIn(body, gs.record);
  const nameAt = offsetIn(gs.record, nameBytes);
  const corrupted = new Uint8Array(body);
  new DataView(corrupted.buffer).setInt32(recordAt + nameAt, 0x7fffffff, true);
  const p = readSave(joinSave(header, corrupted));
  const bad = p.levels.flatMap((l) => l.objects).find((o) => o.className === 'BP_GameState_C')!;

  it('flags only that object as failed and keeps its record byte-for-byte', () => {
    expect(recordAt).toBeGreaterThan(0);
    expect(nameAt).toBeGreaterThan(0);
    expect(p.stats.failedObjects).toBe(1);
    expect(p.stats.objects).toBe(original.stats.objects);
    expect(bad.failed).toMatch(/FString length/);
    expect(bad.properties).toEqual({});
    expect(Buffer.from(bad.record).equals(Buffer.from(corrupted.subarray(recordAt, recordAt + gs.record.length)))).toBe(true);
  });

  it('keeps reading every other object unchanged', () => {
    const before = original.levels.flatMap((l) => l.objects);
    const after = p.levels.flatMap((l) => l.objects);
    for (let i = 0; i < before.length; i++) {
      if (before[i] === gs) continue;
      expect(after[i]!.failed).toBeUndefined();
      expect(Object.keys(after[i]!.properties)).toEqual(Object.keys(before[i]!.properties));
    }
  });

  it('says so in the summary instead of silently presenting defaults as read', () => {
    const s = summarizeSave(p, gameData());
    expect(s.parseStats.failedObjects).toBe(1);
    expect(s.warnings.some((w) => /BP_GameState_C could not be decoded/.test(w))).toBe(true);
    expect(saveSummary(file).gameMode.partsCostMultiplier.value).toBe(2);
    expect(s.gameMode.partsCostMultiplier.source).toBe('default');
  });
});

describe('third-party editor layout (*_CALCULATOR.sav)', () => {
  // Rebuild default.sav the way the external save editor writes it: the persistent level's
  // destroyed-actor map moves into its TOC blob (with the last empty list's count left out),
  // the trailing ref list is dropped, and the level ends with an i32 TOC version instead.
  const { header, body } = splitSave(fixture('default.sav'));
  const original = parsedSave('default.sav');
  const persistent = original.levels.at(-1)!;
  const tocAt = offsetIn(body, persistent.raw.toc);
  const dataAt = offsetIn(body, persistent.raw.data);
  const trailer = body.subarray(dataAt + persistent.raw.data.length);
  const map = new ByteWriter().i32(1).str('Persistent_Level').done();
  const toc = concat(persistent.raw.toc, map);
  const edited = withBodyLength(concat(
    body.subarray(0, tocAt - 8),
    new ByteWriter().i64(toc.length).done(), toc,
    new ByteWriter().i64(persistent.raw.data.length).done(), persistent.raw.data,
    new ByteWriter().i32(60).done(),
  ));
  const p = readSave(joinSave(header, edited));

  it('the game layout ends with the destroyed-actor map plus a ref list', () => {
    expect(trailer.length).toBe(4 + 21 + 4 + 4);
    expect(original.layout).toBe('game');
    expect([...original.destroyedActors.keys()]).toEqual(['Persistent_Level']);
  });

  it('reads the editor layout with identical objects and summary', () => {
    expect(p.layout).toBe('persistent-toc-version');
    expect(p.stats.failedObjects).toBe(0);
    expect(p.stats.objects).toBe(original.stats.objects);
    expect([...p.destroyedActors.entries()]).toEqual([['Persistent_Level', []]]);
    expect(JSON.stringify(summarizeSave(p, gameData()))).toBe(JSON.stringify(saveSummary('default.sav')));
  });

  it('rejects unexplained bytes at the end of the persistent level', () => {
    const extra = withBodyLength(concat(body, new Uint8Array([1, 2, 3])));
    expect(codeOf(() => readSave(joinSave(header, extra)))).toBe('corrupt');
  });
});
