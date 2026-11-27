/**
 * Solver types. Three layers:
 *
 *   PlanningProblem  normalized, platform-free view of "what this save can build"
 *                    (built once per save by problem.ts from GameData + SaveSummary)
 *   PlanRequest      what the user asks for in one plan (targets, budgets, ...)
 *   PlanResult       JSON-serializable answer, with plain-language explanation
 *
 * Everything is keyed by ClassName. Rates are per minute; fluids are m³/min.
 */
import type { ItemForm, NodePurity } from '../gamedata/types';

// ---------------------------------------------------------------------------
// Planning problem (derived from game data + save)

export interface ProblemItem {
  id: string;
  form: ItemForm;
  fluid: boolean;
  isRaw: boolean;
}

export interface ProblemBuilding {
  id: string;
  /** MW at 100% clock, no Somersloops. Variable-power buildings use the recipe's average. */
  powerMW: number;
  powerExponent: number;
  boostPowerExponent: number;
  manufacturingSpeed: number;
  canOverclock: boolean;
  sloopSlots: number;
  /** Output gain per filled slot (e.g. 0.25 = +25%); already includes the Somersloop item factor. */
  boostPerSlot: number;
}

export interface ProblemRecipe {
  id: string;
  building: string;
  durationSec: number;
  ingredients: { item: string; amount: number }[];
  products: { item: string; amount: number }[];
  isAlternate: boolean;
  /** Average MW for variable-power buildings (constant + factor / 2). */
  averagePowerMW?: number;
}

export interface ProblemExtractor {
  id: string;
  kind: 'miner' | 'oil-extractor' | 'water-extractor';
  baseRatePerMin: number;
  powerMW: number;
  powerExponent: number;
  canOverclock: boolean;
  allowedForms: ItemForm[];
  allowedResources: string[];
}

/** Resource nodes of one resource and purity (miners / oil extractors). */
export interface NodeGroup {
  id: string;
  resource: string;
  purity: NodePurity;
  nodeIds: string[];
}

/** One Resource Well: a core plus its satellites; the pressurizer clock scales all of them. */
export interface WellGroup {
  id: string;
  coreId: string;
  resource: string;
  satellites: { id: string; purity: NodePurity }[];
}

export interface UnavailableRecipe {
  id: string;
  building: string;
  reason: 'recipe-locked' | 'building-locked';
  products: string[];
}

