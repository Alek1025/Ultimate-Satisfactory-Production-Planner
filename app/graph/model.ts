/**
 * PlanResult -> flow graph: boxes (extraction, recipe variants, your supplies, deliveries,
 * surplus), item edges between them, and modules (related recipes that collapse into one box).
 * Pure functions, no React: easy to test and reuse.
 */
import { hasSurplus, type PlanResult, type Label } from '../../src';

export type BoxKind = 'raw' | 'supply' | 'recipe' | 'module' | 'out' | 'surplus';

export interface Box {
  id: string;
  kind: BoxKind;
  title: string;
  lines: string[];
  /** Raw resource item (for colour) */
  resource?: string;
  boosted?: boolean;
  module?: string;
  /** Module boxes: ids of the recipe boxes inside. */
  members?: string[];
  powerMW?: number;
  buildings?: number;
  recipe?: string;
  /** Things to match in search. */
  search: string[];
  w: number;
  h: number;
  layer?: 'first' | 'last';
}

export interface EdgeItem { item: string; rate: number; byproduct: boolean; fluid: boolean }
export interface Edge { id: string; from: string; to: string; items: EdgeItem[] }

export interface Graph {
  boxes: Box[];
  edges: Edge[];
  /** Module id -> label and member recipe box ids (only modules with 2+ recipes). */
  modules: { id: string; label: string; members: string[] }[];
  /** Recipe box id -> module id. */
  moduleOf: Record<string, string>;
  /** Loops collapsed inside a module (edges whose ends are both in it). */
  insideEdges: Record<string, number>;
}

const SIZE: Record<BoxKind, [number, number]> = {
  raw: [176, 66], supply: [176, 62], recipe: [196, 70], module: [228, 88], out: [184, 62], surplus: [184, 62],
};

/** Item ClassName -> production family. Order matters: first match wins. */
const FAMILIES: [string, string, RegExp][] = [
  ['nuclear', 'Nuclear', /Uranium|Plutonium|NuclearWaste|Ficsonium|NonFissible|ElectromagneticControlRod|NuclearFuel|PlutoniumCell|UraniumCell/],
  ['quantum', 'Quantum & SAM', /SAM|Ficsite|Diamond|TimeCrystal|DarkMatter|QuantumEnergy|DarkEnergy|SingularityCell|Superposition|AlienPower|Ficsonium|ExcitedPhoton|QuantumOscillator|TemporalProcessor|AIExpansionServer|Neural/],
  ['aluminum', 'Aluminum line', /Alumina|Aluminum|HeatSink|AluminumPlateReinforced|CoolingSystem|FluidCanister|RadioControlUnit/],
  ['oil', 'Oil & fuel', /Plastic|Rubber|PetroleumCoke|HeavyOil|LiquidFuel|^Desc_Fuel_C|Polymer|Turbofuel|LiquidTurboFuel|Rocket|IonizedFuel|Packaged|PackagedWater|Biofuel|LiquidBiofuel|DissolvedSilica/],
  ['electronics', 'Electronics', /CircuitBoard|Computer|HighSpeedConnector|ComputerSuper|CircuitBoardHighSpeed|ModularFrameLightweight|SpaceElevatorPart_7|Battery/],
  ['caterium', 'Caterium line', /GoldIngot|HighSpeedWire|Quickwire/],
  ['quartz', 'Quartz line', /QuartzCrystal|Silica|CrystalOscillator/],
  ['copper', 'Copper line', /CopperIngot|^Desc_Wire_C|^Desc_Cable_C|CopperSheet|CopperDust/],
  ['steel', 'Steel & concrete', /Steel|^Desc_Cement_C|SteelPlateReinforced|EncasedIndustrialBeam/],
  ['coal', 'Coal & sulfur', /CompactedCoal|SulfuricAcid|^Desc_Sulfur/],
  ['industrial', 'Motors & frames', /Motor|Stator|Rotor|ModularFrameHeavy|ModularFrameFused|PressureConversionCube|MagneticFieldGenerator|ThermalPropulsionRocket|AssemblyDirectorSystem|SmartPlating|SpaceElevatorPart|VersatileFramework|AdaptiveControlUnit|ModularEngine/],
  ['iron', 'Iron line', /IronIngot|IronPlate|IronRod|IronScrew|IronPlateReinforced|^Desc_ModularFrame_C/],
  ['water', 'Water', /^Desc_Water_C/],
];

export function familyOf(item: string): { id: string; label: string } | null {
  for (const [id, label, re] of FAMILIES) if (re.test(item)) return { id, label };
  return null;
}

const n = (x: number, d = 2) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
const pct = (c: number) => `${n(c * 100, 1)}%`;

