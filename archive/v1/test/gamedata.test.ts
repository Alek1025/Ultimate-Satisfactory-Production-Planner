import { beforeAll, describe, expect, it } from 'vitest';
import { readDocsFile, parseGameData, parseLabels } from '../src/gamedata/docs-parser';
import { parseUEText, classNameFromPath, parseItemAmounts } from '../src/gamedata/ue-text';
import { decodeText, detectEncoding } from '../src/util/text-decode';
import { fixture, gameData, hasFixture } from './fixtures';
import type { GameData } from '../src/gamedata/types';

describe('encoding detection', () => {
  const enc = (s: string, kind: 'le' | 'be', bom: boolean) => {
    const out: number[] = bom ? (kind === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
    for (const ch of s) { const c = ch.charCodeAt(0); out.push(...(kind === 'le' ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff])); }
    return new Uint8Array(out);
  };
  it('handles UTF-16LE/BE with and without BOM, UTF-8 with and without BOM', () => {
    expect(decodeText(enc('[{"a":1}]', 'le', true)).text).toBe('[{"a":1}]');
    expect(decodeText(enc('[{"a":1}]', 'be', true)).text).toBe('[{"a":1}]');
    expect(detectEncoding(enc('[{"NativeClass":1}]', 'le', false))).toBe('utf-16le');
    expect(detectEncoding(enc('[{"NativeClass":1}]', 'be', false))).toBe('utf-16be');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d])).text).toBe('[]');
    expect(decodeText(new TextEncoder().encode('[]')).encoding).toBe('utf-8');
  });
  it.skipIf(!hasFixture('en-US.json', 'da.json', 'he.json'))('detects the shipped Docs files as UTF-16LE with BOM', () => {
    for (const f of ['en-US.json', 'da.json', 'he.json']) expect(detectEncoding(fixture(f))).toBe('utf-16le');
  });
});

describe('UE ExportText parser', () => {
  it('parses item amount lists', () => {
    const src = `((ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/FactoryGame/Resource/Parts/SteelIngot/Desc_SteelIngot.Desc_SteelIngot_C'",Amount=1),(ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/X/Desc_Water.Desc_Water_C'",Amount=1000))`;
    expect(parseItemAmounts(src)).toEqual([{ className: 'Desc_SteelIngot_C', amount: 1 }, { className: 'Desc_Water_C', amount: 1000 }]);
  });
  it('defaults omitted Amount to 1', () => {
    expect(parseItemAmounts(`((ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/X/Desc_C.Desc_C_C'"))`)).toEqual([{ className: 'Desc_C_C', amount: 1 }]);
  });
  it('parses bare enum lists and nested objects', () => {
    expect(parseUEText('(RF_LIQUID,RF_GAS)')).toEqual(['RF_LIQUID', 'RF_GAS']);
    expect(parseUEText('(Min=(X=1.0,Y=2.0),IsValid=False)')).toEqual({ Min: { X: '1.0', Y: '2.0' }, IsValid: 'False' });
    expect(parseUEText('')).toEqual([]);
  });
  it('extracts class names from every path style', () => {
    expect(classNameFromPath(`/Script/Engine.BlueprintGeneratedClass'/Game/A/Desc_X.Desc_X_C'`)).toBe('Desc_X_C');
    expect(classNameFromPath('"/Game/A/Build_Y.Build_Y_C"')).toBe('Build_Y_C');
    expect(classNameFromPath('/Script/FactoryGame.FGBuildGun')).toBe('FGBuildGun');
  });
});

