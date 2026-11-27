/**
 * Build src/gamedata/data/node-catalog-1.2.json from an upstream resourcePurity.json
 * (valentinps/satisfactorymap game_data.zip -> game_data/generated/world/resourcePurity.json,
 * itself an FModel export of the Satisfactory 1.2 level data).
 *
 * Usage: tsx scripts/build-node-catalog.ts <resourcePurity.json>
 * Validation against the fixture saves lives in test/node-catalog.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const UPSTREAM = {
  project: 'valentinps/satisfactorymap',
  asset: 'releases/download/game-data-v3/game_data.zip',
  sha256: '686bac80b43c57044048b9fb95be2d0347d2eb2556cb2564e0c9fed3442fe1d0',
  file: 'game_data/generated/world/resourcePurity.json',
};

type Row = [resource: string, purity: string, position: number[], core?: string];
const raw = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Record<string, Row>;
const short = (p: string) => p.replace(/^.*\./, '');
const purity = (p: string) => ({ IMPURE: 'impure', NORMAL: 'normal', PURE: 'pure' } as Record<string, string>)[p];

const entries: Array<Record<string, string>> = [];
const coreResource = new Map<string, string>();
for (const [path, [res, pur, , core]] of Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const id = short(path);
  const p = purity(pur);
  if (!p) throw new Error(`${id}: unknown purity ${pur}`);
  if (id.startsWith('BP_FrackingSatellite')) {
    if (!core) throw new Error(`${id}: satellite without core`);
    const c = short(core);
    const prev = coreResource.get(c);
    if (prev && prev !== res) throw new Error(`${c}: satellites disagree on resource (${prev} vs ${res})`);
    coreResource.set(c, res);
    entries.push({ id, kind: 'well-satellite', resource: res, purity: p, wellCore: c });
  } else if (id.startsWith('BP_ResourceNodeGeyser')) {
    entries.push({ id, kind: 'geyser', purity: p }); // geysers feed geothermal power, not an item
  } else if (id.startsWith('BP_ResourceNode')) {
    entries.push({ id, kind: 'resource-node', resource: res, purity: p });
  } else throw new Error(`Unexpected node ${id}`);
}
for (const [id, resource] of [...coreResource].sort()) entries.push({ id, kind: 'well-core', resource });

const out = {
  source: `Satisfactory 1.2 level data (FModel export), via ${UPSTREAM.project} ${UPSTREAM.asset} (sha256 ${UPSTREAM.sha256.slice(0, 12)}…). Game data © Coffee Stain Studios.`,
  gameVersion: '1.2',
  upstream: UPSTREAM,
  entries,
};
writeFileSync('src/gamedata/data/node-catalog-1.2.json', JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n');
console.log(`wrote ${entries.length} entries (${coreResource.size} well cores derived from satellites)`);
