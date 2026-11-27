/**
 * Game data model, keyed by ClassName everywhere. Display text lives only in
 * `Labels`, so swapping languages never changes the model.
 *
 * Units: item amounts are per craft in game units; fluids are converted from
 * the engine's litres-in-Docs (1000 = 1 m³) to m³. Rates are per minute.
 */

export type ItemForm = 'solid' | 'liquid' | 'gas' | 'invalid';

export interface Item {
  className: string;
  nativeClass: string;
  form: ItemForm;
  /** True for FGResourceDescriptor classes (ores, oil, water, gases, SAM...). */
  isRawResource: boolean;
  stackSize: number;
  energyMJ: number;
  sinkPoints: number;
  radioactiveDecay: number;
}

export interface ItemAmount { item: string; amount: number; }

export interface Recipe {
  className: string;
  ingredients: ItemAmount[];
  products: ItemAmount[];
  durationSec: number;
  /** Production buildings (Build_*) that can run it; empty => build-gun/hand-only. */
  producedIn: string[];
  /** Workbench/workshop/build gun only. */
  manualOnly: boolean;
  isAlternate: boolean;
  /** For variable-power buildings: average MW = constant + factor / 2. */
  variablePower?: { constantMW: number; factorMW: number };
}

export interface ProductionBuilding {
  className: string;
  nativeClass: string;
  powerMW: number;
  /** Variable-power buildings take power from the recipe instead. */
  variablePower: boolean;
  powerExponent: number;
  boostPowerExponent: number;
  manufacturingSpeed: number;
  canOverclock: boolean;
  /** Somersloop slots (0 if production boost is not allowed). */
  sloopSlots: number;
  /** Production boost per slotted Somersloop (fraction, e.g. 0.25 = +25%). */
  sloopBoostPerSlot: number;
  sloopSlotsFromConstant: boolean;
}

export type ExtractorKind = 'miner' | 'oil-extractor' | 'water-extractor' | 'well-extractor';

export interface Extractor {
  className: string;
  kind: ExtractorKind;
  /** Rate at 100% clock on a normal-purity node (per minute, m³ for fluids). */
  baseRatePerMin: number;
  allowedForms: ItemForm[];
  /** Explicit resource whitelist; empty = any raw resource of an allowed form. */
  allowedResources: string[];
  powerMW: number;
  powerExponent: number;
  canOverclock: boolean;
}

/** Resource Well Pressurizer: activates a well; its clock scales every satellite. */
export interface WellPressurizer {
  className: string;
  powerMW: number;
  powerExponent: number;
  canOverclock: boolean;
}

export interface Transport {
  className: string;
  kind: 'belt' | 'lift' | 'pipe';
  ratePerMin: number;
}

export type SchematicType =
  | 'Milestone' | 'MAM' | 'Alternate' | 'ResourceSink' | 'Custom' | 'Customization' | 'Tutorial' | 'HardDrive' | string;

export interface Schematic {
  className: string;
  type: SchematicType;
  tier: number;
  cost: ItemAmount[];
  unlocksRecipes: string[];
  unlocksSchematics: string[];
  unlocksOverclock: boolean;
  unlocksProductionBoost: boolean;
  dependsOn: string[];
}

export interface ShardFactors {
  /** Extra clock per Power Shard (0.5 = +50%). */
  overclockPerShard: number;
  /** Extra production boost per Somersloop item (multiplied by the building's per-slot factor). */
  sloopExtraBoost: number;
  powerShardItem: string;
  somersloopItem: string;
}

export interface EngineConstant<T> {
  value: T;
  /** Why this is not read from Docs.json. Surfaced in the UI as an assumption. */
  note: string;
}

export interface GameData {
  items: Map<string, Item>;
  recipes: Map<string, Recipe>;
  buildings: Map<string, ProductionBuilding>;
  extractors: Map<string, Extractor>;
  pressurizers: Map<string, WellPressurizer>;
  transports: Map<string, Transport>;
  schematics: Map<string, Schematic>;
  /**
   * Build-gun recipes that place a modeled buildable (production building, extractor,
   * pressurizer, belt/lift/pipe): recipe ClassName -> buildable ClassNames. A buildable
   * is unlocked when one of its build recipes is in the save's unlocked-recipe list.
   */
  buildRecipes: Map<string, string[]>;
  shards: ShardFactors;
  constants: {
    purityMultiplier: EngineConstant<Record<NodePurity, number>>;
    powerShardSlots: EngineConstant<number>;
    defaultSloopSlots: EngineConstant<number>;
  };
  /** Stable hash of the parsed model (language-independent). */
  contentHash: string;
  warnings: string[];
}

export type NodePurity = 'impure' | 'normal' | 'pure';

export interface Labels {
  language: string;
  names: Map<string, string>;
  descriptions: Map<string, string>;
}
