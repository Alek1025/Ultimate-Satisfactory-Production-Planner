import { z } from 'zod';
import { DEFAULT_OBJECTIVE_ORDER, DEFAULT_SOLVE_OPTIONS } from './solver/types';

const item = z.string().min(1);
const rate = z.number().nonnegative();
const supply = z.strictObject({ item, ratePerMin: rate });
const count = z.number().int().nonnegative();

export const charterSchema = z.strictObject({
  targets: z.array(supply).default([]),
  maximize: z.array(z.strictObject({ item })).default([]),
  manualInputs: z.array(supply).default([]),
  rawCaps: z.array(z.strictObject({ item, maxPerMin: rate })).default([]),
  excludedNodes: z.array(z.string()).default([]),
  disabledRecipes: z.array(z.string()).default([]),
  objectiveOrder: z.array(z.enum(DEFAULT_OBJECTIVE_ORDER)).default([...DEFAULT_OBJECTIVE_ORDER]),
  budgets: z.strictObject({ somersloops: count.default(0), powerShards: count.default(0) })
    .prefault({}),
  options: z.strictObject({
    integerPass: z.enum(['on','off','auto']).default(DEFAULT_SOLVE_OPTIONS.integerPass),
    integerTimeLimitSec: z.number().positive().default(DEFAULT_SOLVE_OPTIONS.integerTimeLimitSec),
    mipRelGap: rate.default(DEFAULT_SOLVE_OPTIONS.mipRelGap),
  }).prefault({}),
}).refine(input => input.targets.some(t => t.ratePerMin > 0) || input.maximize.length > 0,
  'Supply a positive target rate or an item to maximize.');
