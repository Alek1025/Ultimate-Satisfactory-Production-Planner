import { readFileSync } from 'node:fs';
import { readSave } from '../src/save/save-reader';
const [f, pattern, max = '3', depth = '6'] = process.argv.slice(2);
const re = new RegExp(pattern!);
const s = readSave(new Uint8Array(readFileSync(f!)));
function simplify(v: any, d: number): any {
  if (d <= 0) return '…';
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return `<raw ${v.length}>`;
  if (Array.isArray(v)) return v.length > 40 ? [...v.slice(0, 40).map(x => simplify(x, d - 1)), `…(+${v.length - 40})`] : v.map(x => simplify(x, d - 1));
  if (typeof v === 'object') {
    if ('typeNode' in v && 'value' in v) return simplify(v.value, d);
    if ('struct' in v && 'value' in v) return { ['§' + v.struct]: simplify(v.value, d - 1) };
    if ('levelName' in v && 'pathName' in v && Object.keys(v).length <= 3) return `ref:${v.pathName}`;
    const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = simplify(x, d - 1); return o;
  }
  return v;
}
let n = 0;
for (const l of s.levels) for (const o of l.objects) {
  if (!re.test(o.className) && !re.test(o.instanceName)) continue;
  if (n++ >= Number(max)) continue;
  console.log('###', o.kind, o.className, o.instanceName, 'level=' + l.name, o.transform ? 'pos=' + o.transform.translation.map(x => x.toFixed(0)).join(',') : '', 'placed=' + o.wasPlacedInLevel, 'trailing=' + o.trailingBytes);
  console.log(JSON.stringify(simplify(o.properties, Number(depth)), null, 1).slice(0, 6000));
}
console.log('matches', n);
