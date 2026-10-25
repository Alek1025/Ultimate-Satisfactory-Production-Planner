import { readFileSync } from 'node:fs';
import { readSave } from '../src/save/save-reader';
const f = process.argv[2]!;
const s = readSave(new Uint8Array(readFileSync(f)));
const c = new Map<string, number>();
for (const l of s.levels) for (const o of l.objects) {
  if (!/ResourceNode|Fracking|Geyser/.test(o.className)) continue;
  const props = Object.entries(o.properties).filter(([k]) => k !== 'mResourcesLeft' && k !== 'mDoSpawnParticle')
    .map(([k, p]) => k + '=' + String((p.value as any)?.pathName?.split('.').pop() ?? p.value)).join(' ');
  const key = `${o.className} lvl=${l.name === 'Persistent_Level' ? 'P' : 'sub'} ${props}`; c.set(key, (c.get(key) ?? 0) + 1);
}
for (const [k, v] of [...c].sort()) console.log(v, k);
for (const l of s.levels) for (const o of l.objects) if (o.className === 'BP_GameState_C')
  for (const [k, p] of Object.entries(o.properties)) { const v = p.value; if (typeof v !== 'object' || v === null) console.log('GS', k, '=', String(v)); }
