/**
 * Solver regression tests on the project's save fixtures with the real en-US game data.
 * Expected numbers are hand-derived where noted, so a change here means a behavior change.
 */
import { describe, expect, it } from 'vitest';
import { summarizeSave } from '../src/save/extract';
import { readSave } from '../src/save/save-reader';
import { loadBundledNodeCatalog, resolveNodes } from '../src/gamedata/node-catalog';
import { parseLabels, readDocsFile } from '../src/gamedata/docs-parser';
import { buildPlanningProblem } from '../src/solver/problem';
import { solvePlan } from '../src/solver/solve';
import { makeLabel } from '../src/solver/explain';
import type { PlanningProblem, PlanRequest, PlanResult } from '../src/solver/types';
import { fixture, gameData, hasFixture } from './fixtures';
import { backend, request } from './solver-helpers';

const catalog = loadBundledNodeCatalog();
const problems = new Map<string, PlanningProblem>();
function problem(save: string): PlanningProblem {
  let p = problems.get(save);
  if (!p) {
    const s = summarizeSave(readSave(fixture(save)), gameData());
    p = buildPlanningProblem(gameData(), s, resolveNodes(s, gameData(), catalog));
    problems.set(save, p);
  }
  return p;
}
let labelFn: ReturnType<typeof makeLabel> | undefined;
const label = () => (labelFn ??= makeLabel(parseLabels(readDocsFile(fixture('en-US.json')), 'en-US').names));
const plan = (save: string, r: Partial<PlanRequest>) => solvePlan(problem(save), request(r), backend, {}, label());
const counts = (r: PlanResult) => Object.fromEntries(r.buildings.map((b) => [b.recipe, b.count]));
const delivered = (r: PlanResult, item: string) => r.items.find((i) => i.item === item)?.delivered ?? 0;

const OBSIDIAN = 'obsidian-gears.sav', MAXMS = 'max-milestone-multiplier.sav', PURE = 'all-pure-nodes.sav';

describe.skipIf(!hasFixture(OBSIDIAN))('Obsidian Gears (tier 3, Mk.1 miners, Mk.2 belts, no production boost)', () => {
  it('builds the planning problem from the save', () => {
    const p = problem(OBSIDIAN);
    expect(p.transport.belt).toEqual({ id: 'Build_ConveyorBeltMk2_C', ratePerMin: 120 });
    expect(p.transport.pipe).toEqual({ id: 'Build_Pipeline_C', ratePerMin: 300 });
    expect(p.extractors.map((e) => e.id)).toEqual(['Build_MinerMk1_C', 'Build_WaterPump_C']);
    expect(p.wells).toBeNull();
    expect([p.overclock.unlocked, p.productionBoost.unlocked]).toEqual([true, false]);
    expect(p.holdings).toEqual({ somersloops: 5, powerShards: 0, slugShardEquivalent: 80 });
    expect(p.mapAvailability['Desc_OreIron_C']).toBe((39 * 0.5 + 42 + 46 * 2) * 240); // best miner in game data: Mk.3
  });

  it('plans Reinforced Iron Plates + Modular Frames (hand-checked counts)', async () => {
    const r = await plan(OBSIDIAN, { targets: [{ item: 'Desc_IronPlateReinforced_C', ratePerMin: 10 }, { item: 'Desc_ModularFrame_C', ratePerMin: 5 }] });
    expect(r.status).toBe('optimal');
    // 17.5 RIP/min -> 3.5 Assemblers; 5 MF/min -> 2.5 Assemblers; 240 Ingot -> 8 Smelters.
    expect(counts(r)).toEqual({
      Recipe_IngotIron_C: 8, Recipe_IronPlate_C: 6, Recipe_IronPlateReinforced_C: 4, Recipe_IronRod_C: 6, Recipe_ModularFrame_C: 3, Recipe_Screw_C: 6,
    });
    expect(r.resources).toEqual([expect.objectContaining({ resource: 'Desc_OreIron_C', used: expect.closeTo(240, 6) })]);
    expect(r.extraction).toEqual([expect.objectContaining({ extractor: 'Build_MinerMk1_C', purity: 'pure', count: 2 })]);
    expect(r.buildingCount).toBe(35);
  });

  it('maximum Iron Plate with 10 shards matches the hand calculation, and says what would fix it', async () => {
    const r = await plan(OBSIDIAN, { targets: [{ item: 'Desc_IronPlate_C', ratePerMin: 20000 }], budgets: { somersloops: 5, powerShards: 10 } });
    // Mk.1 on Mk.2 belts: impure 39x30, normal 42x60, pure 46x120 = 9210; pure can't overclock
    // (already 120 = belt), so 10 shards go to normal nodes at 150% (+30 each): 9510 Ore -> 6340 Plate.
    expect(r.status).toBe('targets-not-met');
    expect(delivered(r, 'Desc_IronPlate_C')).toBeCloseTo(6340, 3);
    expect(r.budgets.powerShards.used).toBe(10);
    expect(r.warnings.join(' ')).toMatch(/Somersloop budget 5 ignored: production boosting is not researched/);
    expect(r.warnings.join(' ')).toMatch(/Power Shard budget \(10\) is more than this save has \(0\)\. Your Power Slugs would make 80 more\./);
    const tiers = r.infeasibility!.relaxation.map((x) => `${x.tier}:${x.limit.kind}`);
    expect(tiers).toContain('over-holdings:shard-budget');
    expect(tiers).toContain('map:nodes');
  });
});

