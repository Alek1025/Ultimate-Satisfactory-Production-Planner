/** Dev helper: print what the solver sees for a save (unlocks, transport, holdings, availability). */
import { readFileSync } from 'node:fs';
import { readDocsFile, parseGameData, summarizeSaveBytes, resolveNodes, loadBundledNodeCatalog, buildPlanningProblem } from '../src';
const [docs, ...saves] = process.argv.slice(2);
const gd = parseGameData(readDocsFile(new Uint8Array(readFileSync(docs!))));
for (const f of saves) {
  const s = summarizeSaveBytes(new Uint8Array(readFileSync(f)), gd);
  const p = buildPlanningProblem(gd, s, resolveNodes(s, gd, loadBundledNodeCatalog()));
  console.log(f, JSON.stringify({
    recipes: p.recipes.length, unavailable: p.unavailableRecipes.length, buildings: Object.keys(p.buildings), extractors: p.extractors.map((e) => e.id),
    wells: !!p.wells, transport: p.transport, overclock: p.overclock, boost: p.productionBoost, holdings: p.holdings, unlimited: p.unlimitedResources,
    groups: p.nodeGroups.length, wellGroups: p.wellGroups.length, ironAvail: p.mapAvailability['Desc_OreIron_C'], warnings: p.warnings,
  }, null, 1));
}
