/**
 * Parser for Unreal "ExportText" values as they appear in Docs.json, e.g.
 *   ((ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/.../Desc_X.Desc_X_C'",Amount=1))
 *   ("/Game/.../Build_A.Build_A_C","/Game/.../Build_B.Build_B_C")
 *   (RF_LIQUID,RF_GAS)
 *
 * Grammar:  value := '(' [entry (',' entry)*] ')' | '"' chars '"' | bare
 *           entry := key '=' value | value
 * A parenthesised group whose entries are all keyed becomes an object;
 * otherwise it becomes an array.
 */
export type UEValue = string | UEValue[] | { [k: string]: UEValue };

export class UETextError extends Error {}

export function parseUEText(src: string): UEValue {
  let i = 0;
  const s = src.trim();
  if (s === '') return [];

  function ws(): void { while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\r' || s[i] === '\t')) i++; }

  function quoted(): string {
    i++; // opening quote
    let out = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      out += s[i++];
    }
    if (s[i] !== '"') throw new UETextError(`Unterminated string in: ${src.slice(0, 80)}`);
    i++;
    return out;
  }

  function bare(): string {
    const start = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if ((c === ',' || c === '=') && depth === 0) break;
      i++;
    }
    return s.slice(start, i).trim();
  }

  function value(): UEValue {
    ws();
    if (s[i] === '(') return group();
    if (s[i] === '"') return quoted();
    return bare();
  }

  function group(): UEValue {
    i++; // '('
    const entries: Array<{ key?: string; value: UEValue }> = [];
    ws();
    if (s[i] === ')') { i++; return []; }
    for (;;) {
      ws();
      let key: string | undefined;
      if (s[i] !== '(' && s[i] !== '"') {
        const save = i;
        const word = bare();
        ws();
        if (s[i] === '=') { i++; key = word; } else { i = save; }
      }
      entries.push({ key, value: value() });
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ')') { i++; break; }
      throw new UETextError(`Unexpected '${s[i] ?? 'EOF'}' at ${i} in: ${src.slice(0, 120)}`);
    }
    if (entries.length && entries.every((e) => e.key !== undefined)) {
      const o: { [k: string]: UEValue } = {};
      for (const e of entries) o[e.key!] = e.value;
      return o;
    }
    return entries.map((e) => e.value);
  }

  const v = value();
  ws();
  if (i !== s.length) throw new UETextError(`Trailing input at ${i} in: ${src.slice(0, 120)}`);
  return v;
}

/**
 * Extract the class name from an object path in any of the forms Docs uses:
 *   /Script/Engine.BlueprintGeneratedClass'/Game/A/B/Desc_X.Desc_X_C'
 *   "/Game/A/B/Build_Y.Build_Y_C"
 *   /Script/FactoryGame.FGBuildGun
 */
export function classNameFromPath(path: string): string {
  let p = path.trim().replace(/^"|"$/g, '');
  const q = p.indexOf("'");
  if (q >= 0) p = p.slice(q + 1, p.lastIndexOf("'") > q ? p.lastIndexOf("'") : undefined);
  const dot = p.lastIndexOf('.');
  return dot >= 0 ? p.slice(dot + 1) : p.slice(p.lastIndexOf('/') + 1);
}

export function asArray(v: UEValue | undefined): UEValue[] {
  if (v === undefined || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

/** Parse "((ItemClass=...,Amount=N),...)" into [{className, amount}]. */
export function parseItemAmounts(src: string | undefined): Array<{ className: string; amount: number }> {
  if (!src) return [];
  return asArray(parseUEText(src)).map((e) => {
    if (typeof e !== 'object' || Array.isArray(e)) throw new UETextError(`Bad item amount entry in ${src.slice(0, 80)}`);
    const cls = e['ItemClass'];
    // ExportText omits fields equal to their default; FItemAmount::Amount defaults to 1.
    const amt = e['Amount'] ?? '1';
    if (typeof cls !== 'string' || typeof amt !== 'string' || !Number.isFinite(Number(amt))) {
      throw new UETextError(`Bad item amount entry in ${src.slice(0, 80)}`);
    }
    return { className: classNameFromPath(cls), amount: Number(amt) };
  });
}

/** Parse ("/Game/...X_C","/Game/...Y_C") into class names. */
export function parseClassList(src: string | undefined): string[] {
  if (!src) return [];
  return asArray(parseUEText(src)).filter((x): x is string => typeof x === 'string' && x !== '').map(classNameFromPath);
}
