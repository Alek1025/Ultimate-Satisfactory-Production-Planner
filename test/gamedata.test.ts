/** Docs-file traps from rewrite-notes §3, on the three locale fixtures. */
import { describe, expect, it } from 'vitest';
import { readDocsFile, parseGameData, parseLabels, GameDataError } from '../src/gamedata/docs-parser';
import { parseUEText, classNameFromPath, parseItemAmounts, parseClassList } from '../src/gamedata/ue-text';
import { decodeText, detectEncoding } from '../src/util/text-decode';
import { fixture, gameData } from './fixtures';

const encode = (s: string, kind: 'le' | 'be', bom: boolean) => {
  const out: number[] = bom ? (kind === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]) : [];
  for (const ch of s) { const c = ch.charCodeAt(0); out.push(...(kind === 'le' ? [c & 0xff, c >> 8] : [c >> 8, c & 0xff])); }
  return new Uint8Array(out);
};

describe('encoding detection', () => {
  it('handles UTF-16LE/BE with and without BOM, UTF-8 with and without BOM', () => {
    expect(decodeText(encode('[{"a":1}]', 'le', true)).text).toBe('[{"a":1}]');
    expect(decodeText(encode('[{"a":1}]', 'be', true)).text).toBe('[{"a":1}]');
    expect(detectEncoding(encode('[{"NativeClass":1}]', 'le', false))).toBe('utf-16le');
    expect(detectEncoding(encode('[{"NativeClass":1}]', 'be', false))).toBe('utf-16be');
    expect(decodeText(encode('[{"NativeClass":1}]', 'le', false)).text).toBe('[{"NativeClass":1}]');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x5d])).text).toBe('[]');
    expect(decodeText(new TextEncoder().encode('[]')).encoding).toBe('utf-8');
  });

  it('rejects invalid UTF-8 rather than guessing', () => {
    expect(() => decodeText(new Uint8Array([0x5b, 0xff, 0x5d]))).toThrow();
  });

  it('detects the shipped Docs files as UTF-16LE with BOM', () => {
    for (const f of ['en-US.json', 'da.json', 'he.json'] as const) {
      const b = fixture(f);
      expect([b[0], b[1]]).toEqual([0xff, 0xfe]);
      expect(detectEncoding(b)).toBe('utf-16le');
    }
  });

  it('reads a Docs file re-encoded as UTF-8 to the same model', () => {
    const utf8 = new TextEncoder().encode(decodeText(fixture('en-US.json')).text);
    expect(parseGameData(readDocsFile(utf8)).contentHash).toBe(gameData().contentHash);
  });
});

describe('UE ExportText parser', () => {
  it('parses item amount lists', () => {
    const src = `((ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/FactoryGame/Resource/Parts/SteelIngot/Desc_SteelIngot.Desc_SteelIngot_C'",Amount=1),(ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/X/Desc_Water.Desc_Water_C'",Amount=1000))`;
    expect(parseItemAmounts(src)).toEqual([{ className: 'Desc_SteelIngot_C', amount: 1 }, { className: 'Desc_Water_C', amount: 1000 }]);
  });
  it('defaults an omitted Amount to 1', () => {
    expect(parseItemAmounts(`((ItemClass="/Script/Engine.BlueprintGeneratedClass'/Game/X/Desc_C.Desc_C_C'"))`)).toEqual([{ className: 'Desc_C_C', amount: 1 }]);
  });
  it('parses bare enum lists, nested structs, quoted escapes and empty input', () => {
    expect(parseUEText('(RF_LIQUID,RF_GAS)')).toEqual(['RF_LIQUID', 'RF_GAS']);
    expect(parseUEText('(Min=(X=1.0,Y=2.0),IsValid=False)')).toEqual({ Min: { X: '1.0', Y: '2.0' }, IsValid: 'False' });
    expect(parseUEText('("a\\"b",c)')).toEqual(['a"b', 'c']);
    expect(parseUEText('')).toEqual([]);
    expect(parseUEText('()')).toEqual([]);
  });
  it('rejects malformed input', () => {
    expect(() => parseUEText('(a,b')).toThrow();
    expect(() => parseUEText('"open')).toThrow();
    expect(() => parseUEText('(a) trailing')).toThrow();
  });
  it('extracts class names from every path style', () => {
    expect(classNameFromPath(`/Script/Engine.BlueprintGeneratedClass'/Game/A/Desc_X.Desc_X_C'`)).toBe('Desc_X_C');
    expect(classNameFromPath('"/Game/A/Build_Y.Build_Y_C"')).toBe('Build_Y_C');
    expect(classNameFromPath('/Script/FactoryGame.FGBuildGun')).toBe('FGBuildGun');
    expect(parseClassList('("/Game/A/Build_A.Build_A_C","/Game/B/Build_B.Build_B_C")')).toEqual(['Build_A_C', 'Build_B_C']);
  });
});

