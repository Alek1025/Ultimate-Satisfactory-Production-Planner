import { describe, expect, it } from 'vitest';
import { solvePlan } from '../src/solver/solve';
import { extractorVariants, recipeVariants, shardsForClock } from '../src/solver/variants';
import { backend, request, toyProblem } from './solver-helpers';

const line = (r: Awaited<ReturnType<typeof solvePlan>>, recipe: string) => r.buildings.filter((b) => b.recipe === recipe);
const used = (r: Awaited<ReturnType<typeof solvePlan>>, res: string) => r.resources.find((x) => x.resource === res)?.used ?? 0;

describe('variants', () => {
  it('counts shards per clock step', () => {
    expect([1, 0.8, 1.5, 1.51, 2, 2.5].map((c) => shardsForClock(c, 0.5))).toEqual([0, 0, 1, 2, 2, 3]);
  });

  it('lowers the clock when a port would exceed the belt', () => {
    const p = toyProblem({ transport: { belt: { id: 'Belt', ratePerMin: 20 }, pipe: null } });
    const [v] = recipeVariants(p, p.recipes.find((r) => r.id === 'Plate')!, { allowShards: false, allowSloops: false });
    expect(v!.clock).toBeCloseTo(20 / 30); // 30 Ingot/min input on a 20/min belt
    expect(v!.beltLimited).toBe(true);
  });

  it('only overclocks Somerslooped buildings, and caps boosted output at the belt', () => {
    const p = toyProblem();
    const vs = recipeVariants(p, p.recipes.find((r) => r.id === 'Ingot')!, { allowShards: true, allowSloops: true });
    // s=0 at 100%; s=1 at 100/150/200% (250% would put 150 Ingot/min on a 120 belt)
    expect(vs.map((v) => [v.sloops, v.clock, v.shards])).toEqual([[0, 1, 0], [1, 1, 0], [1, 1.5, 1], [1, 2, 2]]);
    expect(vs[1]!.outputMultiplier).toBe(2);
    expect(vs[1]!.powerMultiplier).toBeCloseTo(4); // 1^1.32 * 2^2
    expect(recipeVariants(p, p.recipes[0]!, { allowShards: true, allowSloops: false })).toHaveLength(1);
  });

  it('caps extractor overclock at the belt', () => {
    const p = toyProblem();
    const e = p.extractors[0]!;
    expect(extractorVariants(p, e, 'Ore', 'pure', { allowShards: true, allowSloops: false }).map((v) => v.ratePerUnit)).toEqual([120]);
    expect(extractorVariants(p, e, 'Ore', 'normal', { allowShards: true, allowSloops: false }).map((v) => [v.ratePerUnit, v.variant.shards])).toEqual([[60, 0], [90, 1], [120, 2]]);
  });
});

describe('lexicographic plan', () => {
  it('prefers the recipe that uses less scarce ore, then the cheapest power', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 20 }] }), backend);
    expect(r.status).toBe('optimal');
    expect(line(r, 'WetPlate')[0]!.amount).toBeCloseTo(2 / 3); // 4 Ingot -> 3 Plate beats 3 -> 2
    expect(line(r, 'Plate')).toHaveLength(0);
    expect(used(r, 'Ore')).toBeCloseTo(80 / 3);
    expect(used(r, 'Water')).toBeCloseTo(40 / 3);
    // Pure nodes give twice the ore for the same miner power.
    expect(r.extraction.filter((e) => e.resource === 'Ore').map((e) => e.purity)).toEqual(['pure']);
    const smelter = line(r, 'Ingot')[0]!;
    expect([smelter.count, smelter.clockEach]).toEqual([1, expect.closeTo(8 / 9, 6)]);
    expect(r.levels.map((l) => l.kind)).toEqual(['targets', 'scarcity', 'power', 'buildings']);
  });

  it('follows a reordered objective list', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 20 }], objectiveOrder: ['targets', 'power', 'scarcity', 'buildings'] }), backend);
    // Power first: the plain recipe avoids the Water Extractor (9.25 MW vs 9.56 MW).
    expect(line(r, 'Plate')[0]!.amount).toBeCloseTo(1);
    expect(line(r, 'WetPlate')).toHaveLength(0);
  });

  it('treats manual inputs as free supply', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 20 }], manualInputs: [{ item: 'Ingot', ratePerMin: 15 }] }), backend);
    expect(used(r, 'Ore')).toBeCloseTo(80 / 3 - 15);
    expect(r.items.find((i) => i.item === 'Ingot')!.manualUsed).toBeCloseTo(15);
  });

  it('respects node exclusions', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 20 }], excludedNodes: ['p1', 'p2'] }), backend);
    expect(r.extraction.filter((e) => e.resource === 'Ore').every((e) => e.purity === 'normal')).toBe(true);
  });

  it('maximizes from available resources and names what limits it', async () => {
    const r = await solvePlan(toyProblem(), request({ maximize: [{ item: 'Plate' }] }), backend);
    // 2 pure (120) + 2 normal (60) = 360 Ore/min -> 360 Ingot -> 270 Plate via WetPlate.
    expect(r.items.find((i) => i.item === 'Plate')!.delivered).toBeCloseTo(270);
    expect(r.levels[0]!.binding.map((b) => b.id).sort()).toEqual(['Ore:normal', 'Ore:pure']);
    expect(r.explanation.join('\n')).toMatch(/More Plate is limited by/);
  });
});