describe.skipIf(!hasFixture(MAXMS))('1.2 Max Milestone Multiplier (106 Somersloops, Mk.3 belts)', () => {
  it('maximizes Rotors under an ore cap with Somersloops (hand-checked)', async () => {
    const r = await plan(MAXMS, { maximize: [{ item: 'Desc_Rotor_C' }], rawCaps: [{ item: 'Desc_OreIron_C', maxPerMin: 600 }], budgets: { somersloops: 20, powerShards: 0 } });
    // 20 Somerslooped Smelters double 600 Ore into 1200 Ingot; a Rotor with Cast Screws
    // costs 5 + 25/4 = 11.25 Ingot -> 106.67 Rotor/min.
    expect(delivered(r, 'Desc_Rotor_C')).toBeCloseTo(1200 / 11.25, 3);
    expect(r.budgets.somersloops.used).toBe(20);
    expect(r.budgets.somersloops.where).toEqual([expect.objectContaining({ recipe: 'Recipe_IngotIron_C', count: 20, each: 1 })]);
    const binding = r.levels.find((l) => l.kind === 'maximize')!.binding.map((b) => b.kind).sort();
    expect(binding).toEqual(['raw-cap', 'somersloop-budget']);
  });

  it('reads Game Mode cost multipliers but they do not change production rates', async () => {
    const r = await plan(MAXMS, { targets: [{ item: 'Desc_IronPlate_C', ratePerMin: 20 }] });
    expect(counts(r)).toEqual({ Recipe_IngotIron_C: 1, Recipe_IronPlate_C: 1 });
  });
});

describe.skipIf(!hasFixture(PURE))('All Pure Nodes (110 recipes, 5306 shards)', () => {
  it('places no building for solver residue (five tier-4 targets, integer pass)', async () => {
    const targets = [
      ['Desc_Motor_C', 20], ['Desc_SteelPlateReinforced_C', 10], ['Desc_SpaceElevatorPart_2_C', 5],
      ['Desc_SpaceElevatorPart_3_C', 5], ['Desc_ModularFrame_C', 10],
    ].map(([item, ratePerMin]) => ({ item: item as string, ratePerMin: ratePerMin as number }));
    const r = await plan(PURE, { targets, budgets: { somersloops: 10, powerShards: 30 } });
    expect(r.status).toBe('optimal');
    for (const b of r.buildings) expect(b.amount).toBeGreaterThanOrEqual(1e-4);
    for (const b of r.buildings) expect(b.clockEach).toBeGreaterThan(1e-3);
    for (const t of targets) expect(delivered(r, t.item)).toBeCloseTo(t.ratePerMin, 4);
  }, 30000);

  it('meets Motor + Encased Beam targets within Somersloop and shard budgets', async () => {
    const t = performance.now();
    const r = await plan(PURE, {
      targets: [{ item: 'Desc_Motor_C', ratePerMin: 20 }, { item: 'Desc_SteelPlateReinforced_C', ratePerMin: 10 }],
      budgets: { somersloops: 10, powerShards: 30 },
    });
    expect(performance.now() - t).toBeLessThan(15000);
    expect(r.status).toBe('optimal');
    expect(delivered(r, 'Desc_Motor_C')).toBeCloseTo(20, 4);
    expect(delivered(r, 'Desc_SteelPlateReinforced_C')).toBeCloseTo(10, 4);
    expect(r.budgets.somersloops.used).toBeLessThanOrEqual(10);
    expect(r.budgets.powerShards.used).toBeLessThanOrEqual(30);
    // Overclock only on Somerslooped buildings and extractors.
    for (const b of r.buildings) if (b.shardsEach > 0) expect(b.sloopsEach).toBeGreaterThan(0);
    for (const b of r.buildings) expect(b.clockEach).toBeLessThanOrEqual(b.sloopsEach ? 2.5 + 1e-9 : 1 + 1e-9);
    // Supply covers demand, up to HiGHS's MIP feasibility tolerance.
    for (const i of r.items) expect(i.produced + i.extracted + i.manualUsed + 1e-5 * Math.max(1, i.consumed + i.delivered)).toBeGreaterThanOrEqual(i.consumed + i.delivered);
  }, 20000);

  it('no input or output port exceeds the Mk.3 belt / Mk.2 pipe', async () => {
    const r = await plan(PURE, { targets: [{ item: 'Desc_SteelPlateReinforced_C', ratePerMin: 30 }], budgets: { somersloops: 20, powerShards: 60 } });
    const p = problem(PURE);
    for (const b of r.buildings) {
      for (const port of [...b.inputs, ...b.outputs]) {
        const cap = p.items[port.item]!.fluid ? p.transport.pipe!.ratePerMin : p.transport.belt!.ratePerMin;
        expect(port.ratePerMin / b.count).toBeLessThanOrEqual(cap + 1e-6);
      }
    }
    for (const e of r.extraction) expect(e.ratePerMin / e.count).toBeLessThanOrEqual(p.transport.belt!.ratePerMin + 1e-6);
  }, 20000);

  it('explains why Computers are out of reach', async () => {
    const r = await plan(PURE, { targets: [{ item: 'Desc_Computer_C', ratePerMin: 5 }] });
    expect(r.status).toBe('targets-not-met');
    const reasons = r.infeasibility!.unreachable[0]!.reasons.join('\n');
    expect(reasons).toMatch(/The Computer recipe is not unlocked yet/);
    expect(reasons).toMatch(/needs the Manufacturer, which is not unlocked yet/);
  });

  it('is deterministic', async () => {
    const req = { targets: [{ item: 'Desc_Motor_C', ratePerMin: 5 }] };
    const [a, b] = [await plan(PURE, req), await plan(PURE, req)];
    expect({ ...a, provenance: null }).toEqual({ ...b, provenance: null });
  });
});
