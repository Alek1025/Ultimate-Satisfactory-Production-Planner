/** CatalogPack loading, pinning and node resolution against the six saves (rewrite-notes §2). */
import { describe, expect, it } from 'vitest';
import { parseNodeCatalog, readCatalogPack, resolveNodes, NodeCatalogError } from '../src/gamedata/node-catalog';
import { sha256Hex } from '../src/util/hash';
import { FIXTURE_SHA256, fixture, gameData, nodeCatalog, parsedSave, saveSummary, SAVE_FILES } from './fixtures';

/** Base-map node counts per resource and purity [impure, normal, pure] (the wiki's Resource Node table). */
const BASE_MAP: Record<string, [number, number, number]> = {
  Desc_OreIron_C: [39, 42, 46], Desc_OreCopper_C: [13, 29, 13], Desc_Stone_C: [15, 50, 29],
  Desc_Coal_C: [15, 31, 16], Desc_OreGold_C: [0, 9, 8], Desc_RawQuartz_C: [3, 7, 7],
  Desc_Sulfur_C: [6, 5, 5], Desc_OreBauxite_C: [5, 6, 6], Desc_OreUranium_C: [3, 2, 0],
  Desc_SAM_C: [10, 6, 3], Desc_LiquidOil_C: [10 + 8, 12 + 6, 8 + 4], // 30 oil nodes + 18 oil-well satellites
  Desc_NitrogenGas_C: [2, 7, 36], Desc_Water_C: [7, 12, 36],
};

describe('CatalogPack file', () => {
  const bytes = fixture('node-catalog-1.2.json');

  it('loads with its pinned hash and covers 608 nodes + 17 well cores', () => {
    const pack = readCatalogPack(bytes, { expectedSha256: FIXTURE_SHA256['node-catalog-1.2.json'] });
    expect(pack.sha256).toBe(sha256Hex(bytes));
    expect(pack.catalog.entries.size).toBe(625);
    expect(pack.catalog.gameVersion).toBe('1.2');
  });

  it('rejects a pack whose bytes do not match the pinned hash', () => {
    const edited = new Uint8Array(bytes);
    edited[edited.length - 2] = 0x20;
    try { readCatalogPack(edited, { expectedSha256: FIXTURE_SHA256['node-catalog-1.2.json'] }); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(NodeCatalogError);
      expect((e as NodeCatalogError).code).toBe('hash-mismatch');
    }
    expect(readCatalogPack(edited).sha256).not.toBe(FIXTURE_SHA256['node-catalog-1.2.json']);
  });

  it('validates entries as untrusted input', () => {
    const base = { source: 't', gameVersion: '1.2' };
    expect(() => parseNodeCatalog({ entries: [] })).toThrow(NodeCatalogError);
    expect(() => parseNodeCatalog({ ...base, entries: [{ id: 'A', kind: 'volcano' }] })).toThrow(/kind/);
    expect(() => parseNodeCatalog({ ...base, entries: [{ id: 'A', kind: 'resource-node', purity: 'ultra' }] })).toThrow(/purity/);
    expect(() => parseNodeCatalog({ ...base, entries: [{ id: 'A', kind: 'resource-node' }, { id: 'A', kind: 'geyser' }] })).toThrow(/Duplicate/);
    expect(() => parseNodeCatalog({ ...base, entries: [{ id: 'S', kind: 'well-satellite', wellCore: 'C' }] })).toThrow(/well core/);
    expect(() => readCatalogPack(new TextEncoder().encode('{nope'))).toThrow(/not valid JSON/);
    const ok = parseNodeCatalog({ ...base, entries: [{ id: 'A', kind: 'resource-node', resource: 'Desc_OreIron_C', purity: 'pure', extra: 1 }] });
    expect(ok.entries.get('A')).toEqual({ id: 'A', kind: 'resource-node', resource: 'Desc_OreIron_C', purity: 'pure' });
  });

  it('well satellites point at real well cores with a matching resource', () => {
    const catalog = nodeCatalog();
    const cores = new Map([...catalog.entries.values()].filter((e) => e.kind === 'well-core').map((e) => [e.id, e.resource]));
    expect(cores.size).toBe(17);
    for (const e of catalog.entries.values()) if (e.kind === 'well-satellite') expect(cores.get(e.wellCore!)).toBe(e.resource);
  });
});

