/**
 * Docs.json / <locale>.json parser. Produces a language-independent GameData
 * model keyed by ClassName, plus a Labels overlay for the file's language.
 * Any locale's file can build the model; numbers are identical across them.
 */
import { decodeText } from '../util/text-decode';
import { classNameFromPath, parseClassList, parseItemAmounts, parseUEText, asArray } from './ue-text';
import type {
  Extractor, ExtractorKind, GameData, Item, ItemForm, Labels, ProductionBuilding, Recipe, Schematic,
  ShardFactors, Transport, WellPressurizer,
} from './types';

type RawClass = Record<string, unknown> & { ClassName: string };
interface RawGroup { NativeClass: string; Classes: RawClass[] }

export class GameDataError extends Error {}

const FLUID_UNITS_PER_M3 = 1000;
/** Docs `mSpeed` for belts/lifts is twice the items-per-minute shown in game (Mk1: 120 -> 60/min). */
const BELT_SPEED_TO_ITEMS_PER_MIN = 0.5;

const ITEM_NATIVE_CLASSES = new Set([
  'FGItemDescriptor', 'FGResourceDescriptor', 'FGItemDescriptorBiomass', 'FGItemDescriptorNuclearFuel',
  'FGEquipmentDescriptor', 'FGConsumableDescriptor', 'FGPowerShardDescriptor', 'FGAmmoTypeProjectile',
  'FGAmmoTypeSpreadshot', 'FGAmmoTypeInstantHit', 'FGItemDescriptorPowerBoosterFuel',
]);
const PRODUCTION_NATIVE_CLASSES = new Set(['FGBuildableManufacturer', 'FGBuildableManufacturerVariablePower']);
const MANUAL_PRODUCERS = /^(BP_WorkBenchComponent_C|BP_WorkshopComponent_C|FGBuildableAutomatedWorkBench|BP_AutomatedWorkBench_C)$/;

