/**
 * Decode a text file whose encoding is not known up front.
 * Docs.json / en-US.json ship as UTF-16LE with a BOM, but we accept any
 * BOM'd Unicode encoding and fall back to a NUL-pattern heuristic.
 */
export type DetectedEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export function detectEncoding(bytes: Uint8Array): DetectedEncoding {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  // No BOM: ASCII-heavy UTF-16 has NULs in every other byte.
  const n = Math.min(bytes.length, 4096) & ~1;
  let evenNul = 0, oddNul = 0;
  for (let i = 0; i < n; i += 2) { if (bytes[i] === 0) evenNul++; if (bytes[i + 1] === 0) oddNul++; }
  const half = n / 2;
  if (half > 0 && oddNul / half > 0.4 && evenNul / half < 0.05) return 'utf-16le';
  if (half > 0 && evenNul / half > 0.4 && oddNul / half < 0.05) return 'utf-16be';
  return 'utf-8';
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  const encoding = detectEncoding(bytes);
  let text: string;
  switch (encoding) {
    case 'utf-8-bom': text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); break;
    case 'utf-16le': text = new TextDecoder('utf-16le').decode(bytes[0] === 0xff ? bytes.subarray(2) : bytes); break;
    case 'utf-16be': text = new TextDecoder('utf-16be').decode(bytes[0] === 0xfe ? bytes.subarray(2) : bytes); break;
    default: text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding };
}
