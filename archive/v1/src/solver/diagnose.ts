/**
 * Infeasibility diagnosis. When targets can't all be met:
 *   1. structural: requested items no unlocked recipe/extractor can make (with reasons);
 *   2. binding limits at the targets level (row duals);
 *   3. relaxation: the cheapest set of limit increases that meets every reachable target,
 *      solved as an elastic LP (budgets up to holdings < raw caps < budgets beyond
 *      holdings < more nodes than the map has).
 */
import type { Infeasibility, LimitRef, PlanningProblem } from './types';
import type { LpBackend } from './lp/types';
import type { EffectiveRequest } from './validate';
import type { Reachability } from './reachability';
import { buildModel } from './model';
import { relaxationObjective } from './objectives';
import { rowActivity } from './lexicographic';

export async function diagnose(
  backend: LpBackend, problem: PlanningProblem, req: EffectiveRequest, reach: Reachability,
  shortfalls: Infeasibility['shortfalls'], binding: LimitRef[],
): Promise<Infeasibility> {
  const requested = [...new Set([...req.targets.keys(), ...req.maximize])];
  const unreachable = requested.filter((i) => !reach.reachable.has(i)).map((item) => ({ item, reasons: reach.why(item) }));

  const relaxation: Infeasibility['relaxation'] = [];
  const reachableShort = shortfalls.filter((s) => reach.reachable.has(s.item));
  if (reachableShort.length) {
    const m = buildModel(problem, req, reach, {
      integer: false,
      elastic: true,
      variants: { allowShards: problem.overclock.unlocked, allowSloops: problem.productionBoost.unlocked },
    });
    const spec = relaxationObjective();
    const sol = await backend.solve({ model: m.lp, cost: spec.vector(m), sense: 'min' });
    if (sol.status === 'optimal' && sol.x) {
      const byLimit = new Map<number, Map<string, number>>();
      m.cols.forEach((c, i) => {
        if (c.kind !== 'elastic' || sol.x![i]! <= 1e-6) return;
        const t = byLimit.get(c.limit) ?? new Map<string, number>();
        t.set(c.tier, (t.get(c.tier) ?? 0) + sol.x![i]!);
        byLimit.set(c.limit, t);
      });
      for (const [li, tiers] of byLimit) {
        const l = m.limits[li]!;
        const used = rowActivity(m.lp.rows[l.row]!, sol.x);
        for (const [tier, extra] of tiers) {
          relaxation.push({ limit: { ...l.ref, used }, extraNeeded: extra, tier: tier as Infeasibility['relaxation'][number]['tier'] });
        }
      }
      const order = { budget: 0, cap: 1, 'over-holdings': 2, map: 3 } as const;
      relaxation.sort((a, b) => order[a.tier] - order[b.tier] || b.extraNeeded - a.extraNeeded);
    }
  }
  return { shortfalls, unreachable, relaxation, binding };
}
