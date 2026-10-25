/**
 * Interpret a parsed save into the planner's SaveSummary, using GameData for
 * classification (schematic types, tiers, slug -> shard recipes).
 */
import type { GameData, ItemAmount, NodePurity } from '../gamedata/types';
import type { ObjectRef, Property, PropertyBag, StructValue } from './properties';
import type { ParsedSave, SaveObject } from './save-reader';
import { readSave } from './save-reader';
import type { Holdings, NodePuritySetting, SaveNode, SaveSummary, Setting, VersionCheck } from './summary-types';

/** Save versions written by Update 1.2 builds we have verified against. */
export const SUPPORTED_SAVE_VERSIONS = new Set([60]);

const NODE_CLASSES: Record<string, SaveNode['kind']> = {
  BP_ResourceNode_C: 'resource-node',
  BP_FrackingSatellite_C: 'well-satellite',
  BP_FrackingCore_C: 'well-core',
  BP_ResourceNodeGeyser_C: 'geyser',
};

const SLUG_ITEMS = { blue: 'Desc_Crystal_C', yellow: 'Desc_Crystal_mk2_C', purple: 'Desc_Crystal_mk3_C' } as const;

const KNOWN_GAMESTATE_SETTINGS = new Set([
  'mPartsCostMultiplier', 'mSpacePartsCostMultiplier', 'mNodePuritySettings', 'mNodeRandomization', 'mNodeRandomizationSeed',
]);
const SETTING_LIKE = /Multiplier|Purity|Seed|Randomi|GameMode|Difficulty|Rules?$|Setting/i;

// ---------------------------------------------------------------------------
// Small accessors over the generic property bag

const val = (bag: PropertyBag, name: string): unknown => bag[name]?.value;

function asRef(v: unknown): ObjectRef | undefined {
  return v && typeof v === 'object' && 'pathName' in v ? (v as ObjectRef) : undefined;
}
function refList(v: unknown): ObjectRef[] {
  return Array.isArray(v) ? v.map(asRef).filter((r): r is ObjectRef => !!r) : [];
}
/** "/Game/.../Schematic_2-1.Schematic_2-1_C" -> "Schematic_2-1_C" */
export function classOfPath(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1) : path.slice(path.lastIndexOf('/') + 1);
}
function structFields(v: unknown): PropertyBag | undefined {
  if (v && typeof v === 'object' && 'struct' in v) {
    const inner = (v as StructValue).value;
    if (inner && typeof inner === 'object' && !('raw' in inner)) return inner as PropertyBag;
  }
  return undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function parsePurity(v: unknown): NodePurity | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/^.*::/, '');
  if (s === 'RP_Pure') return 'pure';
  if (s === 'RP_Normal') return 'normal';
  if (s === 'RP_Inpure' || s === 'RP_Impure') return 'impure'; // the engine enum is spelled "Inpure"
  return undefined;
}

function parsePuritySetting(v: string): NodePuritySetting {
  const s = v.replace(/^.*::/, '');
  if (s === 'NPS_AllPure') return 'all-pure';
  if (/Random/i.test(s)) return 'random';
  if (s === 'NPS_Default') return 'default';
  return 'unknown';
}

// ---------------------------------------------------------------------------

export function checkVersion(saveVersion: number, buildVersion: number, branch: string): VersionCheck {
  const label = `save v${saveVersion}, build ${buildVersion}${branch ? ` (${branch.replace(/^\+\+FactoryGame\+/, '')})` : ''}`;
  if (SUPPORTED_SAVE_VERSIONS.has(saveVersion)) return { status: 'supported', gameVersion: `Update 1.2 — ${label}` };
  if (saveVersion < Math.min(...SUPPORTED_SAVE_VERSIONS)) {
    return {
      status: 'warning', gameVersion: `pre-1.2 — ${label}`,
      message: 'This save is from a game version older than Update 1.2. It was loaded, but recipes and Game Mode settings may differ from the 1.2 game data.',
    };
  }
  return {
    status: 'warning', gameVersion: `newer than verified 1.2 — ${label}`,
    message: 'This save is newer than the Update 1.2 saves this planner was verified against. It was loaded, but some data may be missing or misread.',
  };
}