describe('game data model (en-US.json)', () => {
  const gd = gameData();

  it('parses without warnings', () => { expect(gd.warnings).toEqual([]); });

  it('has a stable content hash and the expected size', () => {
    expect(gd.contentHash).toBe('0fe6f3df4c25e2');
    expect({
      items: gd.items.size, recipes: gd.recipes.size, buildings: gd.buildings.size, extractors: gd.extractors.size,
      pressurizers: gd.pressurizers.size, transports: gd.transports.size, schematics: gd.schematics.size,
    }).toEqual({ items: 195, recipes: 317, buildings: 11, extractors: 6, pressurizers: 1, transports: 16, schematics: 574 });
  });

  it('is identical for every language file; only labels differ', () => {
    const da = readDocsFile(fixture('da.json'));
    const he = readDocsFile(fixture('he.json'));
    expect(parseGameData(da).contentHash).toBe(gd.contentHash);
    expect(parseGameData(he).contentHash).toBe(gd.contentHash);
    expect(parseLabels(da, 'da').names.get('Recipe_Alternate_SteelRod_C')).toBe('Alternativ: Stålstang');
    expect(parseLabels(he, 'he').names.get('Desc_WAT1_C')).toBe('סומרסלופ');
    expect(parseLabels(readDocsFile(fixture('en-US.json')), 'en-US').names.get('Desc_WAT1_C')).toBe('Somersloop');
  });

  it('reads belt, lift and pipe throughput (belt mSpeed ÷ 2, pipe mFlowLimit × 60)', () => {
    const rate = (c: string) => gd.transports.get(c)?.ratePerMin;
    expect([1, 2, 3, 4, 5, 6].map((n) => rate(`Build_ConveyorBeltMk${n}_C`))).toEqual([60, 120, 270, 480, 780, 1200]);
    expect([1, 2, 3, 4, 5, 6].map((n) => rate(`Build_ConveyorLiftMk${n}_C`))).toEqual([60, 120, 270, 480, 780, 1200]);
    expect(rate('Build_Pipeline_C')).toBe(300);
    expect(rate('Build_PipelineMK2_C')).toBe(600);
    // NoIndicator copies exist at equal speed; callers prefer the normal variant.
    expect(rate('Build_Pipeline_NoIndicator_C')).toBe(300);
    expect(rate('Build_PipelineMK2_NoIndicator_C')).toBe(600);
  });

  it('reads extractor base rates and allowed forms/resources', () => {
    const e = (c: string) => gd.extractors.get(c)!;
    expect(e('Build_MinerMk1_C').baseRatePerMin).toBe(60);
    expect(e('Build_MinerMk2_C').baseRatePerMin).toBe(120);
    expect(e('Build_MinerMk3_C').baseRatePerMin).toBe(240);
    expect(e('Build_MinerMk1_C').allowedForms).toEqual(['solid']);
    expect(e('Build_OilPump_C')).toMatchObject({ kind: 'oil-extractor', baseRatePerMin: 120, allowedResources: ['Desc_LiquidOil_C'] });
    expect(e('Build_WaterPump_C')).toMatchObject({ kind: 'water-extractor', baseRatePerMin: 120, allowedResources: ['Desc_Water_C'] });
    expect(e('Build_FrackingExtractor_C')).toMatchObject({ kind: 'well-extractor', baseRatePerMin: 60 });
    expect(e('Build_FrackingExtractor_C').allowedForms.sort()).toEqual(['gas', 'liquid']);
    expect(e('Build_FrackingExtractor_C').allowedResources.sort()).toEqual(['Desc_LiquidOil_C', 'Desc_NitrogenGas_C', 'Desc_Water_C']);
    expect([...gd.pressurizers.keys()]).toEqual(['Build_FrackingSmasher_C']);
  });

  it('reads Somersloop slots, boost factors and power exponents', () => {
    const b = (c: string) => gd.buildings.get(c)!;
    const full = (c: string) => b(c).sloopSlots * b(c).sloopBoostPerSlot * gd.shards.sloopExtraBoost;
    expect(b('Build_ManufacturerMk1_C')).toMatchObject({ sloopSlots: 4, sloopBoostPerSlot: 0.25, boostPowerExponent: 2 });
    expect(b('Build_ConstructorMk1_C')).toMatchObject({ sloopSlots: 1, sloopSlotsFromConstant: true });
    expect(b('Build_SmelterMk1_C')).toMatchObject({ sloopSlots: 1, sloopSlotsFromConstant: true });
    expect(b('Build_Packager_C').sloopSlots).toBe(0);
    for (const c of ['Build_ManufacturerMk1_C', 'Build_AssemblerMk1_C', 'Build_ConstructorMk1_C', 'Build_Converter_C', 'Build_QuantumEncoder_C']) expect(full(c)).toBe(1);
    for (const x of gd.buildings.values()) expect([x.powerExponent, x.boostPowerExponent]).toEqual([1.321929, 2]);
    expect(gd.shards).toEqual({ overclockPerShard: 0.5, sloopExtraBoost: 1, powerShardItem: 'Desc_CrystalShard_C', somersloopItem: 'Desc_WAT1_C' });
  });

  it('carries variable power (constant + factor / 2 on average) for its three buildings', () => {
    const variable = [...gd.buildings.values()].filter((b) => b.variablePower).map((b) => b.className).sort();
    expect(variable).toEqual(['Build_Converter_C', 'Build_HadronCollider_C', 'Build_QuantumEncoder_C']);
    const vp = [...gd.recipes.values()].filter((r) => r.variablePower);
    expect(vp.length).toBe(43);
    for (const r of vp) expect(r.producedIn.some((p) => gd.buildings.get(p)!.variablePower)).toBe(true);
    expect(gd.recipes.get('Recipe_Plutonium_C')!.variablePower).toEqual({ constantMW: 250, factorMW: 500 });
  });

  it('converts fluid amounts to m³, reads mManufactoringDuration and flags alternates', () => {
    const r = gd.recipes.get('Recipe_Alternate_DilutedFuel_C')!;
    expect(r.ingredients).toEqual([{ item: 'Desc_HeavyOilResidue_C', amount: 5 }, { item: 'Desc_Water_C', amount: 10 }]);
    expect(r.isAlternate).toBe(true);
    expect([...gd.recipes.values()].filter((x) => x.isAlternate).length).toBe(109);
    expect(gd.recipes.get('Recipe_IngotIron_C')).toMatchObject({ isAlternate: false, producedIn: ['Build_SmelterMk1_C'], durationSec: 2 });
    for (const x of gd.recipes.values()) expect(x.durationSec).toBeGreaterThan(0);
  });

  it('keeps hand-craft recipes separate from machine recipes', () => {
    const manual = [...gd.recipes.values()].filter((r) => r.manualOnly);
    expect(manual.length).toBe(26);
    for (const r of manual) expect(r.producedIn).toEqual([]);
  });

  it('maps build-gun recipes to buildables, ignoring case (Mk2 vs MK2)', () => {
    const placed = new Set([...gd.buildRecipes.values()].flat());
    expect(placed.has('Build_PipelineMK2_C')).toBe(true);
    expect(placed.has('Build_MinerMk1_C')).toBe(true);
    expect(placed.has('Build_ConveyorBeltMk6_C')).toBe(true);
    for (const b of placed) expect(gd.buildings.has(b) || gd.extractors.has(b) || gd.pressurizers.has(b) || gd.transports.has(b)).toBe(true);
  });

  it('identifies schematic types and feature unlocks', () => {
    expect(gd.schematics.get('Schematic_2-1_C')).toMatchObject({ type: 'Milestone', tier: 2 });
    expect(gd.schematics.get('Research_Caterium_1_C')!.type).toBe('MAM');
    expect([...gd.schematics.values()].some((s) => s.unlocksOverclock)).toBe(true);
    expect([...gd.schematics.values()].some((s) => s.unlocksProductionBoost)).toBe(true);
  });

  it('marks raw resources and documents the engine constants it assumes', () => {
    for (const c of ['Desc_OreIron_C', 'Desc_Water_C', 'Desc_NitrogenGas_C', 'Desc_SAM_C']) expect(gd.items.get(c)?.isRawResource).toBe(true);
    expect(gd.items.get('Desc_Water_C')!.form).toBe('liquid');
    expect(gd.items.get('Desc_NitrogenGas_C')!.form).toBe('gas');
    expect(gd.constants.purityMultiplier.value).toEqual({ impure: 0.5, normal: 1, pure: 2 });
    expect(gd.constants.powerShardSlots.value).toBe(3);
    expect(gd.constants.defaultSloopSlots.value).toBe(1);
    for (const c of Object.values(gd.constants)) expect(c.note).not.toBe('');
  });

  it('rejects files that are not Docs.json', () => {
    expect(() => readDocsFile(new TextEncoder().encode('{"x":1}'))).toThrow(/does not look like/);
    expect(() => readDocsFile(new TextEncoder().encode('not json'))).toThrow(GameDataError);
    expect(() => parseGameData([])).toThrow(GameDataError);
  });
});