describe('budgets', () => {
  it('uses shards only when budgeted, and only on extractors / Somerslooped buildings', async () => {
    const none = await solvePlan(toyProblem(), request({ maximize: [{ item: 'Plate' }] }), backend);
    expect(none.budgets.powerShards.used).toBe(0);
    const r = await solvePlan(toyProblem(), request({ maximize: [{ item: 'Plate' }], budgets: { somersloops: 0, powerShards: 4 } }), backend);
    // 4 shards take both normal nodes to 200% (+120 Ore) -> 480 Ore -> 360 Plate.
    expect(r.items.find((i) => i.item === 'Plate')!.delivered).toBeCloseTo(360);
    expect(r.budgets.powerShards.used).toBe(4);
    expect(r.budgets.powerShards.where.every((w) => w.resource === 'Ore')).toBe(true);
  });

  it('integer pass keeps whole Somerslooped buildings within the budget', async () => {
    const r = await solvePlan(toyProblem(), request({ maximize: [{ item: 'Plate' }], budgets: { somersloops: 3, powerShards: 4 } }), backend, { integerPass: 'on' });
    expect(r.pass).toBe('integer');
    expect(r.budgets.somersloops.used).toBeLessThanOrEqual(3);
    expect(r.budgets.powerShards.used).toBeLessThanOrEqual(4);
    expect(r.buildings.every((b) => Number.isInteger(b.count))).toBe(true);
    expect(r.items.find((i) => i.item === 'Plate')!.delivered).toBeGreaterThan(360);
    // Supply covers demand, up to HiGHS's MIP feasibility tolerance.
    for (const i of r.items) expect(i.produced + i.extracted + i.manualUsed + 1e-5 * Math.max(1, i.consumed + i.delivered)).toBeGreaterThanOrEqual(i.consumed + i.delivered);
  });

  it('ignores a shard budget when overclocking is locked, with a warning', async () => {
    const p = toyProblem({ overclock: { unlocked: false, perShard: 0.5, maxShards: 3 } });
    const r = await solvePlan(p, request({ maximize: [{ item: 'Plate' }], budgets: { somersloops: 0, powerShards: 5 } }), backend);
    expect(r.budgets.powerShards.used).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/overclocking is not unlocked/);
  });

  it('warns when a budget exceeds what the save holds', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 1 }], budgets: { somersloops: 9, powerShards: 0 } }), backend);
    expect(r.warnings.join(' ')).toMatch(/Somersloop budget \(9\) is more than this save has \(4\)/);
  });
});

