/**
 * Little-endian binary reader over a Uint8Array, with Unreal FString support.
 * Platform-neutral: no Node or DOM APIs beyond TextDecoder.
 */

/**
 * 'unsupported-version': the file is a save, but from a game version this planner refuses
 * (pre-1.0 headers, pre-1.1 save versions). 'corrupt': anything else that fails to read.
 */
export type SaveFormatErrorCode = 'unsupported-version' | 'corrupt';

export class SaveFormatError extends Error {
  constructor(message: string, public readonly offset?: number, public readonly code: SaveFormatErrorCode = 'corrupt') {
    super(offset !== undefined ? `${message} (at byte ${offset})` : message);
    this.name = 'SaveFormatError';
  }
}

const latin1 = new TextDecoder('latin1');
const utf16 = new TextDecoder('utf-16le');

export class BinaryReader {
  readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array, start = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }

  get length(): number { return this.bytes.byteLength; }
  get remaining(): number { return this.bytes.byteLength - this.pos; }

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.bytes.byteLength) {
      throw new SaveFormatError(`Unexpected end of data: need ${n} bytes, ${this.remaining} left`, this.pos);
    }
  }

  u8(): number { this.need(1); return this.view.getUint8(this.pos++); }
  i8(): number { this.need(1); return this.view.getInt8(this.pos++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  i64(): bigint { this.need(8); const v = this.view.getBigInt64(this.pos, true); this.pos += 8; return v; }
  u64(): bigint { this.need(8); const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }

  /** int64 that must fit in a JS number (sizes, counts). */
  i64n(): number {
    const v = this.i64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new SaveFormatError(`int64 out of safe range: ${v}`, this.pos - 8);
    }
    return Number(v);
  }

  bytesView(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void { this.need(n); this.pos += n; }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.byteLength) throw new SaveFormatError(`Seek out of range: ${pos}`);
    this.pos = pos;
  }

  /** Unreal FString: int32 length incl. NUL; negative => UTF-16LE code units. */
  fstring(): string {
    const start = this.pos;
    const n = this.i32();
    if (n === 0) return '';
    if (n > 0) {
      if (n > this.remaining) throw new SaveFormatError(`FString length ${n} exceeds data`, start);
      const s = latin1.decode(this.bytes.subarray(this.pos, this.pos + n - 1));
      this.pos += n;
      return s;
    }
    const units = -n;
    if (units * 2 > this.remaining) throw new SaveFormatError(`FString(UTF-16) length ${units} exceeds data`, start);
    const s = utf16.decode(this.bytes.subarray(this.pos, this.pos + (units - 1) * 2));
    this.pos += units * 2;
    return s;
  }

  guid(): string {
    const b = this.bytesView(16);
    let s = '';
    for (const x of b) s += x.toString(16).padStart(2, '0');
    return s;
  }
}
