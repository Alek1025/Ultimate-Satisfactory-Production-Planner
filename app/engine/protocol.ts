/**
 * Messages between the UI thread and the engine worker. Everything here is
 * structured-clone friendly (Maps are fine; no functions, no class instances).
 */
import type { SaveSummary, PlanRequest, PlanResult, SolveOptions, NodePurity, ObjectiveKind } from '../../src';

export type DocsStage = 'decode' | 'parse' | 'labels';
export type SaveStage = 'header' | 'decompress' | 'objects' | 'summary';

export type EngineErrorKind =
  | 'not-docs'            // valid file, but not Satisfactory Docs.json
  | 'unsupported-version' // a save from a game version we refuse (pre-1.0 / pre-1.1)
  | 'corrupt'             // a save that fails partway
  | 'needs-game-data'     // save loaded before game data
  | 'needs-save'          // solve before a save
  | 'solver'              // HiGHS failed to load or solve
  | 'other';

export interface EngineError { kind: EngineErrorKind; message: string; detail?: string }

export interface GameDataInfo {
  contentHash: string;
  language: string;
  encoding: string;
  fileName: string;
  names: Map<string, string>;
  itemCount: number;
  recipeCount: number;
  warnings: string[];
}

export interface PickItem { id: string; reachable: boolean; raw: boolean; fluid: boolean }

/** What the UI needs about the loaded save's planning problem. */
export interface ProblemInfo {
  summaryKey?: string;
  items: PickItem[];
  holdings: { somersloops: number; powerShards: number; slugShardEquivalent: number };
  overclockUnlocked: boolean;
  productionBoostUnlocked: boolean;
  belt: { id: string; ratePerMin: number } | null;
  pipe: { id: string; ratePerMin: number } | null;
  recipeCount: number;
  alternateRecipeCount: number;
  nodes: {
    extractable: number;
    geysers: number;
    purityFromSave: number;
    resourceFromSave: number;
    counts: { resource: string; impure: number; normal: number; pure: number }[];
    assumptions: string[];
  };
  mapAvailability: Record<string, number>;
  /** Extractable nodes (resource nodes and well satellites) with resolved resource and purity. */
  mapNodes: MapNode[];
  /** Every production recipe in the game data, with what this save can run. */
  recipes: RecipeInfo[];
  /** Map-wide extraction rate per purity unit for each resource (rate of a normal node, best extractor). */
  perNormalNode: Record<string, number>;
  assumptions: string[];
  warnings: string[];
}

export interface MapNode {
  id: string;
  kind: 'resource-node' | 'well-satellite';
  x: number;
  y: number;
  resource: string | null;
  purity: NodePurity | null;
  wellCore?: string;
}

export interface RecipeInfo {
  id: string;
  building: string;
  isAlternate: boolean;
  /** runnable = recipe and building unlocked; building-locked = recipe unlocked but not its building. */
  status: 'runnable' | 'building-locked' | 'recipe-locked';
  ingredients: { item: string; perMin: number }[];
  products: { item: string; perMin: number }[];
}

export interface LayoutInput {
  nodes: { id: string; w: number; h: number; layer?: 'first' | 'last' }[];
  edges: { id: string; from: string; to: string }[];
}
export interface LayoutOutput {
  nodes: Record<string, { x: number; y: number }>;
  edges: Record<string, { points: [number, number][] }>;
  width: number;
  height: number;
}

export type EngineRequest =
  | { type: 'loadDocs'; bytes: Uint8Array; fileName: string }
  | { type: 'loadSave'; bytes: Uint8Array; fileName: string }
  | { type: 'useSummary'; summary: SaveSummary }
  | { type: 'solve'; request: PlanRequest; options: Partial<SolveOptions> };

export type EngineResponse =
  | { type: 'docs'; info: GameDataInfo }
  | { type: 'save'; summary: SaveSummary; problem: ProblemInfo }
  | { type: 'problem'; problem: ProblemInfo }
  | { type: 'solved'; result: PlanResult };

export type WorkerMessage =
  | { id: number; kind: 'progress'; stage: DocsStage | SaveStage | 'solve'; fraction?: number }
  | { id: number; kind: 'ok'; response: EngineResponse }
  | { id: number; kind: 'error'; error: EngineError };

export type { NodePurity, ObjectiveKind };
