/**
 * Checks a PlanRequest against the problem and normalizes it (merged duplicates,
 * effective budgets, complete objective order). Errors stop the solve; warnings are
 * passed through to the result.
 */
import type { ObjectiveKind, PlanningProblem, PlanRequest } from './types';
import { DEFAULT_OBJECTIVE_ORDER } from './types';

export interface EffectiveRequest {
  targets: Map<string, number>;
  maximize: string[];
  manual: Map<string, number>;
  excluded: Set<string>;
  caps: Map<string, number>;
  disabled: Set<string>;
  order: ObjectiveKind[];
  budgets: { somersloops: number; powerShards: number };
}

export interface Validation {
  request: EffectiveRequest;
  errors: string[];
  warnings: string[];
}

export function validateRequest(problem: PlanningProblem, req: PlanRequest, label: (id: string) => string): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = (id: string, what: string) => {
    if (!problem.items[id]) { errors.push(`${what}: unknown item ${id}.`); return false; }
    return true;
  };
  const rate = (v: number, what: string) => {
    if (!Number.isFinite(v) || v < 0) { errors.push(`${what}: rate must be a non-negative number (got ${v}).`); return false; }
    return true;
  };

  const targets = new Map<string, number>();
  for (const t of req.targets) {
    if (!known(t.item, 'Target') || !rate(t.ratePerMin, `Target ${label(t.item)}`)) continue;
    if (t.ratePerMin > 0) targets.set(t.item, (targets.get(t.item) ?? 0) + t.ratePerMin);
  }
  const maximize: string[] = [];
  for (const m of req.maximize) {
    if (!known(m.item, 'Maximize')) continue;
    if (!maximize.includes(m.item)) maximize.push(m.item);
  }
  const manual = new Map<string, number>();
  for (const m of req.manualInputs) {
    if (!known(m.item, 'Manual input') || !rate(m.ratePerMin, `Manual input ${label(m.item)}`)) continue;
    if (problem.items[m.item]!.isRaw) {
      errors.push(`Manual input ${label(m.item)}: raw resources come from nodes. Use a raw-resource cap or node exclusions instead.`);
      continue;
    }
    if (m.ratePerMin > 0) manual.set(m.item, (manual.get(m.item) ?? 0) + m.ratePerMin);
  }
  for (const [item] of manual) {
    if (targets.has(item) || maximize.includes(item)) warnings.push(`${label(item)} is both a manual input and a requested output; the manual supply counts toward the request.`);
  }

  const knownNodes = new Set<string>();
  for (const g of problem.nodeGroups) g.nodeIds.forEach((n) => knownNodes.add(n));
  for (const w of problem.wellGroups) w.satellites.forEach((s) => knownNodes.add(s.id));
  const excluded = new Set<string>();
  const unknownNodes = req.excludedNodes.filter((n) => !knownNodes.has(n));
  if (unknownNodes.length) warnings.push(`Ignored ${unknownNodes.length} excluded node id(s) that are not extractable nodes in this save (e.g. ${unknownNodes.slice(0, 3).join(', ')}).`);
  req.excludedNodes.filter((n) => knownNodes.has(n)).forEach((n) => excluded.add(n));

  const caps = new Map<string, number>();
  for (const c of req.rawCaps) {
    if (!known(c.item, 'Raw cap') || !rate(c.maxPerMin, `Raw cap ${label(c.item)}`)) continue;
    if (!problem.items[c.item]!.isRaw) { errors.push(`Raw cap ${label(c.item)}: not a raw resource.`); continue; }
    caps.set(c.item, Math.min(caps.get(c.item) ?? Number.POSITIVE_INFINITY, c.maxPerMin));
  }

  const disabled = new Set(req.disabledRecipes);

  // Objective order: known kinds once each, missing ones appended in default order.
  const order: ObjectiveKind[] = [];
  for (const k of req.objectiveOrder) {
    if (!DEFAULT_OBJECTIVE_ORDER.includes(k)) { warnings.push(`Unknown objective "${k}" ignored.`); continue; }
    if (!order.includes(k)) order.push(k);
  }
  for (const k of DEFAULT_OBJECTIVE_ORDER) if (!order.includes(k)) order.push(k);
  const firstRequest = Math.min(order.indexOf('targets'), order.indexOf('maximize'));
  if ((targets.size || maximize.length) && firstRequest > 0) {
    warnings.push(`Objective "${order[0]}" is ranked above meeting your requests, so the plan may deliver less than asked to improve it.`);
  }

  // Budgets
  const budgets = { somersloops: Math.max(0, Math.floor(req.budgets.somersloops || 0)), powerShards: Math.max(0, Math.floor(req.budgets.powerShards || 0)) };
  const h = problem.holdings;
  if (budgets.somersloops > 0 && !problem.productionBoost.unlocked) {
    warnings.push(`Somersloop budget ${budgets.somersloops} ignored: production boosting is not researched in this save yet.`);
    budgets.somersloops = 0;
  } else if (budgets.somersloops > h.somersloops) {
    warnings.push(`Somersloop budget (${budgets.somersloops}) is more than this save has (${h.somersloops}).`);
  }
  if (budgets.powerShards > 0 && !problem.overclock.unlocked) {
    warnings.push(`Power Shard budget ${budgets.powerShards} ignored: overclocking is not unlocked in this save yet.`);
    budgets.powerShards = 0;
  } else if (budgets.powerShards > h.powerShards) {
    const slugs = h.slugShardEquivalent > 0 ? ` Your Power Slugs would make ${h.slugShardEquivalent} more.` : '';
    warnings.push(`Power Shard budget (${budgets.powerShards}) is more than this save has (${h.powerShards}).${slugs}`);
  }

  if (!targets.size && !maximize.length) errors.push('Nothing requested: add a target rate or an item to maximize.');

  return { request: { targets, maximize, manual, excluded, caps, disabled, order, budgets }, errors, warnings };
}
