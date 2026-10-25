import { describe, expect, it } from 'vitest';
import { readSave } from '../src/save/save-reader';
import { summarizeSave } from '../src/save/extract';
import { loadBundledNodeCatalog, resolveNodes } from '../src/gamedata/node-catalog';
import { fixture, gameData, hasFixture, PRESENT_SAVES } from './fixtures';

const catalog = loadBundledNodeCatalog();
const summary = (f: string) => summarizeSave(readSave(fixture(f)), gameData());

/** Base-map node counts per resource and purity (matches the official wiki's Resource Node table). */
const BASE_MAP: Record<string, [number, number, number]> = {
  Desc_OreIron_C: [39, 42, 46], Desc_OreCopper_C: [13, 29, 13], Desc_Stone_C: [15, 50, 29],
  Desc_Coal_C: [15, 31, 16], Desc_OreGold_C: [0, 9, 8], Desc_RawQuartz_C: [3, 7, 7],
  Desc_Sulfur_C: [6, 5, 5], Desc_OreBauxite_C: [5, 6, 6], Desc_OreUranium_C: [3, 2, 0],
  Desc_SAM_C: [10, 6, 3], Desc_LiquidOil_C: [10 + 8, 12 + 6, 8 + 4], // 30 oil nodes + 18 oil-well satellites
  Desc_NitrogenGas_C: [2, 7, 36], Desc_Water_C: [7, 12, 36],
};

describe('bundled 1.2 node catalog', () => {
  it('covers exactly the nodes in every fixture save', () => {
    expect(catalog.entries.size).toBe(625);
    for (const f of Object.keys(PRESENT_SAVES)) {
      const r = resolveNodes(summary(f), gameData(), catalog);
      expect(r.warnings).toEqual([]);
      expect(r.nodes.filter((n) => n.kind !== 'geyser' && n.kind !== 'well-core').every((n) => n.resource && n.purity)).toBe(true);
    }
  });

  it.skipIf(!hasFixture('default.sav', 'en-US.json'))('default save resolves to the base map', () => {
    const r = resolveNodes(summary('default.sav'), gameData(), catalog);
    const got = Object.fromEntries([...r.counts].map(([k, c]) => [k, [c.impure, c.normal, c.pure]]));
    expect(got).toEqual(BASE_MAP);
    expect(r.assumptions[0]).toMatch(/resource type for 577 node\(s\), purity for 577 node\(s\)/);
  });

  it.skipIf(!hasFixture('all-pure-nodes.sav', 'random-nodes.sav', 'resource-rich-random-purity.sav', 'en-US.json'))('save overrides win: all-pure, strict and rich saves', () => {
    const pure = resolveNodes(summary('all-pure-nodes.sav'), gameData(), catalog);
    expect([...pure.counts.values()].every((c) => c.impure === 0 && c.normal === 0)).toBe(true);
    expect(pure.counts.get('Desc_OreIron_C')!.pure).toBe(127);

    const strict = resolveNodes(summary('random-nodes.sav'), gameData(), catalog);
    expect(strict.assumptions[0]).toMatch(/resource type for 0 node\(s\), purity for 459 node\(s\)/);
    const iron = strict.counts.get('Desc_OreIron_C')!;
    expect(iron.impure + iron.normal + iron.pure).toBe(127);

    const rich = resolveNodes(summary('resource-rich-random-purity.sav'), gameData(), catalog);
    expect(rich.assumptions).toEqual([]);
  });

  it('well satellites point at real well cores with a matching resource', () => {
    const cores = new Map([...catalog.entries.values()].filter((e) => e.kind === 'well-core').map((e) => [e.id, e.resource]));
    expect(cores.size).toBe(17);
    for (const e of catalog.entries.values()) if (e.kind === 'well-satellite') expect(cores.get(e.wellCore!)).toBe(e.resource);
  });

  it.skipIf(!hasFixture('obsidian-gears.sav', 'max-milestone-multiplier.sav', 'all-pure-nodes.sav'))('agrees with what extractors in played saves are actually producing', () => {
    let checked = 0;
    for (const f of ['obsidian-gears.sav', 'max-milestone-multiplier.sav', 'all-pure-nodes.sav']) {
      const p = readSave(fixture(f));
      const byInst = new Map(p.levels.flatMap((l) => l.objects).map((o) => [o.instanceName, o]));
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
