/// <reference lib="webworker" />
/**
 * The engine worker: parsing and solving run here so the page never freezes.
 * It keeps the loaded GameData, the current save summary and its planning problem.
 */
import highsLoader from 'highs';
import highsWasmUrl from 'highs/runtime?url';
import {
  readDocsFile, parseGameData, parseLabels, detectEncoding, GameDataError,
  summarizeSaveBytes, SaveFormatError, loadBundledNodeCatalog, resolveNodes,
  buildPlanningProblem, solvePlan, createHighsBackend, makeLabel, validateRequest,
  emptyRequest, summaryKey,
  type GameData, type Labels, type SaveSummary, type PlanningProblem, type NodeResolution,
} from '../../src';
import { analyzeReachability } from '../../src/solver/reachability';
import type { EngineError, EngineRequest, EngineResponse, GameDataInfo, MapNode, ProblemInfo, RecipeInfo, WorkerMessage } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let gameData: GameData | undefined;
let labels: Labels | undefined;
let summary: SaveSummary | undefined;
let problem: PlanningProblem | undefined;
const catalog = loadBundledNodeCatalog();
const backend = createHighsBackend(() => highsLoader({ locateFile: () => highsWasmUrl }));
function recipeCatalog(s: SaveSummary): RecipeInfo[] {
  const gd = gameData!;
  const unlocked = new Set(s.progression.unlockedRecipes);
  const buildables = new Set<string>();
  for (const [r, placed] of gd.buildRecipes) if (unlocked.has(r)) placed.forEach((b) => buildables.add(b));
  const out: RecipeInfo[] = [];
  for (const r of gd.recipes.values()) {
    if (r.manualOnly || r.durationSec <= 0) continue;
    const building = r.producedIn.find((b) => buildables.has(b)) ?? r.producedIn.find((b) => gd.buildings.has(b));
    if (!building) continue;
    const perMin = (a: number) => (a * 60) / r.durationSec;
    out.push({
      id: r.className, building, isAlternate: r.isAlternate,
      status: !unlocked.has(r.className) ? 'recipe-locked' : buildables.has(building) ? 'runnable' : 'building-locked',
      ingredients: r.ingredients.filter((a) => a.amount > 0).map((a) => ({ item: a.item, perMin: perMin(a.amount) })),
      products: r.products.filter((a) => a.amount > 0).map((a) => ({ item: a.item, perMin: perMin(a.amount) })),
    });
  }
  return out;
}

const post = (m: WorkerMessage) => self.postMessage(m);

