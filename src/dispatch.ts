import { sha256Hex, stableStringify } from './util/hash';
import type { GameData } from './gamedata/types';
import type { PlanRequest, SolveOptions } from './solver/types';

export interface SolveInputs {
  docsModel: string;
  catalog: string | null;
  worldSnapshot: string;
  planRevision: string;
  constants: GameData['constants'];
  solverVersion: string;
  request: PlanRequest;
  options: SolveOptions;
}

function ordered<T>(values: readonly T[]): T[] {
  return values.map(value => ({value, key: stableStringify(value)}))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .map(entry => entry.value);
}

// The solver assigns priority to maximize and objectiveOrder in their supplied order.
export function canonicalRequest(request: PlanRequest): PlanRequest {
  return {
    ...request,
    targets: ordered(request.targets),
    manualInputs: ordered(request.manualInputs),
    rawCaps: ordered(request.rawCaps),
    disabledRecipes: [...new Set(request.disabledRecipes)].sort(),
    excludedNodes: [...new Set(request.excludedNodes)].sort(),
  };
}

export function captureDispatch(inputs: SolveInputs) {
  const snapshot = structuredClone(inputs);
  snapshot.request = canonicalRequest(snapshot.request);
  const fingerprint = sha256Hex(stableStringify(snapshot));
  return { fingerprint, request: snapshot.request, options: snapshot.options };
}
