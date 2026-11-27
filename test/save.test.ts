/**
 * Golden-fixture regression tests for the save parser and SaveSummary (rewrite-notes §1–§2).
 * Every save in SAVES is required: a missing file fails these tests.
 */
import { describe, expect, it } from 'vitest';
import { readSaveHeader, parseMapOptions } from '../src/save/header';
import { summarizeSaveBytes, checkVersion, INTERPRETED_CLASSES } from '../src/save/extract';
import { classCensus } from '../src/save/census';
import { SaveFormatError } from '../src/save/binary-reader';
import { concat, ByteWriter } from './helpers/save-bytes';
import { fixture, gameData, parsedSave, saveSummary, SAVES, SAVE_FILES } from './fixtures';

describe.each(SAVE_FILES)('save fixture %s', (file) => {
  const exp = SAVES[file];

  it('reads the header (header 14, save 60, UTC timestamp from .NET ticks)', () => {
    const h = readSaveHeader(fixture(file));
    expect(h.headerVersion).toBe(14);
    expect(h.saveVersion).toBe(60);
    expect(h.buildVersion).toBe(exp.buildVersion);
    expect(h.sessionName).toBe(exp.sessionName);
    expect(h.mapName).toBe('Persistent_Level');
    expect(h.saveDateTime).toBe(exp.savedAt);
    expect(h.saveDataHash).toMatch(/^[0-9a-f]{40}$/);
    expect(h.isModded).toBe(false);
    expect(h.saveIdentifier).not.toBe('');
  });

  it('decodes every object with no failures; only UniqueNetIdRepl stays raw', () => {
    const p = parsedSave(file);
    expect(p.stats.objects).toBe(exp.objects);
    expect(p.stats.failedObjects).toBe(0);
    for (const reason of p.stats.rawReasons.keys()) expect(reason).toMatch(/UniqueNetIdRepl/);
    expect(p.layout).toBe('game');
  });

  it('puts the persistent level last, under the header map name', () => {
    const p = parsedSave(file);
    expect(p.levels.length).toBe(exp.levels);
    expect(p.levels.at(-1)!.name).toBe('Persistent_Level');
    expect(p.levels.filter((l) => l.name === 'Persistent_Level').length).toBe(1);
    expect(p.persistentRefs.length).toBe(exp.persistentRefs);
  });

  it('keeps every object byte-for-byte: records rebuild each level data blob exactly', () => {
    const p = parsedSave(file);
    for (const level of p.levels) {
      const count = new ByteWriter().i32(level.objects.length).done();
      const rebuilt = concat(count, ...level.objects.map((o) => o.record));
      expect(rebuilt.length).toBe(level.raw.data.length);
      expect(Buffer.from(rebuilt).equals(Buffer.from(level.raw.data))).toBe(true);
    }
    for (const o of p.levels.flatMap((l) => l.objects)) expect(o.trailing.length).toBe(o.trailingBytes);
  });

  it('reports every class in a census; uninterpreted classes are kept, not dropped', () => {
    const census = classCensus(parsedSave(file));
    const total = census.reduce((a, c) => a + c.entities + c.components, 0);
    expect(total).toBe(exp.objects);
    expect(census.some((c) => !c.interpreted)).toBe(true);
    for (const c of census) expect(c.interpreted).toBe(INTERPRETED_CLASSES.has(c.className));
    expect(census.every((c) => c.failed === 0)).toBe(true);
  });

  it('reports a supported 1.2 version on UE 5.6.1', () => {
    const s = saveSummary(file);
    expect(s.version.status).toBe('supported');
    expect(s.source.engine).toBe('5.6.1');
    expect(s.source.savedAt).toBe(exp.savedAt);
    expect(s.warnings).toEqual([]);
  });

  it('extracts Game Mode settings, marking absent ones as defaults', () => {
    const s = saveSummary(file);
    expect(s.gameMode.partsCostMultiplier).toMatchObject(exp.partsCost);
    expect(s.gameMode.spacePartsCostMultiplier).toMatchObject(exp.spaceCost);
    expect(s.gameMode.nodePurity.value).toBe(exp.purity);
    expect(s.gameMode.nodePurity.source).toBe(exp.purity === 'default' ? 'default' : 'save');
    expect(s.gameMode.nodeRandomizationSeed.value).toBe(exp.seed);
    expect(s.gameMode.nodeRandomization.value).toBe(exp.randomization);
    expect(s.gameMode.nodeRandomization.source).toBe(exp.randomization === 'off' ? 'default' : 'save');
    expect(s.gameMode.unrecognized).toEqual({});
  });

  it('extracts progression', () => {
    const p = saveSummary(file).progression;
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
    for (const r of p.unlockedAlternateRecipes) expect(gameData().recipes.get(r)?.isAlternate).toBe(true);
  });

  it('counts Somersloops, shards (slotted vs stored) and slugs (yield from Docs recipes)', () => {
    const s = saveSummary(file);
    expect(s.holdings.somersloops).toEqual(exp.somersloops);
    expect(s.holdings.powerShards).toEqual(exp.shards);
    expect(s.holdings.powerSlugs).toEqual(exp.slugs);
  });

  it('lists resource nodes with stable ids and only the overrides the Game Mode stores', () => {
    const s = saveSummary(file);
    const count = (k: string) => s.nodes.filter((n) => n.kind === k).length;
    expect(count('resource-node')).toBe(459);
    expect(count('well-satellite')).toBe(118);
    expect(count('well-core')).toBe(17);
    expect(count('geyser')).toBe(31);
    expect(s.nodes.filter((n) => n.purityOverride === 'pure').length).toBe(exp.pureOverrides);
    expect(s.nodes.filter((n) => n.resourceOverride).length).toBe(exp.resourceOverrides);
    expect(s.nodes.filter((n) => n.purityOverride).length).toBe(exp.purityOverrides);
    for (const n of s.nodes) if (n.resourceOverride) expect(gameData().items.get(n.resourceOverride)?.isRawResource).toBe(true);
    expect(new Set(s.nodes.map((n) => n.id)).size).toBe(s.nodes.length);
    // The part of the instance name after the last dot (well cores vary: BP_FrackingCore_8,
    // BP_FrackingCore6_UAID_…), so never a path.
    for (const n of s.nodes) expect(n.id).toMatch(/^BP_(ResourceNode|FrackingSatellite|FrackingCore|ResourceNodeGeyser)\w+$/);
  });

  it('never leaks player identity into the summary', () => {
    const json = JSON.stringify(saveSummary(file), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    expect(json).not.toMatch(/ClientIdentity|offlineId|PlayerInfoSnapshot|UniqueNetId/);
  });
});

describe('cross-save invariants', () => {
  it('node ids and positions are identical across all six saves', () => {
    const key = (f: (typeof SAVE_FILES)[number]) => saveSummary(f).nodes.map((n) => `${n.id}@${n.position.map((x) => x.toFixed(2)).join(',')}`).join('|');
    const first = key(SAVE_FILES[0]!);
    for (const f of SAVE_FILES.slice(1)) expect(key(f)).toBe(first);
  });

  it('strict randomization keeps base-map counts; advanced-rich changes the mix (rewrite-notes §2)', () => {
    const tally = (f: (typeof SAVE_FILES)[number]) => {
      const out: Record<string, number> = {};
      for (const n of saveSummary(f).nodes) if (n.kind === 'resource-node' && n.resourceOverride) out[n.resourceOverride] = (out[n.resourceOverride] ?? 0) + 1;
      return out;
    };
    const strict = tally('random-nodes.sav');
    expect(strict).toMatchObject({ Desc_OreIron_C: 127, Desc_OreCopper_C: 55, Desc_Stone_C: 94, Desc_OreUranium_C: 5 });
    const rich = tally('resource-rich-random-purity.sav');
    expect(rich).toMatchObject({ Desc_OreUranium_C: 40, Desc_RawQuartz_C: 56, Desc_OreIron_C: 61 });
  });

  it('a summary is deterministic for the same bytes', () => {
    const a = summarizeSaveBytes(fixture('default.sav'), gameData());
    const b = summarizeSaveBytes(fixture('default.sav'), gameData());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('version policy', () => {
  it('accepts 60, warns on older/newer', () => {
    expect(checkVersion(60, 1, '').status).toBe('supported');
    expect(checkVersion(59, 1, '').status).toBe('warning');
    expect(checkVersion(59, 1, '').message).toMatch(/older than Update 1.2/);
    expect(checkVersion(61, 1, '').message).toMatch(/newer/);
  });

  const header = (headerVersion: number, saveVersion: number) =>
    new ByteWriter().i32(headerVersion).i32(saveVersion).i32(1).done();

  it('refuses header versions below 14 as unsupported-version (Update 1.0 saves are header 13)', () => {
    expect(() => readSaveHeader(header(13, 46))).toThrow(/header version 13 \(Update 1.0 or older\)/);
    try { readSaveHeader(header(13, 46)); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SaveFormatError);
      expect((e as SaveFormatError).code).toBe('unsupported-version');
    }
  });

  it('refuses save versions below 53 before reading the rest of the header (Update 1.1 saves are 52)', () => {
    try { readSaveHeader(header(14, 52)); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(SaveFormatError);
      expect((e as SaveFormatError).code).toBe('unsupported-version');
      expect((e as Error).message).toMatch(/Save version 52 \(Update 1.1 or older\)/);
    }
  });

  it('parses map options', () => {
    expect(parseMapOptions('?startloc=Grass Fields?sessionName=X?Visibility=SV_Private?listen'))
      .toEqual({ startloc: 'Grass Fields', sessionName: 'X', Visibility: 'SV_Private', listen: '' });
  });
});

describe('load stages', () => {
  it('reports stages in order while summarizing a save, with a non-decreasing fraction', () => {
    const stages: string[] = [];
    let lastFraction = -1;
    summarizeSaveBytes(fixture('max-milestone-multiplier.sav'), gameData(), {
      onStage: (s, f) => {
        if (stages[stages.length - 1] !== s) stages.push(s);
        if (s === 'objects' && f !== undefined) { expect(f).toBeGreaterThanOrEqual(lastFraction); lastFraction = f; }
      },
    });
    expect(stages).toEqual(['header', 'decompress', 'objects', 'summary']);
  });
});
