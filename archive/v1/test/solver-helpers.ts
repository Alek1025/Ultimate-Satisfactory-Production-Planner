import highsLoader from 'highs';
import { createHighsBackend } from '../src/solver/lp/highs-backend';
import { DEFAULT_OBJECTIVE_ORDER, type PlanningProblem, type PlanRequest } from '../src/solver/types';

export const backend = createHighsBackend(() => highsLoader());

export function request(r: Partial<PlanRequest> = {}): PlanRequest {
  return {
    targets: [], maximize: [], manualInputs: [], excludedNodes: [], rawCaps: [], disabledRecipes: [],
    objectiveOrder: [...DEFAULT_OBJECTIVE_ORDER], budgets: { somersloops: 0, powerShards: 0 }, ...r,
  };
}

const EXP = 1.321929;

/**
 * Small hand-made world (numbers chosen so results can be checked by hand):
 *   Ore (raw, 2 pure + 2 normal nodes), Water (unlimited, fluid), Ingot, Plate, Gizmo.
 *   Miner 60/min normal; belt 120/min; pipe 300 m³/min.
 *   Ingot:     1 Ore -> 1 Ingot, 2 s            (Smelter, 1 Somersloop slot, +100%)
 *   Plate:     3 Ingot -> 2 Plate, 6 s          (Constructor, 1 slot)
 *   WetPlate:  4 Ingot + 2 Water -> 3 Plate, 6 s (alternate; less Ore per Plate)
 *   Gizmo:     needs Unobtainium (no source, recipe locked)
 */
export function toyProblem(over: Partial<PlanningProblem> = {}): PlanningProblem {
  const item = (id: string, form: 'solid' | 'liquid', isRaw = false) => ({ id, form, fluid: form === 'liquid', isRaw });
  const p: PlanningProblem = {
    schemaVersion: 1,
    provenance: { gameDataHash: 'toy', saveName: 'toy', sessionName: 'toy', saveBuild: 0 },
    items: {
      Ore: item('Ore', 'solid', true), Water: item('Water', 'liquid', true), Ingot: item('Ingot', 'solid'),
      Plate: item('Plate', 'solid'), Gizmo: item('Gizmo', 'solid'), Unobtainium: item('Unobtainium', 'solid'),
    },
    buildings: {
      Smelter: { id: 'Smelter', powerMW: 4, powerExponent: EXP, boostPowerExponent: 2, manufacturingSpeed: 1, canOverclock: true, sloopSlots: 1, boostPerSlot: 1 },
      Constructor: { id: 'Constructor', powerMW: 4, powerExponent: EXP, boostPowerExponent: 2, manufacturingSpeed: 1, canOverclock: true, sloopSlots: 1, boostPerSlot: 1 },
    },
    recipes: [
      { id: 'Ingot', building: 'Smelter', durationSec: 2, ingredients: [{ item: 'Ore', amount: 1 }], products: [{ item: 'Ingot', amount: 1 }], isAlternate: false },
      { id: 'Plate', building: 'Constructor', durationSec: 6, ingredients: [{ item: 'Ingot', amount: 3 }], products: [{ item: 'Plate', amount: 2 }], isAlternate: false },
      { id: 'WetPlate', building: 'Constructor', durationSec: 6, ingredients: [{ item: 'Ingot', amount: 4 }, { item: 'Water', amount: 2 }], products: [{ item: 'Plate', amount: 3 }], isAlternate: true },
    ],
    unavailableRecipes: [{ id: 'Gizmo', building: 'Constructor', reason: 'recipe-locked', products: ['Gizmo'] }],
    extractors: [
      { id: 'Miner', kind: 'miner', baseRatePerMin: 60, powerMW: 5, powerExponent: EXP, canOverclock: true, allowedForms: ['solid'], allowedResources: [] },
      { id: 'WaterPump', kind: 'water-extractor', baseRatePerMin: 120, powerMW: 20, powerExponent: EXP, canOverclock: true, allowedForms: ['liquid'], allowedResources: ['Water'] },
    ],
    wells: null,
    nodeGroups: [
      { id: 'Ore:pure', resource: 'Ore', purity: 'pure', nodeIds: ['p1', 'p2'] },
      { id: 'Ore:normal', resource: 'Ore', purity: 'normal', nodeIds: ['n1', 'n2'] },
    ],
    wellGroups: [],
    unlimitedResources: ['Water'],
    transport: { belt: { id: 'Belt', ratePerMin: 120 }, pipe: { id: 'Pipe', ratePerMin: 300 } },
    overclock: { unlocked: true, perShard: 0.5, maxShards: 3 },
    productionBoost: { unlocked: true },
    purityMultiplier: { impure: 0.5, normal: 1, pure: 2 },
    holdings: { somersloops: 4, powerShards: 10, slugShardEquivalent: 0 },
    mapAvailability: { Ore: 2 * 2 * 60 + 2 * 60 },
    assumptions: [],
    warnings: [],
    ...over,
  };
  return p;
}
