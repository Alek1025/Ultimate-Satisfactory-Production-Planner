import { unzlibSync } from 'fflate';
import { BinaryReader, SaveFormatError } from './binary-reader';

export const PACKAGE_FILE_TAG = 0x9e2a83c1;
export const ARCHIVE_V2 = 0x22222222;
export const COMPRESSOR_ZLIB = 3;

/**
 * Inflate the chunked zlib body that follows the save header.
 * Each chunk: tag, archive header version, int64 max chunk size, [compressor byte when the
 * archive version is 0x22222222], then two (compressed, uncompressed) int64 pairs and the
 * zlib payload. Every chunk's inflated size is checked against its header.
 */
export function inflateSaveBody(bytes: Uint8Array, offset: number): Uint8Array {
  const r = new BinaryReader(bytes, offset);
  const parts: Uint8Array[] = [];
  let total = 0;
  if (r.remaining === 0) throw new SaveFormatError('Save has no body after the header', offset);
  while (r.remaining > 0) {
    const chunkStart = r.pos;
    const tag = r.u32();
    if (tag !== PACKAGE_FILE_TAG) {
      throw new SaveFormatError(`Bad chunk tag 0x${tag.toString(16)}`, chunkStart);
    }
    const archiveVersion = r.u32();
    r.i64(); // max chunk size
    if (archiveVersion === ARCHIVE_V2) {
      const compressor = r.u8();
      if (compressor !== COMPRESSOR_ZLIB) {
        throw new SaveFormatError(`Unsupported compressor ${compressor}`, chunkStart);
      }
    } else if (archiveVersion !== 0) {
      throw new SaveFormatError(`Unknown archive header version 0x${archiveVersion.toString(16)}`, chunkStart);
    }
    const compressedSize = r.i64n();
    const uncompressedSize = r.i64n();
    r.i64n(); // repeated compressed size
    r.i64n(); // repeated uncompressed size
    const payload = r.bytesView(compressedSize);
    let out: Uint8Array;
    try {
      out = unzlibSync(payload);
    } catch (e) {
      throw new SaveFormatError(`Chunk does not inflate: ${(e as Error).message}`, chunkStart);
    }
    if (out.byteLength !== uncompressedSize) {
      throw new SaveFormatError(
        `Chunk inflated to ${out.byteLength} bytes, expected ${uncompressedSize}`, chunkStart,
      );
    }
    parts.push(out);
    total += out.byteLength;
  }
  if (parts.length === 1) return parts[0]!;
  const body = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { body.set(p, at); at += p.byteLength; }
  return body;
}