function languageFromFileName(name: string): string {
  const m = /([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/i.exec(name.replace(/^.*[\\/]/, '').replace(/^[0-9a-f]{8}-/, ''));
  return m?.[1] ?? 'en-US';
}

function loadDocs(id: number, bytes: Uint8Array, fileName: string): GameDataInfo {
  post({ id, kind: 'progress', stage: 'decode' });
  const encoding = detectEncoding(bytes);
  const groups = readDocsFile(bytes);
  post({ id, kind: 'progress', stage: 'parse' });
  const gd = parseGameData(groups);
  if (gd.items.size === 0 || gd.recipes.size === 0) {
    throw new GameDataError('It has none of the recipe and item classes the planner needs.');
  }
  post({ id, kind: 'progress', stage: 'labels' });
  const language = languageFromFileName(fileName);
  const lb = parseLabels(groups, language);
  gameData = gd;
  labels = lb;
  if (summary) problem = buildProblem(summary).problem;
  return {
    contentHash: gd.contentHash, language, encoding, fileName, names: lb.names,
    itemCount: gd.items.size, recipeCount: gd.recipes.size, warnings: gd.warnings,
  };
}

function buildProblem(s: SaveSummary): { problem: PlanningProblem; nodes: NodeResolution } {
  if (!gameData) throw engineError('needs-game-data', 'Load game data first — the save is read against it.');
  const nodes = resolveNodes(s, gameData, catalog);
  return { problem: buildPlanningProblem(gameData, s, nodes), nodes };
}

function problemInfo(s: SaveSummary, p: PlanningProblem, nodes: NodeResolution): ProblemInfo {
  const label = makeLabel(labels?.names);
  const v = validateRequest(p, emptyRequest(), label);
  const reach = analyzeReachability(p, v.request, label);
  const used = new Set<string>();
  for (const r of [...p.recipes, ...p.unavailableRecipes.map((u) => ({ products: u.products.map((item) => ({ item })), ingredients: [] as { item: string }[] }))]) {
    for (const a of r.products) used.add(a.item);
    for (const a of r.ingredients) used.add(a.item);
  }
  const items = [...used].filter((i) => p.items[i]).map((i) => ({
    id: i, reachable: reach.reachable.has(i), raw: p.items[i]!.isRaw, fluid: p.items[i]!.fluid,
  }));
  const counts = [...nodes.counts].map(([resource, c]) => ({ resource, impure: c.impure, normal: c.normal, pure: c.pure }))
    .sort((a, b) => (b.impure + b.normal + b.pure) - (a.impure + a.normal + a.pure));
  const extractable = nodes.nodes.filter((n) => n.kind === 'resource-node' || n.kind === 'well-satellite');
  const mapNodes: MapNode[] = extractable.map((n) => ({
    id: n.id, kind: n.kind as MapNode['kind'], x: n.position[0], y: n.position[1], resource: n.resource, purity: n.purity,
    ...(n.wellCore ? { wellCore: n.wellCore } : {}),
  }));
  // Capacity per "normal-node equivalent", so the UI can recompute capacity after exclusions.
  const perNormalNode: Record<string, number> = {};
  for (const [res, cap] of Object.entries(p.mapAvailability)) {
    const units = extractable.filter((n) => n.resource === res && n.purity).reduce((u, n) => u + p.purityMultiplier[n.purity!], 0);
    if (units > 0) perNormalNode[res] = cap / units;
  }
  return {
    summaryKey: summaryKey(s),
    items,
    holdings: p.holdings,
    overclockUnlocked: p.overclock.unlocked,
    productionBoostUnlocked: p.productionBoost.unlocked,
    belt: p.transport.belt,
    pipe: p.transport.pipe,
    recipeCount: p.recipes.length,
    alternateRecipeCount: p.recipes.filter((r) => r.isAlternate).length,
    nodes: {
      extractable: extractable.length,
      geysers: nodes.nodes.filter((n) => n.kind === 'geyser').length,
      purityFromSave: extractable.filter((n) => n.puritySource === 'save-override').length,
      resourceFromSave: nodes.nodes.filter((n) => n.resourceSource === 'save-override').length,
      counts,
      assumptions: nodes.assumptions,
    },
    mapAvailability: p.mapAvailability,
    mapNodes,
    recipes: recipeCatalog(s),
    perNormalNode,
    assumptions: p.assumptions,
    warnings: [...p.warnings, ...nodes.warnings],
  };
}

function engineError(kind: EngineError['kind'], message: string, detail?: string): EngineError & Error {
  return Object.assign(new Error(message), { kind, message, detail });
}

function toEngineError(e: unknown, during: EngineRequest['type']): EngineError {
  if (e && typeof e === 'object' && 'kind' in e && typeof (e as EngineError).kind === 'string') {
    const x = e as EngineError;
    return { kind: x.kind, message: x.message, detail: x.detail };
  }
  const err = e instanceof Error ? e : new Error(String(e));
  if (during === 'loadDocs') {
    return { kind: 'not-docs', message: 'That isn’t the game’s Docs file', detail: err.message };
  }
  if (during === 'loadSave') {
    if (err instanceof SaveFormatError && err.code === 'unsupported-version') {
      return { kind: 'unsupported-version', message: err.message, detail: err.message };
    }
    return { kind: 'corrupt', message: 'Couldn’t read this save', detail: err.message };
  }
  if (during === 'solve') return { kind: 'solver', message: 'The solver failed', detail: err.message };
  return { kind: 'other', message: err.message, detail: err.stack };
}

async function handle(id: number, req: EngineRequest): Promise<EngineResponse> {
  switch (req.type) {
    case 'loadDocs':
      return { type: 'docs', info: loadDocs(id, req.bytes, req.fileName) };
    case 'loadSave': {
      if (!gameData) throw engineError('needs-game-data', 'Load game data first — the save is read against it.');
      const s = summarizeSaveBytes(req.bytes, gameData, {
        onStage: (stage, fraction) => post({ id, kind: 'progress', stage, ...(fraction !== undefined ? { fraction } : {}) }),
      });
      const built = buildProblem(s);
      summary = s;
      problem = built.problem;
      return { type: 'save', summary: s, problem: problemInfo(s, built.problem, built.nodes) };
    }
    case 'useSummary': {
      const built = buildProblem(req.summary);
      summary = req.summary;
      problem = built.problem;
      return { type: 'problem', problem: problemInfo(req.summary, built.problem, built.nodes) };
    }
    case 'solve': {
      if (!problem) throw engineError('needs-save', 'Load a save first.');
      post({ id, kind: 'progress', stage: 'solve' });
      const result = await solvePlan(problem, req.request, backend, req.options, makeLabel(labels?.names));
      return { type: 'solved', result };
    }
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: EngineRequest }>) => {
  const { id, req } = ev.data;
  try {
    const response = await handle(id, req);
    post({ id, kind: 'ok', response });
  } catch (e) {
    post({ id, kind: 'error', error: toEngineError(e, req.type) });
  }
};
