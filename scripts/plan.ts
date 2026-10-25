/**
 * Dev CLI: solve one plan against a save and print the explanation.
 *
 *   npm run plan -- fixtures/en-US.json fixtures/obsidian-gears.sav \
 *     '{"targets":[{"item":"Desc_IronPlateReinforced_C","ratePerMin":10}]}' [--json] [--integer] [--timing]
 *
 * Request fields default to: no maximize, no manual inputs, no exclusions/caps,
 * default objective order, budgets 0.
 */
import { readFileSync } from 'node:fs';
import highsLoader from 'highs';
import {
  readDocsFile, parseGameData, parseLabels, summarizeSaveBytes, resolveNodes, loadBundledNodeCatalog,
  buildPlanningProblem, solvePlan, createHighsBackend, makeLabel, DEFAULT_OBJECTIVE_ORDER, type PlanRequest, type LpBackend,
} from '../src';

const [docs, save, json, ...flags] = process.argv.slice(2);
if (!docs || !save || !json) {
  console.error('usage: plan <docs.json> <save.sav> <request-json> [--json] [--integer]');
  process.exit(2);
}
const groups = readDocsFile(new Uint8Array(readFileSync(docs)));
const gd = parseGameData(groups);
const labels = parseLabels(groups, 'en-US');
const summary = summarizeSaveBytes(new Uint8Array(readFileSync(save)), gd);
const problem = buildPlanningProblem(gd, summary, resolveNodes(summary, gd, loadBundledNodeCatalog()));
const partial = JSON.parse(json) as Partial<PlanRequest>;
const request: PlanRequest = {
  targets: [], maximize: [], manualInputs: [], excludedNodes: [], rawCaps: [], disabledRecipes: [],
  objectiveOrder: [...DEFAULT_OBJECTIVE_ORDER], budgets: { somersloops: 0, powerShards: 0 }, ...partial,
};
const highs = createHighsBackend(() => highsLoader());
// --timing logs every LP/MILP call (size, status, ms) to stderr.
const backend: LpBackend = !flags.includes('--timing') ? highs : {
  name: highs.name,
  async solve(req) {
    const t = performance.now();
    const r = await highs.solve(req);
    console.error(`  solve ${req.sense} cols=${req.model.colLower.length} rows=${req.model.rows.length} int=${req.model.integer.filter(Boolean).length} -> ${r.status} in ${(performance.now() - t).toFixed(0)} ms`);
    return r;
  },
};
const t0 = performance.now();
const result = await solvePlan(problem, request, backend,
  flags.includes('--integer') ? { integerPass: 'on' } : {}, makeLabel(labels.names));
const ms = performance.now() - t0;
if (flags.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`${summary.source.sessionName} — ${result.status} (${result.pass}, ${ms.toFixed(0)} ms)\n`);
  for (const l of result.explanation) console.log(l);
  if (result.warnings.length) { console.log('\nWarnings:'); result.warnings.forEach((w) => console.log(`- ${w}`)); }
  const label = makeLabel(labels.names);
  console.log('\nBuildings:');
  for (const b of result.buildings) console.log(`  ${b.count} × ${label(b.building)}  ${label(b.recipe)}  @${(b.clockEach * 100).toFixed(1)}%${b.sloopsEach ? `  sloops ${b.sloopsEach}` : ''}${b.shardsEach ? `  shards ${b.shardsEach}` : ''}`);
  for (const e of result.extraction) console.log(`  ${e.count} × ${label(e.extractor)}  ${e.purity ?? ''} ${label(e.resource)}  @${(e.clockEach * 100).toFixed(1)}%  ${e.ratePerMin.toFixed(1)}/min${e.shardsEach ? `  shards ${e.shardsEach}` : ''}`);
}
