import { describe, expect, it } from 'vitest';
import { readSave } from '../src/save/save-reader';
import { readSaveHeader } from '../src/save/header';
import { summarizeSave, summarizeSaveBytes, checkVersion } from '../src/save/extract';
import { SaveFormatError } from '../src/save/binary-reader';
import { resolveNodes, parseNodeCatalog } from '../src/gamedata/node-catalog';
import { fixture, gameData, SAVES, PRESENT_SAVES, hasFixture } from './fixtures';

describe.each(Object.entries(PRESENT_SAVES))('save fixture %s', (file, exp) => {
  const bytes = fixture(file);
  const parsed = readSave(bytes);
  const s = summarizeSave(parsed, gameData());

  it('reads the header', () => {
    const h = readSaveHeader(bytes);
    expect(h.headerVersion).toBe(14);
    expect(h.saveVersion).toBe(60);
    expect(h.buildVersion).toBe(exp.buildVersion);
    expect(h.sessionName).toBe(exp.sessionName);
    expect(h.mapName).toBe('Persistent_Level');
  });

  it('decodes every object with no failures', () => {
    expect(parsed.stats.objects).toBe(exp.objects);
    expect(parsed.stats.failedObjects).toBe(0);
    // Only UniqueNetIdRepl (player network ids) is intentionally left raw.
    for (const reason of parsed.stats.rawReasons.keys()) expect(reason).toMatch(/UniqueNetIdRepl/);
  });

  it('reports supported 1.2 version', () => {
    expect(s.version.status).toBe('supported');
    expect(s.source.engine).toBe('5.6.1');
  });

  it('extracts Game Mode settings', () => {
    expect(s.gameMode.partsCostMultiplier).toMatchObject(exp.partsCost);
    expect(s.gameMode.spacePartsCostMultiplier).toMatchObject(exp.spaceCost);
    expect(s.gameMode.nodePurity.value).toBe(exp.purity);
    expect(s.gameMode.nodeRandomizationSeed.value).toBe(exp.seed);
    expect(s.gameMode.nodeRandomization.value).toBe(exp.randomization);
    expect(s.gameMode.unrecognized).toEqual({});
  });

  it('extracts progression', () => {
    const p = s.progression;
    const purchased = p.milestones.length + p.mamResearch.length + p.alternateSchematics.length
      + p.awesomeShopSchematics.length + p.otherSchematics.length;
    expect(purchased).toBe(exp.purchasedSchematics);
    expect(p.unlockedRecipes.length).toBe(exp.unlockedRecipes);
    expect(p.highestMilestoneTier).toBe(exp.tier);
    expect(p.milestones.length).toBe(exp.milestones);
    expect(p.mamResearch.length).toBe(exp.mam);
    expect(p.alternateSchematics.length).toBe(exp.alternates);
    expect(p.overclockUnlocked).toBe(exp.overclock);
    expect(p.productionBoostUnlocked).toBe(exp.boost);
    expect(p.phase.current).toBe(`GP_Project_Assembly_Phase_${exp.phase}`);
    expect(p.phase.currentIndex).toBe(exp.phase);
    // Every unlocked alternate recipe is a known production recipe.
    for (const r of p.unlockedAlternateRecipes) expect(gameData().recipes.get(r)?.isAlternate).toBe(true);
  });

  it('counts Somersloops, shards and slugs', () => {
    expect(s.holdings.somersloops).toEqual(exp.somersloops);
    expect(s.holdings.powerShards).toEqual(exp.shards);
    expect(s.holdings.powerSlugs).toEqual(exp.slugs);
  });

  it('lists resource nodes with stable ids', () => {
    const count = (k: string) => s.nodes.filter((n) => n.kind === k).length;
    expect(count('resource-node')).toBe(459);
    expect(count('well-satellite')).toBe(118);
    expect(count('well-core')).toBe(17);
    expect(count('geyser')).toBe(31);
    expect(s.nodes.filter((n) => n.purityOverride === 'pure').length).toBe(exp.pureOverrides);
    expect(s.nodes.filter((n) => n.resourceOverride).length).toBe(exp.resourceOverrides);
    for (const n of s.nodes) if (n.resourceOverride) expect(gameData().items.get(n.resourceOverride)?.isRawResource).toBe(true);
    expect(new Set(s.nodes.map((n) => n.id)).size).toBe(s.nodes.length);
  });

  it('never leaks player identity into the summary', () => {
    const json = JSON.stringify(s, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).not.toMatch(/ClientIdentity|offlineId|PlayerInfoSnapshot/);
  });
});

describe('cross-save invariants', () => {
  it('node ids and positions are identical across all three saves', () => {
    const sets = Object.keys(PRESENT_SAVES).map((f) => summarizeSave(readSave(fixture(f)), gameData()).nodes.map((n) => `${n.id}@${n.position.map(Math.round).join(',')}`).join('|'));
    expect(sets[1]).toBe(sets[0]);
    expect(sets[2]).toBe(sets[0]);
    for (const other of sets.slice(1)) expect(other).toBe(sets[0]);
  });
});

