/**
 * Objective registry. Each level is a linear function over the model's columns.
 *
 * Adding an objective (e.g. AWESOME Sink points later): add its kind to ObjectiveKind,
 * give it a spec here, and if it needs new columns (sink flows) add them in model.ts
 * behind a request flag. The lexicographic loop, diagnosis and results need no changes.
 */
import type { ObjectiveKind, PlanningProblem } from './types';
import type { BuiltModel, UnitCol } from './model';
import { countedCol, isUnit, unitRate, unitResource } from './model';
import type { EffectiveRequest } from './validate';

export interface ObjectiveSpec {
  kind: ObjectiveKind | 'tiebreak' | 'relaxation';
  item?: string;
  sense: 'min' | 'max';
  unit: string;
  /** Internal levels are solved but not reported. */
  hidden?: boolean;
  vector(m: BuiltModel): number[];
}

export function scarcityWeight(problem: PlanningProblem, resource: string): number {
  if (problem.unlimitedResources.includes(resource)) return 0;
  const a = problem.mapAvailability[resource];
  return a && a > 0 ? 1 / a : 0;
}

export function objectiveLevels(problem: PlanningProblem, req: EffectiveRequest): ObjectiveSpec[] {
  const levels: ObjectiveSpec[] = [];
  for (const kind of req.order) {
    switch (kind) {
      case 'targets':
        if (req.targets.size) {
          levels.push({
            kind, sense: 'min', unit: 'fraction of targets unmet',
            vector: (m) => {
              const v = zeros(m);
              for (const [item, col] of m.shortfallCol) v[col] = 1 / req.targets.get(item)!;
              return v;
            },
          });
        }
        break;
      case 'maximize':
        for (const item of req.maximize) {
          levels.push({
            kind, item, sense: 'max', unit: 'per min',
            vector: (m) => { const v = zeros(m); v[m.deliverCol.get(item)!] = 1; return v; },
          });
        }
        break;
      case 'scarcity':
        levels.push({
          kind, sense: 'min', unit: 'share of map supply',
          vector: (m) => {
            const v = zeros(m);
            for (const u of m.units) {
              const c = m.cols[u] as UnitCol;
              const r = unitResource(c);
              if (r) v[u] = unitRate(c) * scarcityWeight(problem, r);
            }
            return v;
          },
        });
        break;
      case 'power':
        levels.push({
          kind, sense: 'min', unit: 'MW',
          vector: (m) => { const v = zeros(m); for (const u of m.units) v[u] = (m.cols[u] as UnitCol).powerPerUnit; return v; },
        });
        break;
      case 'buildings':
        levels.push({
          kind, sense: 'min', unit: 'buildings',
          vector: (m) => { const v = zeros(m); for (const u of m.units) { const k = countedCol(m, u); v[k] = v[k]! + (m.cols[u] as UnitCol).buildingsPerUnit; } return v; },
        });
        break;
    }
  }
  // Tie-break: among equally good plans, spend the fewest Somersloops and Power Shards.
  levels.push({
    kind: 'tiebreak', sense: 'min', unit: 'items', hidden: true,
    vector: (m) => {
      const v = zeros(m);
      for (const u of m.units) {
        const c = m.cols[u] as UnitCol;
        const k = countedCol(m, u); v[k] = v[k]! + c.variant.sloops + c.variant.shards;
      }
      return v;
    },
  });
  return levels;
}

export function relaxationObjective(): ObjectiveSpec {
  return {
    kind: 'relaxation', sense: 'min', unit: 'weighted relaxation',
    vector: (m) => {
      const v = zeros(m);
      m.cols.forEach((c, i) => { if (c.kind === 'elastic') v[i] = c.penalty; });
      return v;
    },
  };
}

function zeros(m: BuiltModel): number[] {
  return new Array<number>(m.cols.length).fill(0);
}

export { isUnit };