function nativeName(nc: string): string {
  // "/Script/CoreUObject.Class'/Script/FactoryGame.FGRecipe'" -> "FGRecipe"
  const m = nc.match(/\.(\w+)'?$/);
  return m ? m[1]! : nc;
}

function str(c: RawClass, k: string): string {
  const v = c[k];
  return typeof v === 'string' ? v : '';
}
function num(c: RawClass, k: string, fallback = 0): number {
  const v = c[k];
  if (typeof v !== 'string' || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(c: RawClass, k: string): boolean { return str(c, k) === 'True'; }

function parseForm(v: string): ItemForm {
  switch (v) {
    case 'RF_SOLID': return 'solid';
    case 'RF_LIQUID': return 'liquid';
    case 'RF_GAS': return 'gas';
    default: return 'invalid';
  }
}

export function readDocsFile(bytes: Uint8Array): RawGroup[] {
  const { text } = decodeText(bytes);
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { throw new GameDataError(`Docs file is not valid JSON: ${(e as Error).message}`); }
  if (!Array.isArray(json) || !json.every((g) => g && typeof g.NativeClass === 'string' && Array.isArray(g.Classes))) {
    throw new GameDataError('Docs file does not look like Satisfactory Docs.json (expected [{NativeClass, Classes}])');
  }
  return json as RawGroup[];
}

/** Labels only (cheap); use with any locale file. */
export function parseLabels(groups: RawGroup[], language: string): Labels {
  const names = new Map<string, string>();
  const descriptions = new Map<string, string>();
  for (const g of groups) {
    for (const c of g.Classes) {
      const n = str(c, 'mDisplayName');
      if (n) names.set(c.ClassName, n);
      const d = str(c, 'mDescription');
      if (d) descriptions.set(c.ClassName, d);
    }
  }
  return { language, names, descriptions };
}

export function parseGameData(groups: RawGroup[]): GameData {
  const warnings: string[] = [];
  const byNative = new Map<string, RawClass[]>();
  for (const g of groups) {
    const n = nativeName(g.NativeClass);
    byNative.set(n, [...(byNative.get(n) ?? []), ...g.Classes]);
  }
  const classes = (n: string) => byNative.get(n) ?? [];

  // --- Items
  const items = new Map<string, Item>();
  for (const [nc, list] of byNative) {
    if (!ITEM_NATIVE_CLASSES.has(nc)) continue;
    for (const c of list) {
      items.set(c.ClassName, {
        className: c.ClassName,
        nativeClass: nc,
        form: parseForm(str(c, 'mForm')),
        isRawResource: nc === 'FGResourceDescriptor',
        stackSize: num(c, 'mCachedStackSize'),
        energyMJ: num(c, 'mEnergyValue'),
        sinkPoints: num(c, 'mResourceSinkPoints'),
        radioactiveDecay: num(c, 'mRadioactiveDecay'),
      });
    }
  }
  const isFluid = (cls: string) => { const f = items.get(cls)?.form; return f === 'liquid' || f === 'gas'; };
  const toUnits = (cls: string, amount: number) => (isFluid(cls) ? amount / FLUID_UNITS_PER_M3 : amount);

  // --- Production buildings
  const buildings = new Map<string, ProductionBuilding>();
  for (const nc of PRODUCTION_NATIVE_CLASSES) {
    for (const c of classes(nc)) {
      const canBoost = bool(c, 'mCanChangeProductionBoost');
      const overrides = bool(c, 'mOverrideProductionShardSlotSize');
      const slots = !canBoost ? 0 : overrides ? num(c, 'mProductionShardSlotSize') : DEFAULT_SLOOP_SLOTS.value;
      buildings.set(c.ClassName, {
        className: c.ClassName,
        nativeClass: nc,
        powerMW: num(c, 'mPowerConsumption'),
        variablePower: nc === 'FGBuildableManufacturerVariablePower',
        powerExponent: num(c, 'mPowerConsumptionExponent', 1),
        boostPowerExponent: num(c, 'mProductionBoostPowerConsumptionExponent', 1),
        manufacturingSpeed: num(c, 'mManufacturingSpeed', 1),
        canOverclock: bool(c, 'mCanChangePotential'),
        sloopSlots: slots,
        sloopBoostPerSlot: canBoost ? num(c, 'mProductionShardBoostMultiplier') : 0,
        sloopSlotsFromConstant: canBoost && !overrides,
      });
    }
  }

  // --- Extractors
  const extractors = new Map<string, Extractor>();
  const pressurizers = new Map<string, WellPressurizer>();
  const extractorKind = (nc: string, c: RawClass): ExtractorKind | undefined => {
    if (nc === 'FGBuildableWaterPump') return 'water-extractor';
    if (nc === 'FGBuildableFrackingExtractor') return 'well-extractor';
    if (nc === 'FGBuildableResourceExtractor') {
      return str(c, 'mAllowedResourceForms').includes('RF_SOLID') ? 'miner' : 'oil-extractor';
    }
    return undefined;
  };
  for (const nc of ['FGBuildableResourceExtractor', 'FGBuildableWaterPump', 'FGBuildableFrackingExtractor']) {
    for (const c of classes(nc)) {
      const kind = extractorKind(nc, c);
      if (!kind) continue;
      const forms = asArray(parseUEText(str(c, 'mAllowedResourceForms'))).filter((x): x is string => typeof x === 'string').map(parseForm).filter((f) => f !== 'invalid');
      const cycle = num(c, 'mExtractCycleTime');
      const perCycle = num(c, 'mItemsPerCycle');
      const fluid = forms.length > 0 && forms.every((f) => f === 'liquid' || f === 'gas');
      if (cycle <= 0) { warnings.push(`${c.ClassName}: non-positive extract cycle time; skipped`); continue; }
      extractors.set(c.ClassName, {
        className: c.ClassName,
        kind,
        baseRatePerMin: (60 / cycle) * (fluid ? perCycle / FLUID_UNITS_PER_M3 : perCycle),
        allowedForms: forms,
        allowedResources: parseClassList(str(c, 'mAllowedResources')),
        powerMW: num(c, 'mPowerConsumption'),
        powerExponent: num(c, 'mPowerConsumptionExponent', 1),
        canOverclock: bool(c, 'mCanChangePotential'),
      });
    }
  }
  for (const c of classes('FGBuildableFrackingActivator')) {
    pressurizers.set(c.ClassName, {
      className: c.ClassName,
      powerMW: num(c, 'mPowerConsumption'),
      powerExponent: num(c, 'mPowerConsumptionExponent', 1),
      canOverclock: bool(c, 'mCanChangePotential'),
    });
  }

  // --- Transport
  const transports = new Map<string, Transport>();
  for (const c of classes('FGBuildableConveyorBelt')) transports.set(c.ClassName, { className: c.ClassName, kind: 'belt', ratePerMin: num(c, 'mSpeed') * BELT_SPEED_TO_ITEMS_PER_MIN });
  for (const c of classes('FGBuildableConveyorLift')) transports.set(c.ClassName, { className: c.ClassName, kind: 'lift', ratePerMin: num(c, 'mSpeed') * BELT_SPEED_TO_ITEMS_PER_MIN });
  for (const c of classes('FGBuildablePipeline')) transports.set(c.ClassName, { className: c.ClassName, kind: 'pipe', ratePerMin: num(c, 'mFlowLimit') * 60 });

  // --- Schematics
  const schematics = new Map<string, Schematic>();
  for (const c of classes('FGSchematic')) {
    const unlocks = Array.isArray(c['mUnlocks']) ? (c['mUnlocks'] as RawClass[]) : [];
    const deps = Array.isArray(c['mSchematicDependencies']) ? (c['mSchematicDependencies'] as RawClass[]) : [];
    const s: Schematic = {
      className: c.ClassName,
      type: str(c, 'mType').replace(/^EST_/, ''),
      tier: num(c, 'mTechTier'),
      cost: [],
      unlocksRecipes: [],
      unlocksSchematics: [],
      unlocksOverclock: false,
      unlocksProductionBoost: false,
      dependsOn: [],
    };
    try {
      s.cost = parseItemAmounts(str(c, 'mCost')).map((a) => ({ item: a.className, amount: toUnits(a.className, a.amount) }));
    } catch (e) { warnings.push(`${c.ClassName}: unreadable mCost (${(e as Error).message})`); }
    for (const u of unlocks) {
      const cls = String(u['Class'] ?? '');
      try {
        if (cls === 'BP_UnlockRecipe_C') s.unlocksRecipes.push(...parseClassList(str(u as RawClass, 'mRecipes')));
        else if (cls === 'BP_UnlockSchematic_C') s.unlocksSchematics.push(...parseClassList(str(u as RawClass, 'mSchematics')));
        else if (cls === 'BP_UnlockBuildOverclock_C') s.unlocksOverclock = true;
        else if (cls === 'BP_UnlockBuildProductionBoost_C') s.unlocksProductionBoost = true;
      } catch (e) { warnings.push(`${c.ClassName}: unreadable unlock ${cls} (${(e as Error).message})`); }
    }
    for (const d of deps) {
      if (d['Class'] === 'BP_SchematicPurchasedDependency_C') {
        try { s.dependsOn.push(...parseClassList(str(d as RawClass, 'mSchematics'))); } catch { /* ignore */ }
      }
    }
    schematics.set(c.ClassName, s);
  }
  const alternateRecipes = new Set<string>();
  for (const s of schematics.values()) if (s.type === 'Alternate') s.unlocksRecipes.forEach((r) => alternateRecipes.add(r));

  // --- Build-gun recipes for modeled buildables (unlock detection). Docs names a placed
  // building's descriptor Desc_X_C and the buildable Build_X_C; match case-insensitively
  // (Docs spells some inconsistently, e.g. Desc_PipelinePumpMk2_C / Build_PipelinePumpMK2_C).
  const buildableByKey = new Map<string, string>();
  for (const m of [buildings, extractors, pressurizers, transports]) {
    for (const k of m.keys()) buildableByKey.set(k.replace(/^Build_/, '').toLowerCase(), k);
  }
  const buildRecipes = new Map<string, string[]>();

  // --- Recipes (production + hand-craft only; build-gun/customizer recipes are not production)
  const recipes = new Map<string, Recipe>();
  for (const c of classes('FGRecipe')) {
    let producers: string[];
    try { producers = parseClassList(str(c, 'mProducedIn')); }
    catch (e) { warnings.push(`${c.ClassName}: unreadable mProducedIn (${(e as Error).message})`); continue; }
    if (producers.some((p) => /BuildGun/.test(p))) {
      try {
        const placed = parseItemAmounts(str(c, 'mProduct'))
          .map((a) => buildableByKey.get(a.className.replace(/^Desc_/, '').toLowerCase()))
          .filter((b): b is string => !!b);
        if (placed.length) buildRecipes.set(c.ClassName, placed);
      } catch { /* not a buildable we model */ }
    }
    const machines = producers.filter((p) => buildings.has(p));
    const manual = producers.some((p) => MANUAL_PRODUCERS.test(p));
    if (machines.length === 0 && !manual) continue;
    let ingredients, products;
    try {
      ingredients = parseItemAmounts(str(c, 'mIngredients')).map((a) => ({ item: a.className, amount: toUnits(a.className, a.amount) }));
      products = parseItemAmounts(str(c, 'mProduct')).map((a) => ({ item: a.className, amount: toUnits(a.className, a.amount) }));
    } catch (e) { warnings.push(`${c.ClassName}: unreadable ingredients/products (${(e as Error).message})`); continue; }
    for (const a of [...ingredients, ...products]) {
      if (!items.has(a.item)) warnings.push(`${c.ClassName}: references unknown item ${a.item}`);
    }
    const isVariable = machines.some((m) => buildings.get(m)!.variablePower);
    recipes.set(c.ClassName, {
      className: c.ClassName,
      ingredients,
      products,
      durationSec: num(c, 'mManufactoringDuration'),
      producedIn: machines,
      manualOnly: machines.length === 0,
      isAlternate: alternateRecipes.has(c.ClassName),
      ...(isVariable ? { variablePower: { constantMW: num(c, 'mVariablePowerConsumptionConstant'), factorMW: num(c, 'mVariablePowerConsumptionFactor') } } : {}),
    });
  }

  // --- Shard / Somersloop factors
  const shardClasses = classes('FGPowerShardDescriptor');
  const overclockShard = shardClasses.find((c) => str(c, 'mPowerShardType') === 'PST_Overclock');
  const boostShard = shardClasses.find((c) => str(c, 'mPowerShardType') === 'PST_ProductionBoost');
  if (!overclockShard || !boostShard) throw new GameDataError('Docs file lacks Power Shard / Somersloop descriptors (FGPowerShardDescriptor)');
  const shards: ShardFactors = {
    overclockPerShard: num(overclockShard, 'mExtraPotential'),
    sloopExtraBoost: num(boostShard, 'mExtraProductionBoost'),
    powerShardItem: overclockShard.ClassName,
    somersloopItem: boostShard.ClassName,
  };

  if (recipes.size === 0 || buildings.size === 0) throw new GameDataError('No production recipes/buildings found; is this a Docs.json file?');

  const model = { items, recipes, buildings, extractors, pressurizers, transports, schematics, buildRecipes, shards };
  return {
    ...model,
    constants: {
      purityMultiplier: PURITY_MULTIPLIER,
      powerShardSlots: POWER_SHARD_SLOTS,
      defaultSloopSlots: DEFAULT_SLOOP_SLOTS,
    },
    contentHash: hashModel(model),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Engine constants that Docs.json does not expose. Each is surfaced as an
// assumption wherever it affects a result.

export const PURITY_MULTIPLIER = {
  value: { impure: 0.5, normal: 1, pure: 2 },
  note: 'Node purity multipliers are engine constants (EResourcePurity); Docs.json does not list them.',
} as const;

export const POWER_SHARD_SLOTS = {
  value: 3,
  note: 'Docs.json reports mPotentialShardSlots=0 without override for every building; the engine default of 3 slots is used (max clock = 100% + 3 x mExtraPotential).',
} as const;

export const DEFAULT_SLOOP_SLOTS = {
  value: 1,
  note: 'Buildings with mOverrideProductionShardSlotSize=False (Constructor, Smelter) use the engine default of 1 Somersloop slot.',
} as const;

// ---------------------------------------------------------------------------

function hashModel(model: object): string {
  const canon = JSON.stringify(model, (_k, v) => {
    if (v instanceof Map) return [...v.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return v;
  });
  return cyrb53(canon).toString(16).padStart(14, '0');
}

/** 53-bit non-cryptographic string hash (cyrb53). Sufficient for change detection. */
function cyrb53(s: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export { classNameFromPath };