export interface PlanningProblem {
  schemaVersion: 1;
  provenance: { gameDataHash: string; saveName: string; sessionName: string; saveBuild: number };
  items: Record<string, ProblemItem>;
  buildings: Record<string, ProblemBuilding>;
  /** Recipes the save can run: recipe unlocked AND its building unlocked. */
  recipes: ProblemRecipe[];
  /** Production recipes the save cannot run yet, kept for explanations. */
  unavailableRecipes: UnavailableRecipe[];
  /** Unlocked extractors (miners, oil extractors, water extractor). */
  extractors: ProblemExtractor[];
  /** Unlocked resource-well setup, or null if pressurizer/extractor are locked. */
  wells: {
    pressurizer: { id: string; powerMW: number; powerExponent: number; canOverclock: boolean };
    extractor: { id: string; baseRatePerMin: number; powerMW: number };
  } | null;
  nodeGroups: NodeGroup[];
  wellGroups: WellGroup[];
  /** Raw resources that are not node-limited (water via Water Extractors). */
  unlimitedResources: string[];
  transport: {
    belt: { id: string; ratePerMin: number } | null;
    pipe: { id: string; ratePerMin: number } | null;
  };
  overclock: { unlocked: boolean; perShard: number; maxShards: number };
  productionBoost: { unlocked: boolean };
  purityMultiplier: Record<NodePurity, number>;
  holdings: { somersloops: number; powerShards: number; slugShardEquivalent: number };
  /**
   * Map-wide extraction capacity per raw resource (all nodes in the save, ignoring user
   * exclusions, best extractor in game data at 100%). Scarcity weight = 1 / this.
   */
  mapAvailability: Record<string, number>;
  /** Plain-language notes about values the problem builder had to assume. */
  assumptions: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Plan request

/**
 * Lexicographic objective levels. 'maximize' expands to one level per maximize request,
 * in request order. New objectives (e.g. AWESOME Sink points) are added to
 * objectives.ts and to this union; nothing else needs to change.
 */
export type ObjectiveKind = 'targets' | 'maximize' | 'scarcity' | 'power' | 'buildings';

export const DEFAULT_OBJECTIVE_ORDER: readonly ObjectiveKind[] = ['targets', 'maximize', 'scarcity', 'power', 'buildings'];

export interface PlanRequest {
  targets: { item: string; ratePerMin: number }[];
  maximize: { item: string }[];
  /** Free supplies of non-raw items ("I already produce 120 Iron Plate/min"). */
  manualInputs: { item: string; ratePerMin: number }[];
  /** Node ids (resource nodes or well satellites) the plan may not use. */
  excludedNodes: string[];
  rawCaps: { item: string; maxPerMin: number }[];
  /** Recipes the user turned off for this plan. */
  disabledRecipes: string[];
  objectiveOrder: ObjectiveKind[];
  budgets: { somersloops: number; powerShards: number };
}

export interface SolveOptions {
  /**
   * 'auto' runs the integer pass only when rounding the LP's fractional buildings would
   * break a budget or a node limit. 'on' always runs it; 'off' never does.
   */
  integerPass: 'auto' | 'on' | 'off';
  /** Per-level time limit for the integer pass, seconds. */
  integerTimeLimitSec: number;
  /** Relative MIP gap for the integer pass. */
  mipRelGap: number;
}

export const DEFAULT_SOLVE_OPTIONS: SolveOptions = { integerPass: 'auto', integerTimeLimitSec: 5, mipRelGap: 1e-4 };

// ---------------------------------------------------------------------------
// Result

export interface Variant {
  /** Clock as a fraction (1 = 100%). Below 1 only when a belt/pipe forces it. */
  clock: number;
  sloops: number;
  shards: number;
  /** Output multiplier from Somersloops (1 = none). */
  outputMultiplier: number;
  /** Power multiplier vs. 100% unboosted: clock^exp * outputMultiplier^boostExp. */
  powerMultiplier: number;
  /** True when the clock was reduced so no port exceeds the best belt/pipe. */
  beltLimited: boolean;
}

export interface LimitRef {
  kind: 'nodes' | 'well' | 'raw-cap' | 'somersloop-budget' | 'shard-budget';
  /** NodeGroup id, WellGroup id, item id, or 'somersloops'/'powerShards'. */
  id: string;
  resource?: string;
  purity?: NodePurity;
  capacity: number;
  used: number;
  /** Shadow price at the level where it was binding (objective units per unit of limit). */
  shadowPrice?: number;
}

export interface LevelResult {
  kind: ObjectiveKind;
  /** For 'maximize' levels: the item. */
  item?: string;
  sense: 'min' | 'max';
  value: number;
  unit: string;
  status: 'optimal' | 'time-limit' | 'unbounded' | 'infeasible' | 'error';
  /** Limits with a nonzero shadow price at this level: what stops it doing better. */
  binding: LimitRef[];
}

export interface BuildingLine {
  recipe: string;
  building: string;
  variant: Variant;
  /** Building-equivalents at the variant clock (fractional in the LP pass). */
  amount: number;
  /** Buildings to place. */
  count: number;
  /** Clock each placed building runs at (amount spread evenly over count). */
  clockEach: number;
  shardsEach: number;
  sloopsEach: number;
  inputs: { item: string; ratePerMin: number }[];
  outputs: { item: string; ratePerMin: number }[];
  powerMW: number;
}

export interface ExtractionLine {
  source: 'node' | 'well' | 'water';
  resource: string;
  groupId?: string;
  purity?: NodePurity;
  extractor: string;
  variant: Variant;
  amount: number;
  /** Nodes / wells / extractors to place. */
  count: number;
  clockEach: number;
  shardsEach: number;
  ratePerMin: number;
  powerMW: number;
  /** For wells: satellites in use. */
  satellites?: number;
}

export interface ItemFlow {
  item: string;
  produced: number;
  consumed: number;
  extracted: number;
  manualAvailable: number;
  manualUsed: number;
  delivered: number;
  target?: number;
  shortfall: number;
  surplus: number;
  /** Aggregate flow divided by the best unlocked belt/pipe. */
  lines?: { transport: string; count: number };
}

export interface BudgetUse {
  budget: number;
  available: number;
  used: number;
  where: { recipe?: string; resource?: string; building: string; count: number; each: number }[];
}

export interface Infeasibility {
  shortfalls: { item: string; target: number; achieved: number }[];
  /** Items no unlocked recipe or extractor can make, with reasons. */
  unreachable: { item: string; reasons: string[] }[];
  /**
   * Smallest limit increases that would meet every reachable target, preferring (in order)
   * budget up to what you hold, your own raw caps, budget beyond what you hold, and last
   * more nodes than the map has (i.e. not possible with current unlocks).
   */
  relaxation: { limit: LimitRef; extraNeeded: number; tier: 'budget' | 'cap' | 'over-holdings' | 'map' }[];
  binding: LimitRef[];
}

export interface PlanResult {
  schemaVersion: 1;
  status: 'optimal' | 'targets-not-met' | 'unbounded' | 'error';
  pass: 'lp' | 'integer';
  /** Integer pass hit its time limit: feasible, not proven optimal. */
  provenOptimal: boolean;
  levels: LevelResult[];
  buildings: BuildingLine[];
  extraction: ExtractionLine[];
  items: ItemFlow[];
  power: { linearMW: number; actualMW: number };
  buildingCount: number;
  budgets: { somersloops: BudgetUse; powerShards: BudgetUse };
  resources: { resource: string; used: number; available: number | null; mapAvailability: number | null; mapShare: number | null }[];
  infeasibility?: Infeasibility;
  explanation: string[];
  assumptions: string[];
  warnings: string[];
  provenance: { gameDataHash: string; saveBuild: number; solvedAt: string; solver: string };
}
