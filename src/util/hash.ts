/**
 * Stable JSON (sorted object keys, Maps as sorted objects) plus two hashes:
 * - `hash53`/`hashValue`: a fast 53-bit hash (cyrb53) for change detection. Not cryptographic.
 * - `sha256Hex`: SHA-256 of raw bytes, for pinning files the player supplies (CatalogPack,
 *   Docs, saves) and for content-addressed blobs.
 */
import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof Map) return Object.fromEntries([...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function hash53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export const hashValue = (v: unknown): string => hash53(stableStringify(v));

/** Lower-case hex SHA-256 of raw bytes (or a UTF-8 string). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
