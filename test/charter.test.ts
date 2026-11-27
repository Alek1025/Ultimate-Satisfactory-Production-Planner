import { describe, expect, it } from 'vitest';
import { charterSchema } from '../src/charter';

describe('charter file', () => {
  it('accepts an explicit output and supplies the headless defaults', () => {
    const charter = charterSchema.parse({maximize: [{item: 'rotor'}]});
    expect(charter.options.integerPass).toBe('auto');
    expect(charter.budgets).toEqual({powerShards: 0, somersloops: 0});
    expect(charter.maximize).toEqual([{item: 'rotor'}]);
  });

  it.each([
    {}, {targets: [{item: 'plate', ratePerMin: 0}]},
    {maximize: [{item: 'rotor'}], options: {integerPass: 'force'}},
    {maximize: [{item: 'rotor'}], budget: {powerShard: 5}},
  ])('rejects an invalid charter %j', input => {
    expect(charterSchema.safeParse(input).success).toBe(false);
  });
});
