/** Usage: tsx scripts/summarize.ts <Docs/locale.json> <save.sav> [--json] */
import { readFileSync } from 'node:fs';
import { readDocsFile, parseGameData, parseLabels } from '../src/gamedata/docs-parser';
import { summarizeSaveBytes } from '../src/save/extract';
import { loadBundledNodeCatalog, resolveNodes } from '../src/gamedata/node-catalog';

const [docsPath, savePath, flag] = process.argv.slice(2);
if (!docsPath || !savePath) { console.error('usage: summarize <docs.json> <save.sav> [--json]'); process.exit(1); }
const groups = readDocsFile(new Uint8Array(readFileSync(docsPath)));
const gd = parseGameData(groups);
const L = parseLabels(groups, 'en');
const s = summarizeSaveBytes(new Uint8Array(readFileSync(savePath)), gd);
if (flag === '--json') { console.log(JSON.stringify({ ...s, nodes: `${s.nodes.length} nodes` }, null, 2)); process.exit(0); }
const name = (c: string) => L.names.get(c) ?? c;
const p = s.progression, gm = s.gameMode, h = s.holdings;
console.log(`# ${s.source.sessionName}  —  ${s.version.gameVersion} [${s.version.status}]`);
console.log(`Saved ${s.source.savedAt}, played ${(s.source.playDurationSeconds / 3600).toFixed(1)} h`);
console.log(`Randomization: ${gm.nodeRandomization.value} (${gm.nodeRandomization.source}); nodes with stored resource: ${s.nodes.filter(n => n.resourceOverride).length}`);
console.log(`Game mode: parts cost x${gm.partsCostMultiplier.value} (${gm.partsCostMultiplier.source}), space parts x${gm.spacePartsCostMultiplier.value} (${gm.spacePartsCostMultiplier.source}), purity ${gm.nodePurity.value} (${gm.nodePurity.source}), seed ${gm.nodeRandomizationSeed.value ?? '—'}`);
console.log(`Tier ${p.highestMilestoneTier}; ${p.milestones.length} milestones; active: ${p.activeMilestone ? name(p.activeMilestone) : '—'}`);
console.log(`Phase ${p.phase.currentIndex ?? 0} (${p.phase.current ?? 'none'}) -> ${p.phase.target ?? '—'}; paid: ${p.phase.targetPaidOff.map(a => `${a.amount} ${name(a.item)}`).join(', ') || '—'}`);
console.log(`MAM research: ${p.mamResearch.length}; alternate schematics: ${p.alternateSchematics.length}; unlocked alt recipes: ${p.unlockedAlternateRecipes.length}; recipes: ${p.unlockedRecipes.length}; shop: ${p.awesomeShopSchematics.length}`);
console.log(`  alts: ${p.unlockedAlternateRecipes.map(name).join('; ')}`);
console.log(`Overclock unlocked: ${p.overclockUnlocked}; Somersloop boost unlocked: ${p.productionBoostUnlocked}`);
console.log(`Somersloops: ${h.somersloops.total} (stored ${h.somersloops.stored}, in buildings ${h.somersloops.inBuildings})`);
console.log(`Power shards: ${h.powerShards.total} (stored ${h.powerShards.stored}, in buildings ${h.powerShards.inBuildings}); slugs B/Y/P ${h.powerSlugs.blue}/${h.powerSlugs.yellow}/${h.powerSlugs.purple} = ${h.powerSlugs.shardEquivalent} shards`);
const kinds = new Map<string, number>(); for (const n of s.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
const ov = new Map<string, number>(); for (const n of s.nodes) if (n.purityOverride) ov.set(n.purityOverride, (ov.get(n.purityOverride) ?? 0) + 1);
console.log(`Nodes: ${[...kinds].map(([k, v]) => `${v} ${k}`).join(', ')}; purity overrides: ${[...ov].map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
const res = resolveNodes(s, gd, loadBundledNodeCatalog());
console.log('Extractable nodes (impure/normal/pure): ' + [...res.counts].sort().map(([k, c]) => `${name(k)} ${c.impure}/${c.normal}/${c.pure}`).join(', '));
for (const a of res.assumptions) console.log(`  ASSUMPTION: ${a}`);
for (const w of res.warnings) console.log(`  WARNING: ${w}`);
console.log(`Parse: ${s.parseStats.objects} objects, ${s.parseStats.failedObjects} failed, ${s.parseStats.rawProperties} raw props`);
for (const a of s.assumptions) console.log(`  ASSUMPTION: ${a}`);
for (const w of s.warnings) console.log(`  WARNING: ${w}`);