/** Stages of reading a save, in order; 'objects' also reports a 0..1 fraction. */
export type SaveStage = 'header' | 'decompress' | 'objects' | 'summary';

export interface SummarizeOptions {
  /** Called as reading moves through each stage (for progress UI; runs synchronously). */
  onStage?: (stage: SaveStage, fraction?: number) => void;
}

export function summarizeSaveBytes(bytes: Uint8Array, gameData: GameData, options: SummarizeOptions = {}): SaveSummary {
  const onStage = options.onStage;
  onStage?.('header');
  const save = readSave(bytes, onStage ? {
    onProgress: (fraction, message) => {
      if (message === 'Decompressing') onStage('decompress');
      else if (message !== 'Done') onStage('objects', fraction);
    },
  } : {});
  onStage?.('summary');
  return summarizeSave(save, gameData);
}

export function summarizeSave(save: ParsedSave, gd: GameData): SaveSummary {
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const { header, versionData } = save;

  const persistent = save.levels.find((l) => l.name === header.mapName);
  if (!persistent) throw new Error(`Save has no persistent level "${header.mapName}"`);
  const byClass = new Map<string, SaveObject[]>();
  const byInstance = new Map<string, SaveObject>();
  for (const l of save.levels) {
    for (const o of l.objects) {
      const list = byClass.get(o.className);
      if (list) list.push(o); else byClass.set(o.className, [o]);
      byInstance.set(o.instanceName, o);
    }
  }
  const single = (cls: string): SaveObject | undefined => {
    const list = byClass.get(cls);
    if (!list?.length) { warnings.push(`Save has no ${cls}; related data treated as empty.`); return undefined; }
    if (list.length > 1) warnings.push(`Save has ${list.length} ${cls} objects; using the first.`);
    return list[0];
  };

  // --- Version
  const version = checkVersion(header.saveVersion, header.buildVersion, versionData.engine.branch);
  if (version.message) warnings.push(version.message);
  if (header.isModded) warnings.push('This is a modded save. Modded items and recipes are not in the base game data and are ignored.');

  // --- Game mode (BP_GameState_C)
  const gs = single('BP_GameState_C');
  const gsProps = gs?.properties ?? {};
  const numSetting = (name: string, label: string): Setting<number> => {
    const p = gsProps[name];
    const n = num(p?.value);
    if (n === undefined) {
      assumptions.push(`${label}: not stored in the save, so the default (x1) is used.`);
      return { value: 1, source: 'default' };
    }
    return { value: n, source: 'save', raw: p?.value };
  };
  const partsCostMultiplier = numSetting('mPartsCostMultiplier', 'Milestone/research cost multiplier');
  const spacePartsCostMultiplier = numSetting('mSpacePartsCostMultiplier', 'Space Elevator cost multiplier');
  const purityRaw = val(gsProps, 'mNodePuritySettings');
  const nodePurity: Setting<NodePuritySetting> = typeof purityRaw === 'string'
    ? { value: parsePuritySetting(purityRaw), source: 'save', raw: purityRaw }
    : { value: 'default', source: 'default' };
  if (nodePurity.value === 'unknown') warnings.push(`Unrecognized node purity setting "${String(purityRaw)}". Per-node purity overrides in the save are still applied.`);
  const randRaw = val(gsProps, 'mNodeRandomization');
  const nodeRandomization: Setting<string> = typeof randRaw === 'string'
    ? { value: randRaw.replace(/^.*::NRM_/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(), source: 'save', raw: randRaw }
    : { value: 'off', source: 'default' };
  const seedRaw = num(val(gsProps, 'mNodeRandomizationSeed'));
  const nodeRandomizationSeed: Setting<number | null> = seedRaw === undefined
    ? { value: null, source: 'default' } : { value: seedRaw, source: 'save' };
  const unrecognized: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(gsProps)) {
    if (KNOWN_GAMESTATE_SETTINGS.has(k) || !SETTING_LIKE.test(k)) continue;
    unrecognized[k] = simpleValue(p);
  }
  if (Object.keys(unrecognized).length) {
    warnings.push(`Game Mode settings the planner does not interpret yet: ${Object.keys(unrecognized).join(', ')}. Results may not reflect them.`);
  }

  // --- Progression
  const sm = single('BP_SchematicManager_C');
  const purchased = refList(val(sm?.properties ?? {}, 'mPurchasedSchematics')).map((r) => classOfPath(r.pathName));
  const milestones: string[] = [], mam: string[] = [], alternates: string[] = [], shop: string[] = [], other: string[] = [];
  let highestTier = 0, overclockUnlocked = false, productionBoostUnlocked = false;
  const unknownSchematics: string[] = [];
  for (const cls of purchased) {
    const s = gd.schematics.get(cls);
    if (!s) { unknownSchematics.push(cls); other.push(cls); continue; }
    if (s.unlocksOverclock) overclockUnlocked = true;
    if (s.unlocksProductionBoost) productionBoostUnlocked = true;
    switch (s.type) {
      case 'Milestone': milestones.push(cls); highestTier = Math.max(highestTier, s.tier); break;
      case 'MAM': mam.push(cls); break;
      case 'Alternate': alternates.push(cls); break;
      case 'ResourceSink': shop.push(cls); break;
      default: other.push(cls);
    }
  }
  if (unknownSchematics.length) {
    warnings.push(`${unknownSchematics.length} purchased schematic(s) are not in the loaded game data (e.g. ${unknownSchematics.slice(0, 3).join(', ')}). The game data may be from a different version.`);
  }
  // Cross-check feature flags with the unlock subsystem (authoritative when present).
  const us = byClass.get('BP_UnlockSubsystem_C')?.[0];
  if (us) {
    const oc = val(us.properties, 'mIsBuildingOverclockUnlocked');
    const pb = val(us.properties, 'mIsBuildingProductionBoostUnlocked');
    if (typeof oc === 'boolean') overclockUnlocked = oc;
    if (typeof pb === 'boolean') productionBoostUnlocked = pb;
  }

  const rm = single('FGRecipeManager');
  const unlockedRecipes = refList(val(rm?.properties ?? {}, 'mAvailableRecipes')).map((r) => classOfPath(r.pathName));
  const unlockedAlternateRecipes = unlockedRecipes.filter((r) => gd.recipes.get(r)?.isAlternate);

  const pm = single('BP_GamePhaseManager_C');
  const phaseProps = pm?.properties ?? {};
  const currentPhase = asRef(val(phaseProps, 'mCurrentGamePhase'))?.pathName;
  const targetPhase = asRef(val(phaseProps, 'mTargetGamePhase'))?.pathName;
  const paid: ItemAmount[] = [];
  const paidList = val(phaseProps, 'mTargetGamePhasePaidOffCosts');
  if (Array.isArray(paidList)) {
    for (const e of paidList) {
      const f = structFields(e);
      const item = f && asRef(f['ItemClass']?.value);
      const amount = f && num(f['Amount']?.value);
      if (item && amount !== undefined) paid.push({ item: classOfPath(item.pathName), amount });
    }
  }
  const phaseIndex = (p?: string) => { const m = p?.match(/Phase_(\d+)/); return m ? Number(m[1]) : undefined; };
  if (!currentPhase) assumptions.push('No current Space Elevator phase stored; assuming the game has not started Project Assembly (phase 0).');

  const activeMilestone = asRef(val(sm?.properties ?? {}, 'mActiveSchematic'))?.pathName;

  // --- Holdings
  const holdings = countHoldings(save, byInstance, gd, warnings);

  // --- Nodes
  const nodes: SaveNode[] = [];
  for (const [cls, kind] of Object.entries(NODE_CLASSES)) {
    for (const o of byClass.get(cls) ?? []) {
      if (o.kind !== 'entity' || !o.transform) continue;
      const purityOverride = parsePurity(val(o.properties, 'mPurityOverride'));
      const left = num(val(o.properties, 'mResourcesLeft'));
      const resRef = asRef(val(o.properties, 'mResourceClassOverride'));
      const t = o.transform.translation;
      nodes.push({
        id: o.instanceName.replace(/^.*\./, ''),
        kind,
        position: [t[0]!, t[1]!, t[2]!],
        ...(purityOverride ? { purityOverride } : {}),
        ...(resRef?.pathName ? { resourceOverride: classOfPath(resRef.pathName) } : {}),
        ...(left !== undefined ? { resourcesLeft: left } : {}),
      });
    }
  }
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const extractable = nodes.filter((n) => n.kind === 'resource-node' || n.kind === 'well-satellite');
  const overridden = extractable.filter((n) => n.purityOverride).length;
  if (nodePurity.value !== 'default' && overridden < extractable.length) {
    warnings.push(`Node purity is "${nodePurity.value}" but only ${overridden} of ${extractable.length} extractable nodes store a purity override; the rest fall back to map purity.`);
  }
  const withResource = extractable.filter((n) => n.resourceOverride).length;
  const unknownRes = nodes.filter((n) => n.resourceOverride && !gd.items.get(n.resourceOverride)?.isRawResource);
  if (unknownRes.length) warnings.push(`${unknownRes.length} node(s) have a resource override that is not a raw resource in the game data (e.g. ${unknownRes[0]!.resourceOverride}).`);
  if (nodeRandomization.value !== 'off' && withResource < extractable.length) {
    warnings.push(`Node randomization is "${nodeRandomization.value}" but only ${withResource} of ${extractable.length} extractable nodes store a resource override; the rest fall back to the map's resource.`);
  }
  if (withResource < extractable.length) {
    assumptions.push(`${extractable.length - withResource} node(s) have no resource stored in the save (the game uses the map default); their resource type comes from the node catalog.`);
  }
  if (overridden < extractable.length) {
    assumptions.push(`${extractable.length - overridden} node(s) have no purity stored in the save (the game uses the map default); their purity comes from the node catalog.`);
  }

  return {
    schemaVersion: 1,
    source: {
      saveName: header.saveName,
      sessionName: header.sessionName,
      headerVersion: header.headerVersion,
      saveVersion: header.saveVersion,
      buildVersion: header.buildVersion,
      engine: `${versionData.engine.major}.${versionData.engine.minor}.${versionData.engine.patch}`,
      branch: versionData.engine.branch,
      savedAt: header.saveDateTime,
      playDurationSeconds: header.playDurationSeconds,
      saveIdentifier: header.saveIdentifier,
      isModded: header.isModded,
      creativeMode: header.isCreativeModeEnabled,
    },
    version,
    gameMode: { partsCostMultiplier, spacePartsCostMultiplier, nodePurity, nodeRandomization, nodeRandomizationSeed, unrecognized },
    progression: {
      highestMilestoneTier: highestTier,
      milestones,
      ...(activeMilestone ? { activeMilestone: classOfPath(activeMilestone) } : {}),
      phase: {
        ...(currentPhase ? { current: classOfPath(currentPhase), currentIndex: phaseIndex(currentPhase) } : {}),
        ...(targetPhase ? { target: classOfPath(targetPhase) } : {}),
        targetPaidOff: paid,
      },
      mamResearch: mam,
      alternateSchematics: alternates,
      awesomeShopSchematics: shop,
      otherSchematics: other,
      unlockedRecipes,
      unlockedAlternateRecipes,
      overclockUnlocked,
      productionBoostUnlocked,
    },
    holdings,
    nodes,
    assumptions,
    warnings,
    parseStats: { objects: save.stats.objects, failedObjects: save.stats.failedObjects, rawProperties: save.stats.rawProperties },
  };
}