describe.skipIf(!hasFixture('en-US.json'))('game data model', () => {
  let gd: GameData;
  beforeAll(() => { gd = gameData(); });

  it('parses without warnings', () => { expect(gd.warnings).toEqual([]); });

  it.skipIf(!hasFixture('en-US.json', 'da.json', 'he.json'))('is identical for every language file (labels only differ)', () => {
    const da = readDocsFile(fixture('da.json'));
    const he = readDocsFile(fixture('he.json'));
    expect(parseGameData(da).contentHash).toBe(gd.contentHash);
    expect(parseGameData(he).contentHash).toBe(gd.contentHash);
    expect(parseLabels(da, 'da').names.get('Recipe_Alternate_SteelRod_C')).toBe('Alternativ: Stålstang');
    expect(parseLabels(he, 'he').names.get('Desc_WAT1_C')).toBe('סומרסלופ');
  });

  it('reads belt and pipe throughput', () => {
    const rate = (c: string) => gd.transports.get(c)?.ratePerMin;
    expect([1, 2, 3, 4, 5, 6].map((n) => rate(`Build_ConveyorBeltMk${n}_C`))).toEqual([60, 120, 270, 480, 780, 1200]);
    expect(rate('Build_Pipeline_C')).toBe(300);
    expect(rate('Build_PipelineMK2_C')).toBe(600);
  });

  it('reads extractor base rates', () => {
    const e = (c: string) => gd.extractors.get(c)!;
    expect(e('Build_MinerMk1_C').baseRatePerMin).toBe(60);
    expect(e('Build_MinerMk2_C').baseRatePerMin).toBe(120);
    expect(e('Build_MinerMk3_C').baseRatePerMin).toBe(240);
    expect(e('Build_OilPump_C').baseRatePerMin).toBe(120);
    expect(e('Build_WaterPump_C').baseRatePerMin).toBe(120);
    expect(e('Build_FrackingExtractor_C')).toMatchObject({ kind: 'well-extractor', baseRatePerMin: 60 });
    expect(e('Build_FrackingExtractor_C').allowedResources.sort()).toEqual(['Desc_LiquidOil_C', 'Desc_NitrogenGas_C', 'Desc_Water_C']);
  });

  it('reads Somersloop slots and boost factors', () => {
    const b = (c: string) => gd.buildings.get(c)!;
    const full = (c: string) => b(c).sloopSlots * b(c).sloopBoostPerSlot * gd.shards.sloopExtraBoost;
    expect(b('Build_ManufacturerMk1_C')).toMatchObject({ sloopSlots: 4, sloopBoostPerSlot: 0.25, boostPowerExponent: 2 });
    expect(b('Build_ConstructorMk1_C')).toMatchObject({ sloopSlots: 1, sloopSlotsFromConstant: true });
    expect(b('Build_Packager_C').sloopSlots).toBe(0);
    // A fully loaded building doubles output.
    for (const c of ['Build_ManufacturerMk1_C', 'Build_AssemblerMk1_C', 'Build_ConstructorMk1_C', 'Build_Converter_C', 'Build_QuantumEncoder_C']) expect(full(c)).toBe(1);
    expect(gd.shards.overclockPerShard).toBe(0.5);
  });

  it('converts fluid amounts to m³ and flags alternates', () => {
    const r = gd.recipes.get('Recipe_Alternate_DilutedFuel_C')!;
    expect(r.ingredients).toEqual([{ item: 'Desc_HeavyOilResidue_C', amount: 5 }, { item: 'Desc_Water_C', amount: 10 }]);
    expect(r.isAlternate).toBe(true);
    expect([...gd.recipes.values()].filter((x) => x.isAlternate).length).toBe(109);
    expect(gd.recipes.get('Recipe_IngotIron_C')).toMatchObject({ isAlternate: false, producedIn: ['Build_SmelterMk1_C'], durationSec: 2 });
  });

  it('carries variable power for particle accelerator / converter / encoder recipes', () => {
    const vp = [...gd.recipes.values()].filter((r) => r.variablePower);
    expect(vp.length).toBeGreaterThan(0);
    for (const r of vp) expect(r.producedIn.some((p) => gd.buildings.get(p)!.variablePower)).toBe(true);
  });

  it('identifies schematic types and feature unlocks', () => {
    expect(gd.schematics.get('Schematic_2-1_C')).toMatchObject({ type: 'Milestone', tier: 2 });
    expect(gd.schematics.get('Research_Caterium_1_C')!.type).toBe('MAM');
    expect([...gd.schematics.values()].some((s) => s.unlocksOverclock)).toBe(true);
    expect([...gd.schematics.values()].some((s) => s.unlocksProductionBoost)).toBe(true);
  });

  it('rejects files that are not Docs.json', () => {
    expect(() => readDocsFile(new TextEncoder().encode('{"x":1}'))).toThrow(/does not look like/);
  });
});
