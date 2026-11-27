/**
 * Plan documents. A plan is self-contained: it references the save summary it was made
 * from (stored once, shared by plans of the same save state), and carries its request,
 * solve options and last result. Everything is plain JSON.
 *
 * Versioning has three parts:
 *   schemaVersion          shape of the plan document (migrations in schema.ts)
 *   result.provenance      game-data content hash + save build the result was solved against
 *   lastResult.requestHash the request the result answers (detects edits after solving)
 */
import type { SaveSummary } from '../save/summary-types';
import type { PlanRequest, PlanResult, SolveOptions } from '../solver/types';

export const PLAN_SCHEMA_VERSION = 1;
export const BUNDLE_FORMAT = 'satisfactory-planner.plans';
export const BUNDLE_FORMAT_VERSION = 1;

/** Identifies the save state a plan was made from; the full summary lives under `summaryKey`. */
export interface SaveRef {
  /** Content hash of the stored SaveSummary. */
  summaryKey: string;
  saveIdentifier: string;
  saveName: string;
  sessionName: string;
  buildVersion: number;
  saveVersion: number;
  savedAt: string;
}

export interface StoredResult {
  result: PlanResult;
  /** hashValue(request) + solve options at solve time. */
  requestHash: string;
  /** The summary the result was solved against. */
  summaryKey: string;
}

export interface Plan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  id: string;
  name: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  save: SaveRef;
  request: PlanRequest;
  solveOptions: Partial<SolveOptions>;
  lastResult?: StoredResult;
}

/** What a plan list shows without loading results. */
export interface PlanListing {
  id: string;
  name: string;
  updatedAt: string;
  sessionName: string;
  saveName: string;
  solvedAt?: string;
  resultStatus?: PlanResult['status'];
}

/** Export file: one or more plans plus the save summaries they reference. */
export interface PlanBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: typeof BUNDLE_FORMAT_VERSION;
  exportedAt: string;
  app: string;
  plans: Plan[];
  summaries: Record<string, SaveSummary>;
}

export type StaleReason = 'never-solved' | 'request-changed' | 'game-data-changed' | 'save-changed' | 'solver-changed';

export interface Freshness {
  /** 'fresh': the stored result answers the current request with the current data. */
  state: 'fresh' | 'stale' | 'never-solved';
  reasons: StaleReason[];
  /** Plain-language warnings for the UI. */
  messages: string[];
}
