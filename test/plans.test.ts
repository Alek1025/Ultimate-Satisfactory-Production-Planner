import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { summarizeSave } from '../src/save/extract';
import { readSave } from '../src/save/save-reader';
import { loadBundledNodeCatalog, resolveNodes } from '../src/gamedata/node-catalog';
import { buildPlanningProblem } from '../src/solver/problem';
import { solvePlan } from '../src/solver/solve';
import type { SaveSummary } from '../src/save/summary-types';
import { MemoryStore } from '../src/platform/memory';
import { IndexedDbStore } from '../src/platform/browser/indexeddb-store';
import type { FileAccess, PickedFile } from '../src/platform/types';
import {
  PlanStore, PlanImportError, checkFreshness, rebasePlan, summaryKey, bundleToBytes, bytesToJson,
  exportPlansToFile, importPlansFromFiles, parsePlan, PLAN_SCHEMA_VERSION, type Plan,
} from '../src/plans';
import { fixture, gameData, hasFixture } from './fixtures';
import { backend } from './solver-helpers';

const SAVE = 'obsidian-gears.sav';
let cachedSummary: SaveSummary | undefined;
const summary = () => (cachedSummary ??= summarizeSave(readSave(fixture(SAVE)), gameData()));

let clock = Date.parse('2026-10-24T12:00:00Z');
const opts = () => {
  let n = 0;
  return { now: () => new Date((clock += 1000)), newId: () => `id${String(++n).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}` };
};

async function solvedPlan(store: PlanStore, name = 'Plates'): Promise<Plan> {
  const s = summary();
  const plan = await store.createPlan(name, s, {
    ...(await import('../src/plans')).emptyRequest(), targets: [{ item: 'Desc_IronPlate_C', ratePerMin: 60 }],
  });
  const problem = buildPlanningProblem(gameData(), s, resolveNodes(s, gameData(), loadBundledNodeCatalog()));
  const result = await solvePlan(problem, plan.request, backend, plan.solveOptions);
  return store.recordResult(plan.id, result);
}

const ctx = () => ({ gameDataHash: gameData().contentHash });

describe.skipIf(!hasFixture(SAVE))('plan store', () => {
  it('stores a solved plan and reports it fresh', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const back = (await store.getPlan(plan.id))!;
    expect(back).toEqual(plan);
    expect(checkFreshness(back, ctx())).toEqual({ state: 'fresh', reasons: [], messages: [] });
    const list = await store.listPlans();
    expect(list).toEqual([expect.objectContaining({ id: plan.id, name: 'Plates', sessionName: summary().source.sessionName, resultStatus: 'optimal' })]);
  });

  it('flags edits, other game data and other save states as stale', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const edited = await store.putPlan({ ...plan, request: { ...plan.request, targets: [{ item: 'Desc_IronPlate_C', ratePerMin: 90 }] } });
    expect(checkFreshness(edited, ctx()).reasons).toEqual(['request-changed']);

    const other = checkFreshness(plan, { gameDataHash: 'ffffffffffffff' });
    expect(other.reasons).toEqual(['game-data-changed']);
    expect(other.messages[0]).toMatch(/solved against different game data/);

    const newer = { ...summary(), source: { ...summary().source, savedAt: '2026-10-25T00:00:00.000Z' } };
    const { plan: rebased, warnings } = rebasePlan(plan, newer, new Date());
    expect(warnings).toEqual([]);
    expect(checkFreshness(rebased, ctx()).reasons).toEqual(['save-changed']);
    const elsewhere = rebasePlan(plan, { ...newer, source: { ...newer.source, saveIdentifier: 'someone-else' } }, new Date());
    expect(elsewhere.warnings[0]).toMatch(/looks like a different save/);
  });

  it('shares one summary between plans and deletes it with the last one', async () => {
    const kv = new MemoryStore();
    const store = new PlanStore(kv, opts());
    const a = await store.createPlan('A', summary());
    const b = await store.createPlan('B', summary());
    expect(a.save.summaryKey).toBe(b.save.summaryKey);
    expect(await kv.keys('summary:')).toHaveLength(1);
    await store.setActivePlanId(a.id);
    await store.deletePlan(a.id);
    expect(await store.getActivePlanId()).toBeUndefined();
    expect(await kv.keys('summary:')).toHaveLength(1);
    await store.deletePlan(b.id);
    expect(await kv.keys('')).toEqual([]);
  });

  it('duplicates and renames', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const copy = await store.duplicatePlan(plan.id);
    expect(copy.id).not.toBe(plan.id);
    expect(copy.name).toBe('Plates (copy)');
    expect(copy.lastResult).toEqual(plan.lastResult);
    expect((await store.renamePlan(copy.id, '  Plates v2 ')).name).toBe('Plates v2');
  });
});

