/**
 * Byte builders for synthetic save tests: a little-endian writer, and helpers that take a real
 * fixture apart (header + inflated body) and put it back together with chosen chunking.
 */
import { zlibSync } from 'fflate';
import { readSaveHeader } from '../../src/save/header';
import { inflateSaveBody, PACKAGE_FILE_TAG, ARCHIVE_V2, COMPRESSOR_ZLIB } from '../../src/save/decompress';

export class ByteWriter {
  private parts: number[] = [];
  get length(): number { return this.parts.length; }
  u8(v: number): this { this.parts.push(v & 0xff); return this; }
  i8(v: number): this { return this.u8(v); }
  private num(n: number, set: (dv: DataView) => void): this {
    const b = new Uint8Array(n); set(new DataView(b.buffer)); for (const x of b) this.parts.push(x); return this;
  }
  u16(v: number): this { return this.num(2, (d) => d.setUint16(0, v, true)); }
  i32(v: number): this { return this.num(4, (d) => d.setInt32(0, v, true)); }
  u32(v: number): this { return this.num(4, (d) => d.setUint32(0, v, true)); }
  i64(v: bigint | number): this { return this.num(8, (d) => d.setBigInt64(0, BigInt(v), true)); }
  f32(v: number): this { return this.num(4, (d) => d.setFloat32(0, v, true)); }
  f64(v: number): this { return this.num(8, (d) => d.setFloat64(0, v, true)); }
  bytes(b: ArrayLike<number>): this { for (let i = 0; i < b.length; i++) this.parts.push(b[i]!); return this; }
  /** Narrow FString (length includes the NUL; 0 = empty). */
  str(s: string): this {
    if (!s) return this.i32(0);
    this.i32(s.length + 1); for (const c of s) this.parts.push(c.charCodeAt(0)); this.parts.push(0); return this;
  }
  /** UTF-16LE FString (negative length in code units, including the NUL). */
  wstr(s: string): this {
    this.i32(-(s.length + 1)); for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i)); this.u16(0); return this;
  }
  /** Property type node: name, child count, children. */
  node(name: string, children: Array<[string, Array<[string, unknown[]]>]> = []): this {
    this.str(name).i32(children.length);
    for (const [n, c] of children) this.node(n, c as never);
    return this;
  }
  /** Tag header for a complete-type-name property; `type` writes the type tree. */
  tag(name: string, type: (w: this) => void, size: number, flags = 0): this {
    this.str(name); type(this); this.i32(size).u8(flags); return this;
  }
  done(): Uint8Array { return new Uint8Array(this.parts); }
}

export interface SaveParts { header: Uint8Array; body: Uint8Array }

/** Split a save file into its raw header bytes and its inflated body. */
export function splitSave(file: Uint8Array): SaveParts {
  const h = readSaveHeader(file);
  return { header: file.subarray(0, h.bodyOffset), body: inflateSaveBody(file, h.bodyOffset) };
}

export interface ChunkOptions {
  /** Archive header version per chunk: 0x22222222 (with compressor byte) or 0. */
  archiveVersion?: number;
  chunkSize?: number;
  /** Lie about each chunk's uncompressed size by this many bytes. */
  uncompressedSizeDelta?: number;
}

/** Re-chunk and compress a body behind a header, the way the game does. */
export function joinSave(header: Uint8Array, body: Uint8Array, o: ChunkOptions = {}): Uint8Array {
  const archiveVersion = o.archiveVersion ?? ARCHIVE_V2;
  const chunkSize = o.chunkSize ?? 131072;
  const w = new ByteWriter().bytes(header);
  for (let at = 0; at < body.length; at += chunkSize) {
    const raw = body.subarray(at, Math.min(body.length, at + chunkSize));
    const z = zlibSync(raw);
    w.u32(PACKAGE_FILE_TAG).u32(archiveVersion).i64(chunkSize);
    if (archiveVersion === ARCHIVE_V2) w.u8(COMPRESSOR_ZLIB);
    const usize = raw.length + (o.uncompressedSizeDelta ?? 0);
    w.i64(z.length).i64(usize).i64(z.length).i64(usize).bytes(z);
  }
  return w.done();
}

/** Body with its leading int64 length rewritten to match the new length. */
export function withBodyLength(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body);
  new DataView(out.buffer).setBigInt64(0, BigInt(out.length - 8), true);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