/** Every recipe box and item edge, before modules are applied. */
export function buildFullGraph(r: PlanResult, label: Label, fluid: (item: string) => boolean): Graph {
  const boxes: Box[] = [];
  const box = (b: Omit<Box, 'w' | 'h'>) => { const [w, h] = SIZE[b.kind]; const full = { ...b, w, h }; boxes.push(full); return full; };
  const producers = new Map<string, { box: string; rate: number; byproduct: boolean }[]>();
  const consumers = new Map<string, { box: string; rate: number }[]>();
  const addP = (item: string, boxId: string, rate: number, byproduct = false) => {
    if (rate <= 1e-9) return;
    const l = producers.get(item) ?? []; l.push({ box: boxId, rate, byproduct }); producers.set(item, l);
  };
  const addC = (item: string, boxId: string, rate: number) => {
    if (rate <= 1e-9) return;
    const l = consumers.get(item) ?? []; l.push({ box: boxId, rate }); consumers.set(item, l);
  };

  // Extraction: one box per resource.
  const byRes = new Map<string, typeof r.extraction>();
  for (const e of r.extraction) { const l = byRes.get(e.resource) ?? []; l.push(e); byRes.set(e.resource, l); }
  for (const [res, lines] of byRes) {
    const id = `raw:${res}`;
    const rate = lines.reduce((s, e) => s + e.ratePerMin, 0);
    const extractors = new Map<string, number>();
    for (const e of lines) extractors.set(e.extractor, (extractors.get(e.extractor) ?? 0) + e.count);
    const purities = new Map<string, number>();
    for (const e of lines) if (e.purity) purities.set(e.purity, (purities.get(e.purity) ?? 0) + e.count);
    const shards = lines.reduce((s, e) => s + e.count * e.shardsEach, 0);
    const clocks = [...new Set(lines.map((e) => pct(e.clockEach)))];
    box({
      id, kind: 'raw', title: label(res), resource: res, layer: 'first',
      lines: [
        [...extractors].map(([x, c]) => `${c} × ${label(x)}`).join(', '),
        `${[...purities].map(([p, c]) => (purities.size > 1 ? `${c} ${p}` : p)).join(', ') || (lines[0]!.source === 'water' ? 'water' : 'well')} · ${clocks.length === 1 ? clocks[0] : 'mixed clocks'} · ${n(rate)}/min`,
      ],
      boosted: shards > 0,
      powerMW: lines.reduce((s, e) => s + e.powerMW, 0),
      buildings: lines.reduce((s, e) => s + e.count, 0),
      search: [label(res)],
    });
    addP(res, id, rate);
  }

  // Your supplies (manual inputs actually used).
  for (const f of r.items) {
    if (f.manualUsed > 1e-9) {
      const id = `supply:${f.item}`;
      box({ id, kind: 'supply', title: label(f.item), layer: 'first', lines: ['Your supply', `${n(f.manualUsed)} of ${n(f.manualAvailable)}/min used`], search: [label(f.item)] });
      addP(f.item, id, f.manualUsed);
    }
  }

  // Recipe variants.
  r.buildings.forEach((b, i) => {
    const id = `b:${i}`;
    const boost = [b.sloopsEach ? `${b.sloopsEach} sloop${b.sloopsEach > 1 ? 's' : ''}` : '', b.shardsEach ? `${b.shardsEach} shard${b.shardsEach > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ');
    const main = b.outputs[0];
    const fam = main ? familyOf(main.item) : null;
    box({
      id, kind: 'recipe', title: label(b.recipe).replace(/^Alternate: /, '★ '), recipe: b.recipe,
      lines: [`${b.count} × ${label(b.building)}`, `${pct(b.clockEach)}${boost ? ` · ${boost}` : ''} · ${main ? `${n(main.ratePerMin)}/min` : ''}`],
      boosted: b.sloopsEach > 0 || b.shardsEach > 0,
      powerMW: b.powerMW, buildings: b.count,
      ...(fam ? { module: fam.id } : {}),
      search: [label(b.recipe), ...b.outputs.map((o) => label(o.item))],
    });
    b.outputs.forEach((o, k) => addP(o.item, id, o.ratePerMin, k > 0));
    for (const x of b.inputs) addC(x.item, id, x.ratePerMin);
  });

  // Deliveries and surplus.
  const surplusItems: { item: string; rate: number }[] = [];
  for (const f of r.items) {
    if (f.delivered > 1e-9) {
      const id = `out:${f.item}`;
      const target = f.target;
      box({
        id, kind: 'out', title: label(f.item), layer: 'last',
        lines: [`Delivered ${n(f.delivered)}/min`, target ? (f.shortfall > 1e-6 ? `target ${n(target)} · short ${n(f.shortfall)}` : `target ${n(target)} · met`) : 'maximized'],
        search: [label(f.item)],
      });
      addC(f.item, id, f.delivered);
    }
    if (hasSurplus(f)) surplusItems.push({ item: f.item, rate: f.surplus });
  }
  if (surplusItems.length) {
    box({
      id: 'surplus', kind: 'surplus', title: 'Surplus', layer: 'last',
      lines: [surplusItems.slice(0, 2).map((s) => `${label(s.item)} ${n(s.rate)}`).join(', ') + (surplusItems.length > 2 ? ` +${surplusItems.length - 2}` : ''), 'not used by this plan'],
      search: surplusItems.map((s) => label(s.item)),
    });
    for (const s of surplusItems) addC(s.item, 'surplus', s.rate);
  }

  // Edges: split each item's production across its consumers in proportion.
  const edgeMap = new Map<string, Edge>();
  for (const [item, cons] of consumers) {
    const prods = producers.get(item) ?? [];
    const total = prods.reduce((s, p) => s + p.rate, 0);
    if (total <= 1e-9) continue;
    for (const p of prods) {
      for (const c of cons) {
        if (p.box === c.box) continue;
        const rate = (p.rate / total) * c.rate;
        if (rate <= 1e-6) continue;
        const key = `${p.box}>${c.box}`;
        const e = edgeMap.get(key) ?? { id: `e${edgeMap.size}`, from: p.box, to: c.box, items: [] };
        const ex = e.items.find((x) => x.item === item);
        if (ex) ex.rate += rate; else e.items.push({ item, rate, byproduct: p.byproduct, fluid: fluid(item) });
        edgeMap.set(key, e);
      }
    }
  }

  // Modules: families with two or more recipe boxes.
  const fam = new Map<string, string[]>();
  for (const b of boxes) if (b.kind === 'recipe' && b.module) { const l = fam.get(b.module) ?? []; l.push(b.id); fam.set(b.module, l); }
  const modules: Graph['modules'] = [];
  const moduleOf: Record<string, string> = {};
  for (const [id, members] of fam) {
    if (members.length < 2) continue;
    modules.push({ id, label: FAMILIES.find((f) => f[0] === id)?.[1] ?? id, members });
    for (const m of members) moduleOf[m] = id;
  }
  return { boxes, edges: [...edgeMap.values()], modules, moduleOf, insideEdges: {} };
}

/** Collapse every module not in `expanded` into one box; merge edges per pair. */
export function collapse(full: Graph, expanded: Set<string>, label: Label): Graph {
  const vis = (id: string) => { const m = full.moduleOf[id]; return m && !expanded.has(m) ? `mod:${m}` : id; };
  const boxes: Box[] = [];
  const seen = new Set<string>();
  const byId = new Map(full.boxes.map((b) => [b.id, b]));
  const outsByModule = new Map<string, Set<string>>();
  for (const b of full.boxes) {
    const v = vis(b.id);
    if (v === b.id) { boxes.push(b); continue; }
    if (seen.has(v)) continue;
    seen.add(v);
    const mod = full.modules.find((m) => `mod:${m.id}` === v)!;
    const members = mod.members.map((id) => byId.get(id)!);
    const [w, h] = SIZE.module;
    boxes.push({
      id: v, kind: 'module', title: mod.label, members: mod.members, module: mod.id, w, h,
      lines: [`${members.length} recipes · ${members.reduce((s, m) => s + (m.buildings ?? 0), 0)} buildings`, `${n(members.reduce((s, m) => s + (m.powerMW ?? 0), 0), 1)} MW`],
      boosted: members.some((m) => m.boosted),
      powerMW: members.reduce((s, m) => s + (m.powerMW ?? 0), 0),
      buildings: members.reduce((s, m) => s + (m.buildings ?? 0), 0),
      search: [mod.label, ...members.flatMap((m) => m.search)],
    });
    outsByModule.set(v, new Set());
  }
  const insideEdges: Record<string, number> = {};
  const merged = new Map<string, Edge>();
  for (const e of full.edges) {
    const a = vis(e.from); const b = vis(e.to);
    if (a === b) { if (a.startsWith('mod:')) insideEdges[a] = (insideEdges[a] ?? 0) + 1; continue; }
    if (a.startsWith('mod:')) for (const it of e.items) outsByModule.get(a)?.add(label(it.item));
    const key = `${a}>${b}`;
    const m = merged.get(key) ?? { id: `m${merged.size}`, from: a, to: b, items: [] };
    for (const it of e.items) {
      const ex = m.items.find((x) => x.item === it.item);
      if (ex) ex.rate += it.rate; else m.items.push({ ...it });
    }
    merged.set(key, m);
  }
  for (const b of boxes) {
    if (b.kind !== 'module') continue;
    const outs = [...(outsByModule.get(b.id) ?? [])];
    b.lines = [...b.lines.slice(0, 2), `out: ${outs.slice(0, 3).join(', ')}${outs.length > 3 ? ` +${outs.length - 3}` : ''}`];
  }
  return { boxes, edges: [...merged.values()], modules: full.modules, moduleOf: full.moduleOf, insideEdges };
}
