/**
 * Plain-language explanation of a plan: what it delivers, what limits it, why it picked
 * what it did, and what it spends. Labels come from the loaded locale (any language);
 * without one, ClassNames are turned into readable fallbacks.
 */
import type { LevelResult, LimitRef, PlanningProblem, PlanResult } from './types';
import type { EffectiveRequest } from './validate';

export type Label = (id: string) => string;

/** "Desc_IronPlateReinforced_C" -> "Iron Plate Reinforced"; used when no locale is loaded. */
export function fallbackLabel(id: string): string {
  const core = id.replace(/^(Desc|Recipe|Build|BP)_/, '').replace(/_C$/, '').replace(/^Alternate_/, 'Alternate: ');
  return core.replace(/_/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

export function makeLabel(names?: Map<string, string>): Label {
  return (id) => names?.get(id) ?? fallbackLabel(id);
}

export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return String(n);
  const r = Number(n.toFixed(digits));
  return r.toLocaleString('en-US', { maximumFractionDigits: digits });
}
const pct = (f: number, digits = 1) => `${fmt(f * 100, digits)}%`;

function rateUnit(problem: PlanningProblem, item: string): string {
  return problem.items[item]?.fluid ? 'm³/min' : '/min';
}
function amount(problem: PlanningProblem, label: Label, item: string, v: number): string {
  const u = rateUnit(problem, item);
  return u === '/min' ? `${fmt(v)} ${label(item)}/min` : `${fmt(v)} m³/min ${label(item)}`;
}

export function describeLimit(problem: PlanningProblem, label: Label, l: LimitRef): string {
  switch (l.kind) {
    case 'nodes': return `${l.purity} ${label(l.resource!)} nodes (${fmt(l.used, 1)} of ${l.capacity} in use)`;
    case 'well': return `Resource Well ${l.id.replace(/^well:/, '')} (${label(l.resource!)})`;
    case 'raw-cap': return `your ${label(l.resource!)} cap of ${fmt(l.capacity)}${rateUnit(problem, l.resource!)}`;
    case 'somersloop-budget': return `the Somersloop budget (${fmt(l.used, 1)} of ${l.capacity})`;
    case 'shard-budget': return `the Power Shard budget (${fmt(l.used, 1)} of ${l.capacity})`;
  }
}

const LEVEL_NAME: Record<string, string> = {
  targets: 'meeting targets', maximize: 'maximizing', scarcity: 'scarce raw resources', power: 'power', buildings: 'building count',
};

export function explain(problem: PlanningProblem, req: EffectiveRequest, r: Omit<PlanResult, 'explanation'>, label: Label): string[] {
  const out: string[] = [];
  const flows = new Map(r.items.map((i) => [i.item, i]));

  // 1. What it delivers
  if (req.targets.size) {
    const short = r.items.filter((i) => i.target !== undefined && i.shortfall > 1e-6);
    const list = [...req.targets].map(([item, t]) => amount(problem, label, item, t)).join(', ');
    if (!short.length) out.push(`Meets all ${req.targets.size} target${req.targets.size > 1 ? 's' : ''}: ${list}.`);
    else {
      out.push(`Can't fully meet the targets. ${short.map((i) => `${label(i.item)}: ${fmt(i.delivered)} of ${fmt(i.target!)}${rateUnit(problem, i.item)}`).join('; ')}.`);
    }
  }
  for (const lv of r.levels.filter((l) => l.kind === 'maximize')) {
    const item = lv.item!;
    if (lv.status === 'unbounded') { out.push(`${label(item)} has no upper limit with the current inputs (it only needs unlimited sources), so it can't be maximized.`); continue; }
    const extra = req.targets.get(item);
    out.push(`Makes up to ${amount(problem, label, item, flows.get(item)?.delivered ?? lv.value)} when maximized${extra ? ` (including the ${fmt(extra)} target)` : ''}.`);
    if (lv.binding.length) out.push(`  More ${label(item)} is limited by ${lv.binding.slice(0, 4).map((b) => describeLimit(problem, label, b)).join('; ')}.`);
  }

  // 2. Why not, if short
  const inf = r.infeasibility;
  if (inf) {
    for (const u of inf.unreachable) {
      out.push(`${label(u.item)} can't be made with this save:`);
      for (const reason of u.reasons.slice(0, 6)) out.push(`  ${reason}`);
    }
    if (inf.binding.length) out.push(`The plan runs out of: ${inf.binding.slice(0, 5).map((b) => describeLimit(problem, label, b)).join('; ')}.`);
    if (inf.relaxation.length) {
      out.push(inf.relaxation.length > 1 ? 'To meet every target, the smallest change would be all of:' : 'To meet every target, the smallest change would be:');
      for (const x of inf.relaxation) {
        const l = x.limit;
        switch (l.kind) {
          case 'somersloop-budget':
          case 'shard-budget': {
            const name = l.kind === 'shard-budget' ? 'Power Shard' : 'Somersloop';
            const held = l.kind === 'shard-budget' ? problem.holdings.powerShards : problem.holdings.somersloops;
            out.push(x.tier === 'over-holdings'
              ? `  ${fmt(Math.ceil(x.extraNeeded - 1e-6), 0)} more ${name}s than you hold (${held}).`
              : `  raise the ${name} budget by ${fmt(Math.ceil(x.extraNeeded - 1e-6), 0)} (you hold ${held}).`);
            break;
          }
          case 'raw-cap': out.push(`  raise your ${label(l.resource!)} cap by ${fmt(x.extraNeeded)}${rateUnit(problem, l.resource!)}.`); break;
          case 'nodes': out.push(`  ${fmt(x.extraNeeded, 1)} more ${l.purity} ${label(l.resource!)} nodes than are usable (${l.capacity}). That isn't possible on this map; lower the target, un-exclude nodes, or unlock faster extractors/belts.`); break;
          case 'well': out.push(`  more output from Resource Well ${l.id.replace(/^well:/, '')} than it can give.`); break;
        }
      }
    }
  }

  // 3. Raw resources
  const used = r.resources.filter((x) => x.used > 1e-6);
  if (used.length) {
    const parts = [...used].sort((a, b) => (b.mapShare ?? -1) - (a.mapShare ?? -1)).map((x) =>
      `${amount(problem, label, x.resource, x.used)}${x.mapShare !== null ? ` (${pct(x.mapShare)} of the map)` : ''}`);
    out.push(`Raw resources: ${parts.join(', ')}.`);
    const full = new Map<string, { used: number; cap: number; purity: string; resource: string }>();
    for (const e of r.extraction) {
      if (e.source !== 'node' || !e.groupId) continue;
      const g = full.get(e.groupId) ?? { used: 0, cap: problem.nodeGroups.find((n) => n.id === e.groupId)!.nodeIds.filter((n) => !req.excluded.has(n)).length, purity: e.purity!, resource: e.resource };
      g.used += e.count;
      full.set(e.groupId, g);
    }
    const maxed = [...full.values()].filter((g) => g.used >= g.cap);
    if (maxed.length) out.push(`  Every usable node is in use for: ${maxed.map((g) => `${g.purity} ${label(g.resource)} (${g.cap})`).join(', ')}.`);
  }

  if (!r.buildings.length && !r.extraction.length) return out;

  // 4. Why these recipes
  const ranked = req.order.filter((k) => k !== 'targets' && k !== 'maximize').map((k) => LEVEL_NAME[k]);
  out.push(`Recipes and extractors were chosen to ${req.targets.size || req.maximize.length ? 'meet the request, then ' : ''}minimize, in order: ${ranked.join(', then ')}.`);
  const alts = [...new Set(r.buildings.filter((b) => problem.recipes.find((p) => p.id === b.recipe)?.isAlternate).map((b) => b.recipe))];
  if (alts.length) out.push(`  Alternate recipes used: ${alts.map(label).join(', ')}.`);
  const scarcity = r.levels.find((l) => l.kind === 'scarcity');
  if (scarcity?.binding.length) {
    out.push(`  Raw use could go lower with more of: ${scarcity.binding.slice(0, 4).map((b) => describeLimit(problem, label, b)).join('; ')}.`);
  }

  // 5. Clocks
  const belt = r.buildings.filter((b) => b.variant.beltLimited);
  if (belt.length) {
    const t = problem.transport;
    out.push(`${belt.length} recipe line(s) run below 100% because an input or output would exceed the ${t.belt ? `${label(t.belt.id)} (${fmt(t.belt.ratePerMin)}/min)` : 'belt'}${t.pipe ? ` / ${label(t.pipe.id)} (${fmt(t.pipe.ratePerMin)} m³/min)` : ''}: ${belt.map((b) => `${label(b.recipe)} at ${pct(b.variant.clock, 1)}`).join(', ')}.`);
  }
  const under = r.buildings.filter((b) => !b.variant.beltLimited && b.clockEach < b.variant.clock - 5e-4).sort((a, b) => a.clockEach / a.variant.clock - b.clockEach / b.variant.clock);
  if (under.length) out.push(`${under.length} line(s) are underclocked so totals hit the exact rates (lowest: ${label(under[0]!.recipe)}, ${under[0]!.count} × ${label(under[0]!.building)} at ${pct(under[0]!.clockEach)}).`);

  // 6. Budgets
  const sl = r.budgets.somersloops, ps = r.budgets.powerShards;
  if (sl.budget > 0 || sl.used > 0) {
    const where = sl.where.map((w) => `${w.count} × ${label(w.building)} for ${label(w.recipe!)} (${w.each} each)`).join(', ');
    out.push(`Somersloops: uses ${sl.used} of the ${sl.budget} budget (${sl.available} held)${where ? `: ${where}` : '. Boosting did not improve the plan'}.`);
  }
  if (ps.budget > 0 || ps.used > 0) {
    const where = ps.where.map((w) => `${w.count} × ${label(w.building)} ${w.recipe ? `for ${label(w.recipe)}` : `on ${label(w.resource!)}`} (${w.each} each)`).join(', ');
    out.push(`Power Shards: uses ${ps.used} of the ${ps.budget} budget (${ps.available} held)${where ? `: ${where}` : '. Overclocking did not improve the plan'}.`);
  }

  // 7. Power, buildings, transport, byproducts
  if (r.buildingCount === 0) return out;
  out.push(`Power: ${fmt(r.power.actualMW, 1)} MW at the clocks above (reported only, not a limit).`);
  const byBuilding = new Map<string, number>();
  for (const b of r.buildings) byBuilding.set(b.building, (byBuilding.get(b.building) ?? 0) + b.count);
  for (const e of r.extraction) byBuilding.set(e.extractor, (byBuilding.get(e.extractor) ?? 0) + e.count);
  const wellExtractors = r.extraction.reduce((s, e) => s + (e.satellites ?? 0), 0);
  if (wellExtractors && problem.wells) byBuilding.set(problem.wells.extractor.id, wellExtractors);
  out.push(`${r.buildingCount} buildings: ${[...byBuilding].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${n} × ${label(b)}`).join(', ')}${r.pass === 'integer' ? '' : ' (fractional amounts rounded up)'}.`);
  const busy = r.items.filter((i) => (i.lines?.count ?? 0) > 1).sort((a, b) => b.lines!.count - a.lines!.count).slice(0, 5);
  if (busy.length) out.push(`Flows that need more than one line: ${busy.map((i) => `${label(i.item)} ${i.lines!.count} × ${label(i.lines!.transport)}`).join(', ')}.`);
  const surplus = r.items.filter((i) => i.surplus > Math.max(0.01, 1e-4 * (i.produced + i.extracted)) && !req.maximize.includes(i.item));
  if (surplus.length) out.push(`Surplus to sink or store: ${surplus.map((i) => amount(problem, label, i.item, i.surplus)).join(', ')}.`);
  const manual = r.items.filter((i) => i.manualAvailable > 0);
  if (manual.length) out.push(`Manual inputs used: ${manual.map((i) => `${fmt(i.manualUsed)} of ${fmt(i.manualAvailable)} ${label(i.item)}${rateUnit(problem, i.item)}`).join(', ')}.`);
  if (r.pass === 'integer') out.push(`Building counts are whole numbers (integer pass)${r.provenOptimal ? '' : '; it hit its time limit, so a slightly better plan may exist'}.`);
  return out;
}

export function levelName(l: LevelResult): string {
  return LEVEL_NAME[l.kind] ?? l.kind;
}
