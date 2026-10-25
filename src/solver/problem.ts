/**
 * Builds the solver's PlanningProblem from parsed game data + a save summary + resolved
 * nodes. This is the only solver file that knows about the parser's types; everything
 * downstream works on PlanningProblem.
 */
import type { Extractor, GameData, Item, NodePurity } from '../gamedata/types';
import type { NodeResolution } from '../gamedata/node-catalog';
import type { SaveSummary } from '../save/summary-types';
import type {
  NodeGroup, PlanningProblem, ProblemBuilding, ProblemExtractor, ProblemItem, ProblemRecipe, UnavailableRecipe, WellGroup,
} from './types';

const WATER = 'Desc_Water_C';

export function extractorCanMine(e: { allowedForms: Item['form'][]; allowedResources: string[] }, item: ProblemItem | Item): boolean {
  if (!e.allowedForms.includes(item.form)) return false;
  const id = 'id' in item ? item.id : item.className;
  return e.allowedResources.length === 0 || e.allowedResources.includes(id);
}

export function buildPlanningProblem(gd: GameData, summary: SaveSummary, nodes: NodeResolution): PlanningProblem {
  const assumptions: string[] = [];
  const warnings: string[] = [...nodes.warnings];
  if (summary.version.status !== 'supported') warnings.push(summary.version.message ?? `Save version ${summary.source.saveVersion} is not a known Update 1.2 version.`);

  const unlockedRecipes = new Set(summary.progression.unlockedRecipes);
  const unlockedBuildables = new Set<string>();
  for (const [recipe, placed] of gd.buildRecipes) if (unlockedRecipes.has(recipe)) placed.forEach((b) => unlockedBuildables.add(b));

  // Items
  const items: Record<string, ProblemItem> = {};
  for (const it of gd.items.values()) {
    items[it.className] = { id: it.className, form: it.form, fluid: it.form === 'liquid' || it.form === 'gas', isRaw: it.isRawResource };
  }

  // Production buildings and recipes
  const buildings: Record<string, ProblemBuilding> = {};
  const recipes: ProblemRecipe[] = [];
  const unavailableRecipes: UnavailableRecipe[] = [];
  for (const r of gd.recipes.values()) {
    if (r.manualOnly || r.durationSec <= 0) continue;
    const building = r.producedIn.find((b) => unlockedBuildables.has(b)) ?? r.producedIn[0]!;
    const b = gd.buildings.get(building)!;
    const products = r.products.map((p) => p.item);
    if (!unlockedRecipes.has(r.className)) { unavailableRecipes.push({ id: r.className, building, reason: 'recipe-locked', products }); continue; }
    if (!unlockedBuildables.has(building)) { unavailableRecipes.push({ id: r.className, building, reason: 'building-locked', products }); continue; }
    buildings[building] ??= {
      id: building,
      powerMW: b.powerMW,
      powerExponent: b.powerExponent,
      boostPowerExponent: b.boostPowerExponent,
      manufacturingSpeed: b.manufacturingSpeed,
      canOverclock: b.canOverclock,
      sloopSlots: b.sloopSlots,
      boostPerSlot: b.sloopBoostPerSlot * gd.shards.sloopExtraBoost,
    };
    recipes.push({
      id: r.className,
      building,
      durationSec: r.durationSec,
      ingredients: r.ingredients.filter((a) => a.amount > 0),
      products: r.products.filter((a) => a.amount > 0),
      isAlternate: r.isAlternate,
      ...(r.variablePower ? { averagePowerMW: r.variablePower.constantMW + r.variablePower.factorMW / 2 } : {}),
    });
  }
  if (recipes.some((r) => r.averagePowerMW !== undefined)) {
    assumptions.push('Variable-power buildings (Particle Accelerator, Converter, Quantum Encoder) are counted at their average draw: constant + half the variable range, from each recipe in Docs.json.');
  }

  // Extractors
  const extractors: ProblemExtractor[] = [];
  for (const e of gd.extractors.values()) {
    if (e.kind === 'well-extractor' || !unlockedBuildables.has(e.className)) continue;
    extractors.push({
      id: e.className, kind: e.kind, baseRatePerMin: e.baseRatePerMin, powerMW: e.powerMW, powerExponent: e.powerExponent,
      canOverclock: e.canOverclock, allowedForms: e.allowedForms, allowedResources: e.allowedResources,
    });
  }
  const wellExtractor = [...gd.extractors.values()].find((e) => e.kind === 'well-extractor');
  const pressurizer = [...gd.pressurizers.values()][0];
  const wells = wellExtractor && pressurizer && unlockedBuildables.has(wellExtractor.className) && unlockedBuildables.has(pressurizer.className)
    ? {
      pressurizer: { id: pressurizer.className, powerMW: pressurizer.powerMW, powerExponent: pressurizer.powerExponent, canOverclock: pressurizer.canOverclock },
      extractor: { id: wellExtractor.className, baseRatePerMin: wellExtractor.baseRatePerMin, powerMW: wellExtractor.powerMW },
    }
    : null;

  const unlimitedResources = extractors.some((e) => e.kind === 'water-extractor') ? [WATER] : [];

  // Nodes
  const groups = new Map<string, NodeGroup>();
  const wellMap = new Map<string, WellGroup>();
  let unknownNodes = 0;
  for (const n of nodes.nodes) {
    if (n.kind !== 'resource-node' && n.kind !== 'well-satellite') continue;
    if (!n.resource || !n.purity) { unknownNodes++; continue; }
    if (n.kind === 'resource-node') {
      const id = `${n.resource}:${n.purity}`;
      const g = groups.get(id) ?? { id, resource: n.resource, purity: n.purity, nodeIds: [] };
      g.nodeIds.push(n.id);
      groups.set(id, g);
    } else {
      if (!n.wellCore) { unknownNodes++; continue; }
      const g = wellMap.get(n.wellCore) ?? { id: `well:${n.wellCore}`, coreId: n.wellCore, resource: n.resource, satellites: [] };
      if (g.resource !== n.resource) warnings.push(`Well ${n.wellCore} has satellites with different resources (${g.resource}, ${n.resource}); using ${g.resource}.`);
      g.satellites.push({ id: n.id, purity: n.purity });
      wellMap.set(n.wellCore, g);
    }
  }
  if (unknownNodes) warnings.push(`${unknownNodes} node(s) have no known resource or purity and are left out of the plan.`);
  const nodeGroups = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
  const wellGroups = [...wellMap.values()].sort((a, b) => a.coreId.localeCompare(b.coreId, undefined, { numeric: true }));

  // Transport
  const best = (kind: 'belt' | 'pipe') => {
    const t = [...gd.transports.values()].filter((x) => x.kind === kind && unlockedBuildables.has(x.className)).sort((a, b) => b.ratePerMin - a.ratePerMin || Number(/NoIndicator/.test(a.className)) - Number(/NoIndicator/.test(b.className)) || a.className.localeCompare(b.className))[0];
    return t ? { id: t.className, ratePerMin: t.ratePerMin } : null;
  };
  const transport = { belt: best('belt'), pipe: best('pipe') };
  if (!transport.belt) warnings.push('No conveyor belt is unlocked, so building inputs/outputs are not capped by belt speed.');
  if (!transport.pipe && recipes.some((r) => [...r.ingredients, ...r.products].some((a) => items[a.item]?.fluid))) {
    warnings.push('No pipeline is unlocked, so fluid inputs/outputs are not capped by pipe speed.');
  }

  // Map-wide availability (scarcity weights)
  const purity = gd.constants.purityMultiplier.value as Record<NodePurity, number>;
  const allExtractors = [...gd.extractors.values()].filter((e) => e.kind === 'miner' || e.kind === 'oil-extractor');
  const bestRate = (resource: string) => {
    const item = gd.items.get(resource);
    if (!item) return 0;
    return Math.max(0, ...allExtractors.filter((e: Extractor) => extractorCanMine(e, item)).map((e) => e.baseRatePerMin));
  };
  const mapAvailability: Record<string, number> = {};
  for (const g of nodeGroups) {
    if (unlimitedResources.includes(g.resource)) continue;
    mapAvailability[g.resource] = (mapAvailability[g.resource] ?? 0) + g.nodeIds.length * purity[g.purity] * bestRate(g.resource);
  }
  const wellRate = wellExtractor?.baseRatePerMin ?? 0;
  for (const w of wellGroups) {
    if (unlimitedResources.includes(w.resource)) continue;
    mapAvailability[w.resource] = (mapAvailability[w.resource] ?? 0) + w.satellites.reduce((s, sat) => s + purity[sat.purity] * wellRate, 0);
  }
  assumptions.push('Scarcity weight of a raw resource = 1 / its map-wide extraction capacity in this save (every node, at its purity, with the best extractor in the game data at 100%). Water from Water Extractors is unlimited and has weight 0.');
  assumptions.push(gd.constants.purityMultiplier.note);
  assumptions.push(gd.constants.powerShardSlots.note);
  if (Object.values(buildings).some((b) => b.sloopSlots > 0)) {
    const fromConst = [...gd.buildings.values()].filter((b) => b.sloopSlotsFromConstant && buildings[b.className]);
    if (fromConst.length) assumptions.push(gd.constants.defaultSloopSlots.note);
  }
  assumptions.push(...nodes.assumptions);

  const h = summary.holdings;
  return {
    schemaVersion: 1,
    provenance: { gameDataHash: gd.contentHash, saveName: summary.source.saveName, sessionName: summary.source.sessionName, saveBuild: summary.source.buildVersion },
    items,
    buildings,
    recipes: recipes.sort((a, b) => a.id.localeCompare(b.id)),
    unavailableRecipes,
    extractors: extractors.sort((a, b) => a.id.localeCompare(b.id)),
    wells,
    nodeGroups,
    wellGroups,
    unlimitedResources,
    transport,
    overclock: { unlocked: summary.progression.overclockUnlocked, perShard: gd.shards.overclockPerShard, maxShards: gd.constants.powerShardSlots.value },
    productionBoost: { unlocked: summary.progression.productionBoostUnlocked },
    purityMultiplier: purity,
    holdings: { somersloops: h.somersloops.total, powerShards: h.powerShards.total, slugShardEquivalent: h.powerSlugs.shardEquivalent },
    mapAvailability,
    assumptions,
    warnings,
  };
}