describe.skipIf(!hasFixture(SAVE))('export / import', () => {
  it('round-trips plans, results and summaries into a fresh store', async () => {
    const src = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(src);
    const bytes = bundleToBytes(await src.exportBundle());
    const dst = new PlanStore(new MemoryStore(), opts());
    const report = await dst.importBundle(bytesToJson(bytes));
    expect(report).toEqual({ imported: [{ id: plan.id, name: plan.name }], skipped: 0, warnings: [] });
    const back = (await dst.getPlan(plan.id))!;
    expect(back).toEqual(plan);
    expect(await dst.getSummary(plan.save.summaryKey)).toEqual(JSON.parse(JSON.stringify(summary())));
    expect(checkFreshness(back, ctx()).state).toBe('fresh');
  });

  it('a summary keeps its key through JSON', () => {
    expect(summaryKey(JSON.parse(JSON.stringify(summary())))).toBe(summaryKey(summary()));
  });

  it('merges with plans that already exist', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const file = JSON.parse(JSON.stringify(await store.exportBundle()));

    const same = await store.importBundle(file);
    expect([same.imported.length, same.skipped]).toEqual([0, 1]);

    await store.renamePlan(plan.id, 'Edited here'); // local copy is now newer than the file
    const kept = await store.importBundle(file);
    expect(kept.imported[0]).toEqual(expect.objectContaining({ name: 'Plates (imported)', renamedFrom: plan.id }));
    expect((await store.getPlan(plan.id))!.name).toBe('Edited here');

    const newer = structuredClone(file);
    newer.plans[0].name = 'Newer in file';
    newer.plans[0].updatedAt = '2030-01-01T00:00:00.000Z';
    await store.importBundle(newer);
    expect((await store.getPlan(plan.id))!.name).toBe('Newer in file');

    const clash = structuredClone(file);
    clash.plans[0].createdAt = '2020-01-01T00:00:00.000Z'; // same id, different plan
    const r = await store.importBundle(clash);
    expect(r.imported[0]!.id).not.toBe(plan.id);
  });

  it('re-keys an edited summary so it cannot pose as the original', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const file = JSON.parse(JSON.stringify(await store.exportBundle()));
    file.summaries[plan.save.summaryKey].holdings.somersloops.total = 999;
    const dst = new PlanStore(new MemoryStore(), opts());
    const r = await dst.importBundle(file);
    expect(r.warnings[0]).toMatch(/did not match its key/);
    const back = (await dst.getPlan(plan.id))!;
    expect(back.save.summaryKey).not.toBe(plan.save.summaryKey);
    expect((await dst.getSummary(back.save.summaryKey))!.holdings.somersloops.total).toBe(999);
  });

  it('imports a bare plan and says when its save is missing', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(store);
    const dst = new PlanStore(new MemoryStore(), opts());
    const r = await dst.importBundle(JSON.parse(JSON.stringify(plan)));
    expect(r.imported).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/save summary isn't in the file/);
  });

  it('rejects files it cannot use, and newer versions with a clear message', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    await expect(store.importBundle({ hello: 1 })).rejects.toThrow(PlanImportError);
    await expect(store.importBundle({ format: 'satisfactory-planner.plans', formatVersion: 99, plans: [] })).rejects.toThrow(/newer version/);
    const plan = await solvedPlan(store);
    const future = { ...JSON.parse(JSON.stringify(plan)), schemaVersion: PLAN_SCHEMA_VERSION + 1, id: 'future1' };
    const r = await store.importBundle({ format: 'satisfactory-planner.plans', formatVersion: 1, plans: [future], summaries: {} });
    expect(r.skipped).toBe(1);
    expect(r.warnings[0]).toMatch(/made by a newer version of the planner/);
  });

  it('validates untrusted plan JSON field by field', async () => {
    const store = new PlanStore(new MemoryStore(), opts());
    const good = JSON.parse(JSON.stringify(await solvedPlan(store)));
    expect(parsePlan(good).errors).toEqual([]);
    const bad = (f: (p: Record<string, any>) => void) => { const p = structuredClone(good); f(p); return parsePlan(p); };
    expect(bad((p) => { p.request.targets[0].ratePerMin = -5; }).errors[0]).toMatch(/targets\.0\.ratePerMin: out of range/);
    expect(bad((p) => { p.request.targets[0].item = '<script>'; }).errors[0]).toMatch(/not a valid item ClassName/);
    expect(bad((p) => { p.name = 'x'.repeat(5000); }).errors[0]).toMatch(/longer than 200/);
    expect(bad((p) => { p.id = '../../etc'; }).errors[0]).toMatch(/not a valid plan id/);
    // A broken result is dropped; the plan survives.
    const r = bad((p) => { p.lastResult.result.buildings = 'nope'; });
    expect(r.plan).toBeDefined();
    expect(r.plan!.lastResult).toBeUndefined();
    expect(r.warnings[0]).toMatch(/Dropped the stored result/);
  });

  it('reads UTF-16 plan files (e.g. re-saved in Notepad)', () => {
    const json = JSON.stringify({ a: 'é' });
    const utf16 = new Uint8Array(2 + json.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < json.length; i++) { utf16[2 + i * 2] = json.charCodeAt(i) & 0xff; utf16[3 + i * 2] = json.charCodeAt(i) >> 8; }
    expect(bytesToJson(utf16)).toEqual({ a: 'é' });
    expect(() => bytesToJson(new TextEncoder().encode('{nope'))).toThrow(/not valid JSON/);
  });

  it('exports and imports through the platform FileAccess', async () => {
    const written: { name: string; bytes: Uint8Array; mime: string }[] = [];
    const files: FileAccess = {
      async pickFiles() {
        return [
          ...written.map((w): PickedFile => ({ name: w.name, read: async () => w.bytes })),
          { name: 'junk.json', read: async () => new TextEncoder().encode('[1,2') },
        ];
      },
      async exportFile(name, bytes, mime) { written.push({ name, bytes, mime }); },
    };
    const src = new PlanStore(new MemoryStore(), opts());
    const plan = await solvedPlan(src, 'Iron: plates/rods?');
    const out = await exportPlansToFile(files, src, [plan.id]);
    expect(out).toEqual({ fileName: 'Iron plates rods.satplan.json', plans: 1 });
    expect(written[0]!.mime).toBe('application/json');
    const dst = new PlanStore(new MemoryStore(), opts());
    const r = await importPlansFromFiles(files, dst);
    expect(r.imported).toHaveLength(1);
    expect(r.warnings).toEqual([expect.stringMatching(/^junk\.json: The file is not valid JSON/)]);
  });
});

