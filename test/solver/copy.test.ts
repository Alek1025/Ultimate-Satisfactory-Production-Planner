/**
 * Solver text states facts; it never tells the player what to build, unlock or change
 * (CLAUDE.md, "Never tell the player what to build next"). Runs plans that reach every
 * explanation branch and checks all player-facing strings.
 */
import { expect, it } from 'vitest';
import { solvePlan } from '../../src/solver/solve';
import type { PlanResult } from '../../src/solver/types';
import { resolveNodes } from '../../src/gamedata/node-catalog';
import { buildPlanningProblem } from '../../src/solver/problem';
import { gameData, nodeCatalog, saveSummary } from '../fixtures';
import { backend, request, toyProblem } from './helpers';

const ADVICE = /\b(should|recommend\w*|best|upgrade\w*|consider|try|you need to|you must)\b/i;
/** An imperative verb starting a line, a sentence or an "or" alternative. */
const IMPERATIVE = /(^\s*|[.;:,]\s+|\bor\s+)(build|place|add|unlock|raise|lower|increase|reduce|turn|enter|use|remove|research|collect|buy|get|make|set|switch|move|exclude|un-exclude)\b/i;
const isAdvice = (line: string) => ADVICE.test(line) || IMPERATIVE.test(line);

it('the check catches the advice v1 used to give', () => {
  for (const v1 of [
    '  raise the Power Shard budget by 4 (you hold 10).',
    "  0.4 more pure Ore nodes than are usable (2). That isn't possible on this map; lower the target, un-exclude nodes, or unlock faster extractors/belts.",
    'No production recipe makes X; enter it as a manual input if you already produce it.',
    'Rounding exceeds a limit; turn on the integer pass for exact whole-building counts.',
  ]) expect(isAdvice(v1), v1).toBe(true);
});

function strings(r: PlanResult): string[] {
  return [
    ...r.explanation, ...r.warnings, ...r.assumptions,
    ...(r.infeasibility?.unreachable.flatMap((u) => u.reasons) ?? []),
  ];
}

it('no solver string gives advice', async () => {
  const toy = toyProblem();
  const results = await Promise.all([
    solvePlan(toy, request({ targets: [{ item: 'Plate', ratePerMin: 20 }] }), backend),
    solvePlan(toy, request({ maximize: [{ item: 'Plate' }], budgets: { somersloops: 3, powerShards: 4 } }), backend, { integerPass: 'on' }),
    solvePlan(toyProblem({ productionBoost: { unlocked: false } }), request({ targets: [{ item: 'Plate', ratePerMin: 400 }], budgets: { somersloops: 2, powerShards: 50 } }), backend),
    solvePlan(toyProblem({ holdings: { somersloops: 0, powerShards: 0, slugShardEquivalent: 0 } }), request({ targets: [{ item: 'Plate', ratePerMin: 20 }], rawCaps: [{ item: 'Ore', maxPerMin: 10 }] }), backend),
    solvePlan(toy, request({ targets: [{ item: 'Gizmo', ratePerMin: 1 }, { item: 'Plate', ratePerMin: 10 }], manualInputs: [{ item: 'Ingot', ratePerMin: 5 }] }), backend),
    solvePlan(toyProblem({ transport: { belt: { id: 'Belt', ratePerMin: 20 }, pipe: null } }), request({ targets: [{ item: 'Plate', ratePerMin: 20 }] }), backend),
    solvePlan(toy, request({ targets: [{ item: 'Plate', ratePerMin: 10 }], manualInputs: [{ item: 'Ore', ratePerMin: 5 }] }), backend),
    solvePlan(toy, request({ targets: [{ item: 'Plate', ratePerMin: 10 }], objectiveOrder: ['power', 'targets'] }), backend),
    solvePlan(toy, request(), backend),
  ]);
  const s = saveSummary('obsidian-gears.sav');
  const obsidian = buildPlanningProblem(gameData(), s, resolveNodes(s, gameData(), nodeCatalog()));
  results.push(await solvePlan(obsidian, request({ targets: [{ item: 'Desc_IronPlate_C', ratePerMin: 20000 }, { item: 'Desc_Computer_C', ratePerMin: 1 }], budgets: { somersloops: 5, powerShards: 10 } }), backend));

  const all = results.flatMap(strings);
  expect(all.length).toBeGreaterThan(50);
  const offending = all.filter(isAdvice);
  expect(offending).toEqual([]);
});
