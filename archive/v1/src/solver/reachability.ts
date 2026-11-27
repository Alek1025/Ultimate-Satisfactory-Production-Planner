/**
 * Structural pre-pass: which items can be made at all from this save's unlocked recipes,
 * extractors and nodes (after the plan's exclusions and caps), which recipes are relevant
 * to the request, and plain-language reasons for anything that cannot be made.
 */
import type { PlanningProblem } from './types';
import type { EffectiveRequest } from './validate';
import { extractorCanMine } from './problem';

export interface Reachability {
  /** Raw resources with at least one usable source in this plan. */
  sourceable: Set<string>;
  reachable: Set<string>;
  /** Runnable recipes that lie on some path to a requested item. */
  relevantRecipes: Set<string>;
  why(item: string): string[];
}

export function analyzeReachability(problem: PlanningProblem, req: EffectiveRequest, label: (id: string) => string): Reachability {
  const sourceable = new Set<string>();
  const rawReason = new Map<string, string>();
  const capZero = (r: string) => req.caps.get(r) === 0;

  const nodeCount = new Map<string, { total: number; usable: number }>();
  for (const g of problem.nodeGroups) {
    const c = nodeCount.get(g.resource) ?? { total: 0, usable: 0 };
    c.total += g.nodeIds.length;
    c.usable += g.nodeIds.filter((n) => !req.excluded.has(n)).length;
    nodeCount.set(g.resource, c);
  }
  for (const [r, c] of nodeCount) {
    const item = problem.items[r];
    const ext = item ? problem.extractors.filter((e) => e.kind !== 'water-extractor' && extractorCanMine(e, item)) : [];
    if (!ext.length) rawReason.set(r, `${label(r)} nodes need an extractor that is not unlocked yet.`);
    else if (c.usable === 0) rawReason.set(r, `All ${c.total} ${label(r)} nodes are excluded in this plan.`);
    else sourceable.add(r);
  }
  const wellCount = new Map<string, { total: number; usable: number }>();
  for (const w of problem.wellGroups) {
    const c = wellCount.get(w.resource) ?? { total: 0, usable: 0 };
    c.total += w.satellites.length;
    c.usable += w.satellites.filter((s) => !req.excluded.has(s.id)).length;
    wellCount.set(w.resource, c);
  }
  for (const [r, c] of wellCount) {
    if (sourceable.has(r) || problem.unlimitedResources.includes(r)) continue;
    if (!problem.wells) rawReason.set(r, `${label(r)} comes from Resource Wells, which need the Resource Well Pressurizer and Extractor (not unlocked yet).`);
    else if (c.usable === 0) rawReason.set(r, `All ${c.total} ${label(r)} well satellites are excluded in this plan.`);
    else { sourceable.add(r); rawReason.delete(r); }
  }
  for (const r of problem.unlimitedResources) sourceable.add(r);
  for (const r of [...sourceable]) {
    if (capZero(r)) { sourceable.delete(r); rawReason.set(r, `${label(r)} is capped at 0/min in this plan.`); }
  }

  // Forward closure over enabled, runnable recipes.
  const enabled = problem.recipes.filter((r) => !req.disabled.has(r.id));
  const reachable = new Set<string>([...sourceable, ...req.manual.keys()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of enabled) {
      if (!r.ingredients.every((a) => reachable.has(a.item))) continue;
      for (const p of r.products) if (!reachable.has(p.item)) { reachable.add(p.item); changed = true; }
    }
  }
  const runnable = enabled.filter((r) => r.ingredients.every((a) => reachable.has(a.item)));

  // Backward closure from requested items.
  const needed = new Set<string>([...req.targets.keys(), ...req.maximize]);
  const relevantRecipes = new Set<string>();
  changed = true;
  while (changed) {
    changed = false;
    for (const r of runnable) {
      if (relevantRecipes.has(r.id) || !r.products.some((p) => needed.has(p.item))) continue;
      relevantRecipes.add(r.id);
      changed = true;
      for (const a of r.ingredients) needed.add(a.item);
    }
  }

  const why = (item: string, depth = 0, seen = new Set<string>()): string[] => {
    if (reachable.has(item) || seen.has(item)) return [];
    seen.add(item);
    const out: string[] = [];
    const raw = rawReason.get(item);
    if (raw) out.push(raw);
    else if (problem.items[item]?.isRaw && !nodeCount.has(item) && !wellCount.has(item)) out.push(`This save has no ${label(item)} nodes.`);
    const producers = problem.recipes.filter((r) => r.products.some((p) => p.item === item));
    const locked = problem.unavailableRecipes.filter((r) => r.products.includes(item));
    if (!producers.length && !locked.length && !problem.items[item]?.isRaw) {
      out.push(`No production recipe makes ${label(item)}; enter it as a manual input if you already produce it.`);
    }
    for (const l of locked.slice(0, 3)) {
      const name = label(l.id) === label(item) ? `The ${label(l.id)} recipe` : `${label(l.id)} (makes ${label(item)})`;
      out.push(l.reason === 'recipe-locked'
        ? `${name} is not unlocked yet.`
        : `${name} needs the ${label(l.building)}, which is not unlocked yet.`);
    }
    for (const p of producers) {
      if (req.disabled.has(p.id)) { out.push(`${label(p.id)} is turned off in this plan.`); continue; }
      const missing = p.ingredients.filter((a) => !reachable.has(a.item)).map((a) => a.item);
      if (!missing.length) continue;
      out.push(`${label(p.id)} needs ${missing.map(label).join(', ')}, which cannot be made.`);
      if (depth < 2) for (const m of missing) out.push(...why(m, depth + 1, seen).map((s) => `  ${s}`));
    }
    return out;
  };

  return { sourceable, reachable, relevantRecipes, why: (i) => why(i) };
}