describe('IndexedDB store (browser backend)', () => {
  it('implements the KeyValueStore contract', async () => {
    const kv = await IndexedDbStore.open('t1', new IDBFactory());
    await kv.set('plan:a', { x: 1, nested: [1, 2, { y: undefined }] });
    await kv.set('plan:b', 2);
    await kv.set('result:a', 3);
    expect(await kv.get('plan:a')).toEqual({ x: 1, nested: [1, 2, { y: undefined }] });
    expect(await kv.get('missing')).toBeUndefined();
    expect(await kv.keys('plan:')).toEqual(['plan:a', 'plan:b']);
    await kv.delete('plan:a');
    expect(await kv.get('plan:a')).toBeUndefined();
    expect(await kv.keys()).toEqual(['plan:b', 'result:a']);
    expect(await kv.requestPersistence()).toBe(false); // no navigator.storage in Node
    kv.close();
  });

  it.skipIf(!hasFixture(SAVE))('runs the plan store end to end', async () => {
    const kv = await IndexedDbStore.open('t2', new IDBFactory());
    const store = new PlanStore(kv, opts());
    const init = await store.init();
    expect(init.persistent).toBe(false);
    expect(init.warnings[0]).toMatch(/did not grant persistent storage/);
    const plan = await solvedPlan(store);
    expect(await store.getPlan(plan.id)).toEqual(plan);
    kv.close();
  });
});
