import { expect, it } from 'vitest';
import { captureDispatch, type SolveInputs } from '../src/dispatch';

const inputs: SolveInputs = {
  docsModel: 'docs', catalog: 'pack', worldSnapshot: 'save', planRevision: 'rev',
  solverVersion: 'backend 1',
  constants: {
    purityMultiplier: { value: {pure: 2, normal: 1, impure: 0.5}, note: '' },
    powerShardSlots: {value: 3, note: ''}, defaultSloopSlots: {value: 1, note: ''},
  },
  options: { integerPass: 'auto', integerTimeLimitSec: 3, mipRelGap: 0.01 },
  request: {
    targets: [{ item: 'a', ratePerMin: 1 }, { item: 'b', ratePerMin: 2 }],
    maximize: [{item: 'a'}, {item: 'b'}], manualInputs: [], rawCaps: [],
    excludedNodes: ['c','d'], disabledRecipes: [], objectiveOrder: ['targets','power'],
    budgets: { powerShards: 0, somersloops: 0 },
  },
};

it('captures the requested work before subsequent edits and ignores equivalent reorderings', () => {
  const edited = structuredClone(inputs);
  const atDispatch = captureDispatch(edited);
  edited.request.targets.reverse();
  edited.request.excludedNodes.reverse();
  edited.request.budgets = {somersloops: 0, powerShards: 0};
  expect(captureDispatch(edited)).toEqual(atDispatch);
  edited.request.maximize.reverse();
  expect(captureDispatch(edited).fingerprint).not.toBe(atDispatch.fingerprint);
  expect(atDispatch.request.maximize[0]?.item).toBe('a');
});

it('misses on changes to every solve dependency', () => {
  const original = captureDispatch(inputs).fingerprint;
  for (const key of ['docsModel','catalog','worldSnapshot','planRevision','solverVersion'] as const) {
    expect(captureDispatch({...inputs, [key]: 'changed'}).fingerprint).not.toBe(original);
  }
  for (const change of [
    (x: SolveInputs) => { x.options.integerPass = 'off'; },
    (x: SolveInputs) => { x.request.objectiveOrder.reverse(); },
    (x: SolveInputs) => { x.constants.powerShardSlots.value++; },
  ]) {
    const copy = structuredClone(inputs);
    change(copy);
    expect(captureDispatch(copy).fingerprint).not.toBe(original);
  }
});