function simpleValue(p: Property): unknown {
  const v = p.value;
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object') return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? `<${x.length} bytes>` : x)));
  return v;
}

// ---------------------------------------------------------------------------

function countHoldings(
  save: ParsedSave, byInstance: Map<string, SaveObject>, gd: GameData, warnings: string[],
): SaveSummary['holdings'] {
  const sloop = gd.shards.somersloopItem;
  const shard = gd.shards.powerShardItem;
  const tally = { sloop: { stored: 0, inBuildings: 0 }, shard: { stored: 0, inBuildings: 0 }, blue: 0, yellow: 0, purple: 0 };
  const add = (item: string, n: number, inBuilding: boolean) => {
    const where = inBuilding ? 'inBuildings' : 'stored';
    if (item === sloop) tally.sloop[where] += n;
    else if (item === shard) tally.shard[where] += n;
    else if (item === SLUG_ITEMS.blue) tally.blue += n;
    else if (item === SLUG_ITEMS.yellow) tally.yellow += n;
    else if (item === SLUG_ITEMS.purple) tally.purple += n;
  };

  for (const l of save.levels) {
    for (const o of l.objects) {
      if (o.className !== 'FGInventoryComponent') continue;
      const stacks = val(o.properties, 'mInventoryStacks');
      if (!Array.isArray(stacks)) continue;
      const owner = o.parentEntityName ? byInstance.get(o.parentEntityName) : undefined;
      const slotted = /InventoryPotential$/.test(o.instanceName) && !!owner && /^Build_/.test(owner.className);
      for (const s of stacks) {
        const f = structFields(s);
        if (!f) continue;
        const itemStruct = f['Item']?.value as StructValue | undefined;
        const ref = (itemStruct?.value as { item?: ObjectRef } | undefined)?.item;
        const n = num(f['NumItems']?.value) ?? 0;
        if (ref?.pathName && n > 0) add(classOfPath(ref.pathName), n, slotted);
      }
    }
  }
  // Dimensional Depot
  const depot = save.levels.flatMap((l) => l.objects).find((o) => o.className === 'FGCentralStorageSubsystem');
  const stored = depot ? val(depot.properties, 'mStoredItems') : undefined;
  if (Array.isArray(stored)) {
    for (const e of stored) {
      const f = structFields(e);
      const ref = f && asRef(f['ItemClass']?.value);
      const n = f && num(f['Amount']?.value);
      if (ref && n) add(classOfPath(ref.pathName), n, false);
    }
  }

  // Slug -> shard yield from game-data recipes (not hard-coded).
  const yieldOf = (slug: string): number => {
    let best = 0;
    for (const r of gd.recipes.values()) {
      if (r.ingredients.length === 1 && r.ingredients[0]!.item === slug && r.products.length === 1 && r.products[0]!.item === shard) {
        best = Math.max(best, r.products[0]!.amount / r.ingredients[0]!.amount);
      }
    }
    if (!best) warnings.push(`No recipe converts ${slug} into Power Shards in the game data.`);
    return best;
  };
  const shardEquivalent = tally.blue * yieldOf(SLUG_ITEMS.blue) + tally.yellow * yieldOf(SLUG_ITEMS.yellow) + tally.purple * yieldOf(SLUG_ITEMS.purple);
  const h = (x: { stored: number; inBuildings: number }): Holdings => ({ total: x.stored + x.inBuildings, ...x });
  return {
    somersloops: h(tally.sloop),
    powerShards: h(tally.shard),
    powerSlugs: { blue: tally.blue, yellow: tally.yellow, purple: tally.purple, shardEquivalent },
  };
}