describe('node resolution', () => {
  const resolve = (f: (typeof SAVE_FILES)[number], withCatalog = true) => resolveNodes(saveSummary(f), gameData(), withCatalog ? nodeCatalog() : undefined);

  it('the catalog covers exactly the nodes in every fixture save', () => {
    for (const f of SAVE_FILES) {
      const r = resolve(f);
      expect(r.warnings).toEqual([]);
      expect(r.nodes.filter((n) => n.kind !== 'geyser' && n.kind !== 'well-core').every((n) => n.resource && n.purity)).toBe(true);
    }
  });

  it('the default save resolves to the base map', () => {
    const r = resolve('default.sav');
    expect(Object.fromEntries([...r.counts].map(([k, c]) => [k, [c.impure, c.normal, c.pure]]))).toEqual(BASE_MAP);
    expect(r.assumptions[0]).toMatch(/resource type for 577 node\(s\), purity for 577 node\(s\)/);
  });

  it('save overrides win: all-pure, strict and rich saves', () => {
    const pure = resolve('all-pure-nodes.sav');
    expect([...pure.counts.values()].every((c) => c.impure === 0 && c.normal === 0)).toBe(true);
    expect(pure.counts.get('Desc_OreIron_C')!.pure).toBe(127);

    const strict = resolve('random-nodes.sav');
    expect(strict.assumptions[0]).toMatch(/resource type for 0 node\(s\), purity for 459 node\(s\)/);
    const iron = strict.counts.get('Desc_OreIron_C')!;
    expect(iron.impure + iron.normal + iron.pure).toBe(127);

    expect(resolve('resource-rich-random-purity.sav').assumptions).toEqual([]);
  });

  it('a save override beats the catalog purity, and missing entries are reported', () => {
    const s = saveSummary('all-pure-nodes.sav');
    const first = s.nodes.find((n) => n.kind === 'resource-node')!;
    const cat = parseNodeCatalog({ source: 'test', gameVersion: '1.2', entries: [{ id: first.id, kind: 'resource-node', resource: 'Desc_OreIron_C', purity: 'impure' }] });
    const r = resolveNodes(s, gameData(), cat);
    const n = r.nodes.find((x) => x.id === first.id)!;
    expect(n.purity).toBe('pure');
    expect(n.puritySource).toBe('save-override');
    expect(r.counts.get('Desc_OreIron_C')).toEqual({ impure: 0, normal: 0, pure: 1 });
    expect(r.warnings.some((w) => /missing from the node catalog/.test(w))).toBe(true);
  });

  it('without a catalog: strict randomization still needs map purity for resource nodes', () => {
    const r = resolve('random-nodes.sav', false);
    const nodes = r.nodes.filter((n) => n.kind === 'resource-node');
    expect(nodes.every((n) => n.resourceSource === 'save-override' && n.purity === null && n.puritySource === 'unknown')).toBe(true);
    const sats = r.nodes.filter((n) => n.kind === 'well-satellite');
    expect(sats.every((n) => n.resourceSource === 'save-override' && n.puritySource === 'save-override')).toBe(true);
    expect(nodes.filter((n) => n.resource === 'Desc_OreIron_C').length).toBe(127);
    expect(r.warnings[0]).toMatch(/No node catalog/);
  });

  it('without a catalog: resource-rich + random purity resolves every node from the save alone', () => {
    const r = resolve('resource-rich-random-purity.sav', false);
    expect(r.warnings).toEqual([]);
    const ext = r.nodes.filter((n) => n.kind === 'resource-node' || n.kind === 'well-satellite');
    expect(ext.length).toBe(577);
    expect(ext.every((n) => n.resource && n.purity && n.resourceSource === 'save-override' && n.puritySource === 'save-override')).toBe(true);
    expect(r.counts.get('Desc_OreUranium_C')).toEqual({ impure: 10, normal: 14, pure: 16 });
  });

  it('without a catalog: the default save resolves nothing and says so', () => {
    const r = resolve('default.sav', false);
    expect(r.nodes.every((n) => n.resource === null && n.resourceSource === 'unknown')).toBe(true);
    expect(r.warnings[0]).toMatch(/No node catalog/);
  });

  it('agrees with what extractors in played saves are actually producing (43/43)', () => {
    const catalog = nodeCatalog();
    let checked = 0;
    for (const f of ['obsidian-gears.sav', 'max-milestone-multiplier.sav', 'all-pure-nodes.sav'] as const) {
      const byInst = new Map(parsedSave(f).levels.flatMap((l) => l.objects).map((o) => [o.instanceName, o]));
      for (const o of byInst.values()) {
        if (!/^Build_(Miner|OilPump)/.test(o.className)) continue;
        const node = (o.properties.mExtractableResource?.value as { pathName?: string } | undefined)?.pathName;
        const stacks = (byInst.get(`${o.instanceName}.OutputInventory`)?.properties.mInventoryStacks?.value ?? []) as Array<{ value: Record<string, { value: any }> }>;
        const items = new Set(stacks.filter((s) => s.value.NumItems?.value > 0).map((s) => String(s.value.Item!.value.value.item.pathName).split('.').pop()));
        if (!node || items.size !== 1) continue;
        expect(catalog.entries.get(node.replace(/^.*\./, ''))?.resource).toBe([...items][0]);
        checked++;
      }
    }
    expect(checked).toBe(43);
  });
});
