/**
 * App state: platform + plan store on the UI thread, parsing and solving in the
 * engine worker. The engine's loaded save always follows the active plan's save.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PlanStore, checkFreshness, rebasePlan, summaryKey, makeLabel, exportPlansToFile, importPlansFromFiles, type ImportReport,
  type Plan, type PlanListing, type PlanRequest, type SaveSummary, type SolveOptions, type Freshness, type Label, type KeyValueStore, type FileAccess,
} from '../src';
import { createBrowserPlatform } from '../src/platform/browser';
import { EngineClient } from './engine/client';
import { layoutGraph } from './graph/layout';
import type { EngineError, GameDataInfo, LayoutInput, LayoutOutput, ProblemInfo } from './engine/protocol';

export type LoadPhase = 'idle' | 'reading' | 'done' | 'warn' | 'error';
export interface LoadState { phase: LoadPhase; stage?: string; fraction?: number; fileName?: string; error?: EngineError }

export interface AppState {
  booting: boolean;
  fatal?: EngineError;
  storageWarnings: string[];
  noStorage: boolean;
  docs?: GameDataInfo;
  docsLoad: LoadState;
  saveLoad: LoadState;
  summary?: SaveSummary;
  problem?: ProblemInfo;
  plans: PlanListing[];
  plan?: Plan;
  planLoadErrors: string[];
  solving: boolean;
  solveError?: EngineError;
}

const KEY_DOCS = 'app:docs';
const KEY_SUMMARY = 'app:activeSummary';

interface Api {
  state: AppState;
  label: Label;
  freshness?: Freshness;
  loadDocs(file: { name: string; read(): Promise<Uint8Array> }): Promise<void>;
  loadSave(file: { name: string; read(): Promise<Uint8Array> }): Promise<void>;
  pick(purpose: 'game-data' | 'save'): Promise<void>;
  openPlan(id: string): Promise<void>;
  newPlan(): Promise<void>;
  renamePlan(name: string): Promise<void>;
  updateRequest(fn: (r: PlanRequest) => PlanRequest): void;
  updateOptions(patch: Partial<SolveOptions>): void;
  solve(override?: Partial<PlanRequest>): Promise<void>;
  layout(graph: LayoutInput): Promise<LayoutOutput>;
  planRows(): Promise<PlanRow[]>;
  duplicatePlan(id: string): Promise<void>;
  deletePlan(id: string): Promise<void>;
  renamePlanById(id: string, name: string): Promise<void>;
  exportPlans(ids?: string[]): Promise<{ fileName: string; plans: number } | undefined>;
  importPlans(): Promise<ImportReport | undefined>;
  files?: FileAccess;
}

export interface PlanRow {
  listing: PlanListing;
  plan?: Plan;
  errors: string[];
  freshness?: Freshness;
}

const Ctx = createContext<Api | null>(null);
export const useApp = (): Api => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
};

const initial: AppState = {
  booting: true, storageWarnings: [], noStorage: false, docsLoad: { phase: 'idle' }, saveLoad: { phase: 'idle' },
  plans: [], planLoadErrors: [], solving: false,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initial);
  const patch = useCallback((p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => {
    setState((s) => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
  }, []);
  const engine = useMemo(() => new EngineClient(), []);
  const kv = useRef<KeyValueStore>();
  const files = useRef<FileAccess>();
  const store = useRef<PlanStore>();
  const stateRef = useRef(state);
  stateRef.current = state;
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const refreshPlans = useCallback(async () => {
    if (store.current) patch({ plans: await store.current.listPlans() });
  }, [patch]);

  /** Point the engine at a summary (if not already) and record it as the active save. */
  const useSummary = useCallback(async (s: SaveSummary) => {
    const key = summaryKey(s);
    if (stateRef.current.problem?.summaryKey === key) return;
    const r = await engine.request<'problem'>({ type: 'useSummary', summary: s });
    patch({ summary: s, problem: r.problem });
    await kv.current?.set(KEY_SUMMARY, key);
  }, [engine, patch]);

  const activate = useCallback(async (plan: Plan) => {
    patch({ plan, planLoadErrors: [], solveError: undefined });
    await store.current?.setActivePlanId(plan.id);
    const s = await store.current?.getSummary(plan.save.summaryKey);
    if (s && stateRef.current.docs) await useSummary(s);
  }, [patch, useSummary]);

  // ---- Boot
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { platform, warnings } = await createBrowserPlatform();
      kv.current = platform.store;
      files.current = platform.files;
      const ps = new PlanStore(platform.store);
      store.current = ps;
      const init = await ps.init();
      const noStorage = warnings.length > 0;
      patch({ storageWarnings: noStorage ? warnings : init.warnings, noStorage });

      const docs = await platform.store.get<{ bytes: Uint8Array; fileName: string }>(KEY_DOCS);
      let haveDocs = false;
      if (docs) {
        try {
          const r = await engine.request<'docs'>({ type: 'loadDocs', bytes: docs.bytes, fileName: docs.fileName });
          patch({ docs: r.info, docsLoad: { phase: 'done', fileName: docs.fileName } });
          haveDocs = true;
        } catch { /* stored copy unreadable: fall back to first run */ }
      }
      const listing = await ps.listPlans();
      patch({ plans: listing });
      const activeId = await ps.getActivePlanId();
      let restored = false;
      if (activeId && haveDocs) {
        const lp = await ps.loadPlan(activeId);
        if (lp.plan) {
          const s = await ps.getSummary(lp.plan.save.summaryKey);
          if (s) {
            await useSummary(s);
            patch({ plan: lp.plan, saveLoad: { phase: s.version.status === 'warning' ? 'warn' : 'done', fileName: s.source.saveName } });
            restored = true;
          }
        } else if (lp.errors.length) patch({ planLoadErrors: lp.errors });
      }
      if (!restored && haveDocs) {
        const key = await platform.store.get<string>(KEY_SUMMARY);
        const s = key ? await ps.getSummary(key) : undefined;
        if (s) {
          await useSummary(s);
          patch({ saveLoad: { phase: s.version.status === 'warning' ? 'warn' : 'done', fileName: s.source.saveName } });
        }
      }
      if (!cancelled) patch({ booting: false });
    })().catch((e) => patch({ booting: false, fatal: { kind: 'other', message: 'The planner couldn’t start', detail: String(e?.stack ?? e) } }));
    return () => { cancelled = true; };
  }, [engine, patch, useSummary]);

  // ---- Loading files
  const loadDocs = useCallback<Api['loadDocs']>(async (file) => {
    patch({ docsLoad: { phase: 'reading', stage: 'decode', fileName: file.name } });
    try {
      const bytes = await file.read();
      const r = await engine.request<'docs'>({ type: 'loadDocs', bytes, fileName: file.name },
        (stage) => patch((s) => ({ docsLoad: { ...s.docsLoad, stage } })));
      await kv.current?.set(KEY_DOCS, { bytes, fileName: file.name });
      patch({ docs: r.info, docsLoad: { phase: 'done', fileName: file.name } });
      // Game data changed: rebuild the current save's problem against it.
      const s = stateRef.current.summary;
      if (s) {
        const p = await engine.request<'problem'>({ type: 'useSummary', summary: s });
        patch({ problem: p.problem });
      }
    } catch (e) {
      patch({ docsLoad: { phase: 'error', fileName: file.name, error: e as EngineError } });
    }
  }, [engine, patch]);

  const loadSave = useCallback<Api['loadSave']>(async (file) => {
    patch({ saveLoad: { phase: 'reading', stage: 'header', fraction: 0, fileName: file.name } });
    try {
      const bytes = await file.read();
      const r = await engine.request<'save'>({ type: 'loadSave', bytes, fileName: file.name },
        (stage, fraction) => patch((s) => ({ saveLoad: { ...s.saveLoad, stage, fraction } })));
      const ps = store.current!;
      const key = await ps.putSummary(r.summary);
      await kv.current?.set(KEY_SUMMARY, key);
      patch({ summary: r.summary, problem: r.problem, saveLoad: { phase: r.summary.version.status === 'warning' ? 'warn' : 'done', fileName: file.name } });
      // Keep working on the same session: rebase the active plan onto the new summary.
      const cur = stateRef.current.plan;
      if (cur && cur.save.saveIdentifier === r.summary.source.saveIdentifier) {
        if (cur.save.summaryKey !== key) {
          const rb = rebasePlan(cur, r.summary, new Date());
          const saved = await ps.putPlan(rb.plan, { touch: true });
          patch({ plan: saved });
        }
      } else {
        const existing = (await ps.listPlans()).length;
        const plan = await ps.createPlan(`Plan ${existing + 1}`, r.summary);
        await ps.setActivePlanId(plan.id);
        patch({ plan });
      }
      await refreshPlans();
    } catch (e) {
      patch({ saveLoad: { phase: 'error', fileName: file.name, error: e as EngineError } });
    }
  }, [engine, patch, refreshPlans]);

  const pick = useCallback<Api['pick']>(async (purpose) => {
    const f = files.current;
    if (!f) return;
    const picked = await f.pickFiles({ accept: purpose === 'save' ? ['.sav'] : ['.json'], purpose });
    const file = picked[0];
    if (!file) return;
    if (purpose === 'save') await loadSave(file); else await loadDocs(file);
  }, [loadDocs, loadSave]);

  // ---- Plans
  const openPlan = useCallback<Api['openPlan']>(async (id) => {
    const lp = await store.current!.loadPlan(id);
    if (!lp.plan) { patch({ planLoadErrors: lp.errors }); return; }
    await activate(lp.plan);
  }, [activate, patch]);

  const openPlanRef = useRef(openPlan);
  openPlanRef.current = openPlan;

  const newPlan = useCallback<Api['newPlan']>(async () => {
    const s = stateRef.current.summary;
    if (!s) return;
    const plan = await store.current!.createPlan(`Plan ${stateRef.current.plans.length + 1}`, s);
    await activate(plan);
    await refreshPlans();
  }, [activate, refreshPlans]);

  const persistSoon = useCallback((plan: Plan) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void store.current?.putPlan(plan, { touch: true }).then(refreshPlans); }, 400);
  }, [refreshPlans]);

  const renamePlan = useCallback<Api['renamePlan']>(async (name) => {
    const p = stateRef.current.plan;
    if (!p || !name.trim()) return;
    const saved = await store.current!.renamePlan(p.id, name.trim());
    patch({ plan: saved });
    await refreshPlans();
  }, [patch, refreshPlans]);

  const updateRequest = useCallback<Api['updateRequest']>((fn) => {
    const p = stateRef.current.plan;
    if (!p) return;
    const plan = { ...p, request: fn(p.request) };
    patch({ plan });
    persistSoon(plan);
  }, [patch, persistSoon]);

  const updateOptions = useCallback<Api['updateOptions']>((o) => {
    const p = stateRef.current.plan;
    if (!p) return;
    const plan = { ...p, solveOptions: { ...p.solveOptions, ...o } };
    patch({ plan });
    persistSoon(plan);
  }, [patch, persistSoon]);

  const solve = useCallback<Api['solve']>(async (override) => {
    let p = stateRef.current.plan;
    if (!p) return;
    if (override) { p = { ...p, request: { ...p.request, ...override } }; patch({ plan: p }); }
    clearTimeout(saveTimer.current);
    patch({ solving: true, solveError: undefined });
    try {
      const s = await store.current!.getSummary(p.save.summaryKey);
      if (s) await useSummary(s);
      await store.current!.putPlan(p, { touch: true });
      const r = await engine.request<'solved'>({ type: 'solve', request: p.request, options: p.solveOptions });
      const saved = await store.current!.recordResult(p.id, r.result);
      patch({ plan: saved, solving: false });
      await refreshPlans();
    } catch (e) {
      patch({ solving: false, solveError: e as EngineError });
    }
  }, [engine, patch, refreshPlans, useSummary]);

  const layout = useCallback<Api['layout']>((graph) => layoutGraph(graph), []);

  const planRows = useCallback<Api['planRows']>(async () => {
    const ps = store.current;
    if (!ps) return [];
    const listing = await ps.listPlans();
    const hash = stateRef.current.docs?.contentHash;
    return Promise.all(listing.map(async (l) => {
      const lp = await ps.loadPlan(l.id);
      return { listing: l, plan: lp.plan, errors: lp.errors, freshness: lp.plan && hash ? checkFreshness(lp.plan, { gameDataHash: hash }) : undefined };
    }));
  }, []);

  const duplicatePlan = useCallback<Api['duplicatePlan']>(async (id) => {
    await store.current!.duplicatePlan(id);
    await refreshPlans();
  }, [refreshPlans]);

  const deletePlan = useCallback<Api['deletePlan']>(async (id) => {
    const ps = store.current!;
    await ps.deletePlan(id);
    const rest = await ps.listPlans();
    patch({ plans: rest });
    if (stateRef.current.plan?.id === id) {
      const next = rest[0];
      if (next) await openPlanRef.current(next.id);
      else { patch({ plan: undefined }); await ps.setActivePlanId(undefined); }
    }
  }, [patch]);

  const renamePlanById = useCallback<Api['renamePlanById']>(async (id, name) => {
    if (!name.trim()) return;
    const saved = await store.current!.renamePlan(id, name.trim());
    if (stateRef.current.plan?.id === id) patch({ plan: saved });
    await refreshPlans();
  }, [patch, refreshPlans]);

  const exportPlans = useCallback<Api['exportPlans']>(async (ids) => {
    if (!files.current || !store.current) return undefined;
    return exportPlansToFile(files.current, store.current, ids);
  }, []);

  const importPlans = useCallback<Api['importPlans']>(async () => {
    if (!files.current || !store.current) return undefined;
    const r = await importPlansFromFiles(files.current, store.current);
    await refreshPlans();
    // An imported newer copy of the open plan replaces it in the store: reload it.
    const cur = stateRef.current.plan;
    if (cur && r.imported.some((x) => x.id === cur.id)) await openPlanRef.current(cur.id);
    return r;
  }, [refreshPlans]);

  const label = useMemo(() => makeLabel(state.docs?.names), [state.docs]);
  const freshness = useMemo(
    () => (state.plan && state.docs ? checkFreshness(state.plan, { gameDataHash: state.docs.contentHash }) : undefined),
    [state.plan, state.docs],
  );

  const api: Api = {
    state, label, freshness, loadDocs, loadSave, pick, openPlan, newPlan, renamePlan, updateRequest, updateOptions, solve,
    layout, planRows, duplicatePlan, deletePlan, renamePlanById, exportPlans, importPlans,
    files: files.current,
  };
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