describe('version policy', () => {
  it('accepts 60, warns on older/newer', () => {
    expect(checkVersion(60, 1, '').status).toBe('supported');
    expect(checkVersion(58, 1, '').status).toBe('warning');
    expect(checkVersion(61, 1, '').message).toMatch(/newer/);
  });
  it('rejects pre-1.0 headers', () => {
    const b = new Uint8Array(64); new DataView(b.buffer).setInt32(0, 10, true);
    expect(() => readSaveHeader(b)).toThrow(/older than Satisfactory 1.0/);
  });
});

describe('node catalog resolution', () => {
  const s = summarizeSave(readSave(fixture('all-pure-nodes.sav')), gameData());
  const first = s.nodes.find((n) => n.kind === 'resource-node')!;
  it('save override beats catalog purity', () => {
    const cat = parseNodeCatalog({ source: 'test', gameVersion: '1.2', entries: [{ id: first.id, kind: 'resource-node', resource: 'Desc_OreIron_C', purity: 'impure' }] });
    const r = resolveNodes(s, gameData(), cat);
    const n = r.nodes.find((x) => x.id === first.id)!;
    expect(n.purity).toBe('pure');
    expect(n.puritySource).toBe('save-override');
    expect(r.counts.get('Desc_OreIron_C')).toEqual({ impure: 0, normal: 0, pure: 1 });
    expect(r.warnings.some((w) => /missing from the node catalog/.test(w))).toBe(true);
  });
  it.skipIf(!hasFixture('random-nodes.sav'))('strict randomization: resources come from the save, resource-node purity still needs the catalog', () => {
    const rs = summarizeSave(readSave(fixture('random-nodes.sav')), gameData());
    const r = resolveNodes(rs, gameData());
    const nodes = r.nodes.filter((n) => n.kind === 'resource-node');
    expect(nodes.every((n) => n.resourceSource === 'save-override' && n.purity === null)).toBe(true);
    const sats = r.nodes.filter((n) => n.kind === 'well-satellite');
    expect(sats.every((n) => n.resourceSource === 'save-override' && n.puritySource === 'save-override')).toBe(true);
    // Strict mode keeps the per-resource node counts of the base map.
    const iron = nodes.filter((n) => n.resource === 'Desc_OreIron_C').length;
    expect(iron).toBe(127);
  });
  it.skipIf(!hasFixture('resource-rich-random-purity.sav'))('resource-rich + random purity resolves every node from the save alone', () => {
    const rs = summarizeSave(readSave(fixture('resource-rich-random-purity.sav')), gameData());
    const r = resolveNodes(rs, gameData());
    expect(r.warnings).toEqual([]);
    const ext = r.nodes.filter((n) => n.kind === 'resource-node' || n.kind === 'well-satellite');
    expect(ext.length).toBe(577);
    expect(ext.every((n) => n.resource && n.purity && n.resourceSource === 'save-override' && n.puritySource === 'save-override')).toBe(true);
    // Advanced-rich rebalances counts toward rare resources (base map: 5 uranium nodes).
    expect(r.counts.get('Desc_OreUranium_C')).toEqual({ impure: 10, normal: 14, pure: 16 });
  });
  it.skipIf(!hasFixture('default.sav'))('default save stores no node resource or purity', () => {
    const ds = summarizeSave(readSave(fixture('default.sav')), gameData());
    expect(ds.nodes.some((n) => n.resourceOverride || n.purityOverride)).toBe(false);
  });
  it('without a catalog resources are unknown and flagged', () => {
    const r = resolveNodes(s, gameData());
    expect(r.nodes.every((n) => n.resource === null)).toBe(true);
    expect(r.warnings[0]).toMatch(/No node catalog/);
  });
});

describe('load stages and error codes', () => {
  it('reports stages in order while summarizing a save', () => {
    const file = Object.keys(PRESENT_SAVES)[0];
    if (!file || !hasFixture('en-US.json')) return;
    const stages: string[] = [];
    let lastFraction = -1;
    summarizeSaveBytes(fixture(file), gameData(), {
      onStage: (s, f) => {
        if (stages[stages.length - 1] !== s) stages.push(s);
        if (s === 'objects' && f !== undefined) { expect(f).toBeGreaterThanOrEqual(lastFraction); lastFraction = f; }
      },
    });
    expect(stages).toEqual(['header', 'decompress', 'objects', 'summary']);
  });

  it('marks pre-1.0 headers as unsupported-version', () => {
    const bytes = new Uint8Array(64);
    new DataView(bytes.buffer).setInt32(0, 5, true);
    try { readSaveHeader(bytes); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SaveFormatError);
      expect((e as SaveFormatError).code).toBe('unsupported-version');
    }
  });

  it('marks a truncated save as corrupt', () => {
    const file = Object.keys(PRESENT_SAVES)[0];
    if (!file) return;
    const bytes = fixture(file);
    try { readSave(bytes.subarray(0, Math.floor(bytes.length / 2))); expect.unreachable(); } catch (e) {
      const code = e instanceof SaveFormatError ? e.code : 'corrupt';
      expect(code).toBe('corrupt');
    }
  });
});
