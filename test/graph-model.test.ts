/** Flow graph model (app/graph/model.ts) on real solver results. */
import { describe, expect, it } from 'vitest';
import { summarizeSave } from '../src/save/extract';
import { readSave } from '../src/save/save-reader';
import { loadBundledNodeCatalog, resolveNodes } from '../src/gamedata/node-catalog';
import { buildPlanningProblem } from '../src/solver/problem';
import { solvePlan } from '../src/solver/solve';
import { makeLabel } from '../src/solver/explain';
import type { PlanRequest, PlanResult } from '../src/solver/types';
import { buildFullGraph, collapse, familyOf } from '../app/graph/model';
import { fixture, gameData, hasFixture } from './fixtures';
import { backend, request } from './solver-helpers';

const label = makeLabel();
async function solve(save: string, r: Partial<PlanRequest>): Promise<{ result: PlanResult; fluid: (i: string) => boolean }> {
  const gd = gameData();
  const s = summarizeSave(readSave(fixture(save)), gd);
  const problem = buildPlanningProblem(gd, s, resolveNodes(s, gd, loadBundledNodeCatalog()));
  const result = await solvePlan(problem, request(r), backend, {}, label);
  return { result, fluid: (i) => !!problem.items[i]?.fluid };
}

/** Sum of edge rates per (box, item), in and out. */
function edgeTotals(edges: ReturnType<typeof buildFullGraph>['edges']) {
  const into = new Map<string, number>(); const out = new Map<string, number>();
  for (const e of edges) for (const it of e.items) {
    into.set(`${e.to}|${it.item}`, (into.get(`${e.to}|${it.item}`) ?? 0) + it.rate);
    out.set(`${e.from}|${it.item}`, (out.get(`${e.from}|${it.item}`) ?? 0) + it.rate);
  }
  return { into, out };
}

describe('familyOf', () => {
  it('groups items into production families', () => {
    expect(familyOf('Desc_IronPlateReinforced_C')?.id).toBe('iron');
    expect(familyOf('Desc_SteelPlateReinforced_C')?.id).toBe('steel');
    expect(familyOf('Desc_Cable_C')?.id).toBe('copper');
    expect(familyOf('Desc_Motor_C')?.id).toBe('industrial');
    expect(familyOf('Desc_AluminumIngot_C')?.id).toBe('aluminum');
    expect(familyOf('Desc_Something_C')).toBeNull();
  });
});

describe.skipIf(!hasFixture('obsidian-gears.sav', 'en-US.json'))('flow graph on Obsidian Gears, 10 RIP + 5 Modular Frame', () => {
  it('has one box per extraction resource, recipe variant and delivery, and balanced edges', async () => {
    const { result, fluid } = await solve('obsidian-gears.sav', {
      targets: [{ item: 'Desc_IronPlateReinforced_C', ratePerMin: 10 }, { item: 'Desc_ModularFrame_C', ratePerMin: 5 }],
    });
    const g = buildFullGraph(result, label, fluid);
    expect(g.boxes.filter((b) => b.kind === 'raw').map((b) => b.id)).toEqual(['raw:Desc_OreIron_C']);
    expect(g.boxes.filter((b) => b.kind === 'recipe')).toHaveLength(result.buildings.length);
    expect(g.boxes.filter((b) => b.kind === 'out').map((b) => b.id).sort()).toEqual(['out:Desc_IronPlateReinforced_C', 'out:Desc_ModularFrame_C']);
    const { into, out } = edgeTotals(g.edges);
    // Every recipe receives exactly what it consumes and sends out exactly what it makes.
    result.buildings.forEach((b, i) => {
      for (const x of b.inputs) expect(into.get(`b:${i}|${x.item}`)).toBeCloseTo(x.ratePerMin, 6);
    });
    expect(into.get('out:Desc_ModularFrame_C|Desc_ModularFrame_C')).toBeCloseTo(5, 6);
    expect(out.get('raw:Desc_OreIron_C|Desc_OreIron_C')).toBeCloseTo(240, 4);
    // The whole chain is iron, so it forms one module; collapsing it leaves raw -> module -> deliveries.
    expect(g.modules.map((m) => m.id)).toEqual(['iron']);
    const c = collapse(g, new Set(), label);
    expect(c.boxes.map((b) => b.kind).sort()).toEqual(['module', 'out', 'out', 'raw']);
    expect(c.edges).toHaveLength(3);
    const toFrames = c.edges.find((e) => e.to === 'out:Desc_ModularFrame_C')!;
    expect(toFrames.from).toBe('mod:iron');
    expect(toFrames.items[0]!.rate).toBeCloseTo(5, 6);
  }, 30000);
});