describe('infeasibility', () => {
  it('reports the shortfall and the smallest fix, budgets before map nodes', async () => {
    // Production boost locked, so Somersloops (even ones not yet collected) can't help.
    const p = toyProblem({ productionBoost: { unlocked: false } });
    const r = await solvePlan(p, request({ targets: [{ item: 'Plate', ratePerMin: 400 }] }), backend);
    expect(r.status).toBe('targets-not-met');
    expect(r.infeasibility!.shortfalls[0]!.achieved).toBeCloseTo(270);
    // 400 Plate needs 533.3 Ore: 4 shards (held) lift normal nodes to 480, the rest needs
    // 53.3/120 = 0.44 more pure nodes than the map has.
    const fix = Object.fromEntries(r.infeasibility!.relaxation.map((x) => [`${x.tier}:${x.limit.id}`, x.extraNeeded]));
    expect(Object.keys(fix).sort()).toEqual(['budget:powerShards', 'map:Ore:pure']);
    expect(fix['budget:powerShards']).toBeCloseTo(4);
    expect(fix['map:Ore:pure']).toBeCloseTo(160 / 360, 4);
    expect(r.explanation.join('\n')).toMatch(/raise the Power Shard budget by 4/);
    expect(r.infeasibility!.binding.map((b) => b.id).sort()).toEqual(['Ore:normal', 'Ore:pure']);
  });

  it('prefers held Somersloops (they amplify output without more ore), then ones still to collect', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 400 }] }), backend);
    expect(r.infeasibility!.relaxation.map((x) => `${x.tier}:${x.limit.id}`)).toContain('budget:somersloops');
    expect(r.infeasibility!.relaxation.every((x) => x.tier === 'budget')).toBe(true);
    const none = await solvePlan(toyProblem({ holdings: { somersloops: 0, powerShards: 10, slugShardEquivalent: 0 } }), request({ targets: [{ item: 'Plate', ratePerMin: 400 }] }), backend);
    expect(none.infeasibility!.relaxation.map((x) => `${x.tier}:${x.limit.id}`)).toContain('over-holdings:somersloops');
    expect(none.infeasibility!.relaxation.some((x) => x.tier === 'map')).toBe(false);
  });

  it('suggests raising a raw cap before anything physical', async () => {
    const p = toyProblem({ holdings: { somersloops: 0, powerShards: 0, slugShardEquivalent: 0 } });
    const r = await solvePlan(p, request({ targets: [{ item: 'Plate', ratePerMin: 20 }], rawCaps: [{ item: 'Ore', maxPerMin: 10 }] }), backend);
    expect(r.infeasibility!.relaxation).toEqual([expect.objectContaining({ tier: 'cap', extraNeeded: expect.closeTo(80 / 3 - 10, 4) })]);
    expect(r.explanation.join('\n')).toMatch(/raise your Ore cap by 16.67\/min/);
  });

  it('explains items that cannot be made at all', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Gizmo', ratePerMin: 1 }, { item: 'Plate', ratePerMin: 10 }] }), backend);
    expect(r.status).toBe('targets-not-met');
    expect(r.infeasibility!.unreachable[0]).toEqual({ item: 'Gizmo', reasons: ['The Gizmo recipe is not unlocked yet.'] });
    expect(r.items.find((i) => i.item === 'Plate')!.delivered).toBeCloseTo(10); // the rest still gets planned
  });

  it('rejects manual inputs of raw resources', async () => {
    const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 10 }], manualInputs: [{ item: 'Ore', ratePerMin: 5 }] }), backend);
    expect(r.status).toBe('error');
    expect(r.explanation[0]).toMatch(/raw resources come from nodes/);
  });
});

it('results are plain JSON', async () => {
  const r = await solvePlan(toyProblem(), request({ targets: [{ item: 'Plate', ratePerMin: 20 }] }), backend);
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
});

describe('resource wells', () => {
  // One Nitrogen well: 1 pure + 2 normal satellites (60 m³/min base) = 240 m³/min at 100%.
  const wellProblem = () => toyProblem({
    items: { ...toyProblem().items, N2: { id: 'N2', form: 'gas', fluid: true, isRaw: true } },
    wells: {
      pressurizer: { id: 'Pressurizer', powerMW: 150, powerExponent: 1.321929, canOverclock: true },
      extractor: { id: 'WellExtractor', baseRatePerMin: 60, powerMW: 0 },
    },
    wellGroups: [{ id: 'well:Core1', coreId: 'Core1', resource: 'N2', satellites: [{ id: 's1', purity: 'pure' }, { id: 's2', purity: 'normal' }, { id: 's3', purity: 'normal' }] }],
    mapAvailability: { Ore: 360, N2: 240 },
  });

  it('scales every satellite with the pressurizer clock', async () => {
    const r = await solvePlan(wellProblem(), request({ targets: [{ item: 'N2', ratePerMin: 100 }] }), backend);
    expect(r.extraction).toEqual([expect.objectContaining({ source: 'well', count: 1, satellites: 3, clockEach: expect.closeTo(100 / 240, 6) })]);
    expect(r.buildingCount).toBe(4); // pressurizer + 3 extractors
  });

  it('overclocks the pressurizer with shards, capped by each satellite pipe', async () => {
    const r = await solvePlan(wellProblem(), request({ maximize: [{ item: 'N2' }], budgets: { somersloops: 0, powerShards: 3 } }), backend);
    // pure satellite: 120 x 2.5 = 300 = Mk.1 pipe, so 250% is allowed: 600 m³/min.
    expect(r.items.find((i) => i.item === 'N2')!.delivered).toBeCloseTo(600);
    expect(r.budgets.powerShards.where).toEqual([{ resource: 'N2', building: 'Pressurizer', count: 1, each: 3 }]);
  });

  it('excluding satellites removes their output', async () => {
    const r = await solvePlan(wellProblem(), request({ maximize: [{ item: 'N2' }], excludedNodes: ['s1'] }), backend);
    expect(r.items.find((i) => i.item === 'N2')!.delivered).toBeCloseTo(120);
  });
});
