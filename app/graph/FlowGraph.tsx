/** Flow graph tab: ELK layout, modules, focus with a detail drawer, search, zoom and minimap. */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '../state';
import { buildFullGraph, collapse, type Box, type Edge, type Graph } from './model';
import type { LayoutOutput } from '../engine/protocol';
import type { PlanResult } from '../../src';
import { Icon, num } from '../ui/kit';
import { RESOURCE_COLOR, resourceColor } from '../ui/resources';

const AUTO_MODULE_THRESHOLD = 14;

export function FlowGraph({ result, onShowBuildings }: { result: PlanResult; onShowBuildings: () => void }) {
  const { label, layout, state } = useApp();
  const problem = state.problem;
  const fluid = useMemo(() => {
    const f = new Set(problem?.items.filter((i) => i.fluid).map((i) => i.id) ?? []);
    return (i: string) => f.has(i);
  }, [problem]);
  const full = useMemo(() => buildFullGraph(result, label, fluid), [result, label, fluid]);
  const recipeCount = full.boxes.filter((b) => b.kind === 'recipe').length;
  const [expanded, setExpanded] = useState<Set<string>>(() => (recipeCount > AUTO_MODULE_THRESHOLD ? new Set() : new Set(full.modules.map((m) => m.id))));
  useEffect(() => {
    setExpanded(recipeCount > AUTO_MODULE_THRESHOLD ? new Set() : new Set(full.modules.map((m) => m.id)));
    setSel(null);
  }, [full]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextGraph = useMemo(() => collapse(full, expanded, label), [full, expanded, label]);

  // A layout is always shown with the graph it was computed for, so switching detail never
  // draws new boxes or edges against old coordinates.
  const [laid, setLaid] = useState<{ graph: Graph; layout: LayoutOutput } | null>(null);
  const graph = laid?.graph ?? nextGraph;
  const pos = laid?.layout ?? null;
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'rates' | 'lines'>('rates');
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState({ sx: 0, sy: 0, vw: 800, vh: 640 });
  const scroller = useRef<HTMLDivElement>(null);
  const pendingCenter = useRef<string | null>(null);
  const autoFitted = useRef(false);

  useEffect(() => {
    let live = true;
    const g = nextGraph;
    layout({
      nodes: g.boxes.map((b) => ({ id: b.id, w: b.w, h: b.h, ...(b.layer ? { layer: b.layer } : {}) })),
      edges: g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
    }).then((l) => { if (live) { setLaid({ graph: g, layout: l }); setLayoutError(null); } })
      .catch((e) => { if (live) setLayoutError(String(e?.detail ?? e?.message ?? e)); });
    return () => { live = false; };
  }, [nextGraph, layout]);

  // First layout: fit the width (never zoom in past 100%).
  useEffect(() => {
    if (!pos || autoFitted.current || !scroller.current) return;
    autoFitted.current = true;
    const el = scroller.current;
    setZoom(Math.max(0.4, Math.min(1, (el.clientWidth - 16) / Math.max(1, pos.width))));
  }, [pos]);

  useEffect(() => {
    const id = pendingCenter.current;
    if (!id || !pos?.nodes[id] || !scroller.current) return;
    pendingCenter.current = null;
    const b = graph.boxes.find((x) => x.id === id);
    const p = pos.nodes[id]!;
    const el = scroller.current;
    el.scrollLeft = (p.x + (b?.w ?? 0) / 2) * zoom - el.clientWidth / 2;
    el.scrollTop = (p.y + (b?.h ?? 0) / 2) * zoom - el.clientHeight / 2;
  }, [pos, graph, zoom]);

  const byId = useMemo(() => new Map(graph.boxes.map((b) => [b.id, b])), [graph]);
  const selId = sel && byId.has(sel) ? sel : null;

  // Focus: everything upstream and downstream of the selection.
  const lit = useMemo(() => {
    if (!selId) return null;
    const succ = new Map<string, string[]>(); const pred = new Map<string, string[]>();
    for (const e of graph.edges) {
      (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to);
      (pred.get(e.to) ?? pred.set(e.to, []).get(e.to)!).push(e.from);
    }
    const s = new Set([selId]);
    const walk = (m: Map<string, string[]>) => { const q = [selId]; while (q.length) { const x = q.shift()!; for (const y of m.get(x) ?? []) if (!s.has(y)) { s.add(y); q.push(y); } } };
    walk(succ); walk(pred);
    return s;
  }, [selId, graph]);

  const belt = problem?.belt?.ratePerMin ?? 0;
  const pipe = problem?.pipe?.ratePerMin ?? 0;
  const edgeText = (e: Edge) => {
    if (e.items.length > 1) return `${e.items.length} items`;
    const it = e.items[0]!;
    if (mode === 'rates') return it.rate < 0.005 ? '<0.01' : num(it.rate);
    const cap = it.fluid ? pipe : belt;
    if (!cap) return '—';
    const k = Math.ceil(it.rate / cap - 1e-9);
    return `${k} line${k === 1 ? '' : 's'}`;
  };

  const expand = (m: string, thenSelect?: string) => {
    setExpanded((x) => new Set([...x, m]));
    if (thenSelect) { setSel(thenSelect); pendingCenter.current = thenSelect; }
  };
  const collapseModule = (m: string) => { setExpanded((x) => { const y = new Set(x); y.delete(m); return y; }); setSel(`mod:${m}`); };

  const setZoomKeep = (z: number) => {
    const el = scroller.current;
    const zz = Math.max(0.3, Math.min(1.5, Math.round(z * 100) / 100));
    if (!el) { setZoom(zz); return; }
    const cx = (el.scrollLeft + el.clientWidth / 2) / zoom; const cy = (el.scrollTop + el.clientHeight / 2) / zoom;
    setZoom(zz);
    requestAnimationFrame(() => { el.scrollLeft = cx * zz - el.clientWidth / 2; el.scrollTop = cy * zz - el.clientHeight / 2; });
  };
  const fit = () => {
    const el = scroller.current;
    if (!el || !pos) return;
    setZoomKeep(Math.min((el.clientWidth - 16) / pos.width, (el.clientHeight - 16) / pos.height));
    requestAnimationFrame(() => { el.scrollLeft = 0; el.scrollTop = 0; });
  };

  // Search over boxes and recipes hidden inside collapsed modules.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { label: string; where: string; go: () => void }[] = [];
    for (const b of full.boxes) {
      if (!b.search.some((s) => s.toLowerCase().includes(q))) continue;
      const mod = full.moduleOf[b.id];
      const hidden = mod && !expanded.has(mod);
      out.push({
        label: b.title, where: b.kind === 'raw' ? 'raw' : b.kind === 'out' ? 'delivered' : b.kind === 'surplus' ? 'surplus' : b.kind === 'supply' ? 'your supply' : mod ? full.modules.find((m) => m.id === mod)!.label : 'recipe',
        go: () => { setQuery(''); if (hidden) expand(mod, b.id); else { setSel(b.id); pendingCenter.current = b.id; setView((v) => ({ ...v })); } },
      });
    }
    return out.slice(0, 12);
  }, [query, full, expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const allExpanded = full.modules.every((m) => expanded.has(m.id));
  const noneExpanded = full.modules.every((m) => !expanded.has(m.id));

  if (layoutError) return <div className="panel panel-lg"><p className="note">The graph couldn’t be laid out ({layoutError}). The other tabs have the same results.</p></div>;

  // ---- Edges as paths (loops: the edge runs upward).
  const W = pos?.width ?? 0; const H = pos?.height ?? 0;
  const edges = pos ? graph.edges.map((e) => {
    const pts = pos.edges[e.id]?.points ?? [];
    const on = !lit || (lit.has(e.from) && lit.has(e.to));
    const first = pts[0]; const last = pts[pts.length - 1];
    const loop = !!first && !!last && last[1] < first[1] - 4;
    const only = e.items.length === 1 ? e.items[0]! : null;
    const toOut = e.to.startsWith('out:');
    const color = lit && on ? (loop ? '#6FC7C1' : '#F59A3E') : loop ? '#6FC7C1' : only && RESOURCE_COLOR[only.item] ? RESOURCE_COLOR[only.item]! : toOut ? '#8EC5F5' : '#8A9098';
    const dash = loop ? '7 4' : e.items.every((i) => i.byproduct) ? '2 4' : undefined;
    return { e, pts, on, loop, color, dash, last };
  }).filter((x) => x.pts.length >= 2).sort((a, b) => Number(a.on) - Number(b.on)) : [];
  const markerColors = [...new Set(edges.map((x) => x.color))];

  const cardStyle = (b: Box): CSSProperties => {
    const p = pos?.nodes[b.id];
    const isSel = b.id === selId;
    const base = { raw: ['#2A2016', '#6B4520'], supply: ['#1E2620', '#3F5E45'], recipe: ['#22262B', '#3A4048'], module: ['#1F2328', '#5A6068'], out: ['#17283A', '#3B6E99'], surplus: ['#2A2512', '#6B5A1E'] }[b.kind];
    return {
      left: p?.x ?? 0, top: p?.y ?? 0, width: b.w, height: b.h,
      background: base[0], borderColor: isSel ? '#F59A3E' : b.boosted ? '#B07A3A' : base[1],
      boxShadow: [isSel ? '0 0 0 2px #F59A3E' : '', b.kind === 'module' ? '4px 4px 0 -1px #15181B, 4px 4px 0 0 #5A6068' : ''].filter(Boolean).join(', ') || 'none',
      opacity: !lit || lit.has(b.id) ? 1 : 0.25,
      color: b.kind === 'out' ? '#CFE6FA' : undefined,
    };
  };

  const selBox = selId ? byId.get(selId) : undefined;

  // Minimap scale.
  const ms = pos ? Math.min(200 / Math.max(1, W), 150 / Math.max(1, H)) : 0;

  return (
    <section className="stack" role="tabpanel" aria-label="Flow graph">
      <div className="row" style={{ gap: '10px 16px' }}>
        {full.modules.length > 0 && (
          <div className="row" role="group" aria-label="Detail" style={{ gap: 8 }}>
            <span className="note">Detail</span>
            <div className="seg">
              <button type="button" aria-pressed={noneExpanded} onClick={() => { setExpanded(new Set()); setSel(null); }}>Modules</button>
              <button type="button" aria-pressed={allExpanded} onClick={() => { setExpanded(new Set(full.modules.map((m) => m.id))); setSel(null); }}>All recipes</button>
            </div>
          </div>
        )}
        <div className="seg" role="group" aria-label="Arrow labels">
          <button type="button" aria-pressed={mode === 'rates'} onClick={() => setMode('rates')}>Rates</button>
          <button type="button" aria-pressed={mode === 'lines'} onClick={() => setMode('lines')}>Belt lines</button>
        </div>
        <div style={{ position: 'relative', flex: '0 1 280px', minWidth: 200 }}>
          <label className="row input" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="#A3A9B0" strokeWidth="1.5" /><path d="M9.5 9.5 L13 13" stroke="#A3A9B0" strokeWidth="1.5" /></svg>
            <span className="sr-only">Find an item or recipe in the graph</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find in graph"
              style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', outline: 'none' }} />
          </label>
          {query.trim() && (
            <div role="listbox" aria-label="Matches" className="dialog-list" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: 44, maxHeight: 280, padding: 4, background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 4, boxShadow: '0 12px 32px rgba(0,0,0,.5)' }}>
              {results.map((r, i) => (
                <button key={i} type="button" role="option" aria-selected={false} className="pick" style={{ minHeight: 40 }} onClick={r.go}>
                  <span style={{ flex: 1 }}>{r.label}</span><span className="note-faint">{r.where}</span>
                </button>
              ))}
              {results.length === 0 && <p className="note" style={{ margin: 8 }}>Not in this plan.</p>}
            </div>
          )}
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
          <button type="button" className="btn btn-sm" aria-label="Zoom out" onClick={() => setZoomKeep(zoom - 0.1)}>−</button>
          <span className="mono note" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn btn-sm" aria-label="Zoom in" onClick={() => setZoomKeep(zoom + 0.1)}>+</button>
          <button type="button" className="btn btn-sm" onClick={fit}>Fit</button>
        </div>
      </div>

      {full.modules.length > 0 && (
        <div className="row" role="group" aria-label="Modules" style={{ gap: 8 }}>
          <span className="note">Modules</span>
          {full.modules.map((m) => {
            const on = expanded.has(m.id);
            return (
              <button key={m.id} type="button" aria-expanded={on} className="chip" onClick={() => (on ? collapseModule(m.id) : expand(m.id))}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={on ? 'M2 3.5 L5 6.5 L8 3.5' : 'M3.5 2 L6.5 5 L3.5 8'} fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
                {m.label}<span className="mono note-faint">{m.members.length}</span>
              </button>
            );
          })}
          {selBox && (
            <span className="chip chip-focus">
              Focused on {selBox.title} · its whole chain
              <button type="button" className="btn-icon" style={{ width: 28, height: 28 }} aria-label="Clear focus" onClick={() => setSel(null)}><Icon.x /></button>
            </span>
          )}
        </div>
      )}

      <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
        <div style={{ flex: '999 1 520px', minWidth: 0, position: 'relative' }}>
          <div ref={scroller} className="graph-canvas" onScroll={(e) => { const t = e.currentTarget; setView({ sx: t.scrollLeft, sy: t.scrollTop, vw: t.clientWidth, vh: t.clientHeight }); }}>
            {!pos && <div className="splash" style={{ minHeight: 300 }} role="status">Laying out the graph…</div>}
            {pos && (
              <div style={{ position: 'relative', width: W * zoom, height: H * zoom }}>
                <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: `scale(${zoom})`, transformOrigin: '0 0' }}>
                  <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden="true">
                    <defs>
                      {markerColors.map((c) => (
                        <marker key={c} id={`ah-${c.slice(1)}`} orient="auto" markerWidth="6" markerHeight="6" refX="5" refY="3" markerUnits="userSpaceOnUse" viewBox="0 0 6 6">
                          <path d="M0 0 L6 3 L0 6 Z" fill={c} />
                        </marker>
                      ))}
                    </defs>
                    {edges.map(({ e, pts, on, color, dash }) => (
                      <path key={e.id} d={`M ${pts.map((p) => `${p[0]} ${p[1]}`).join(' L ')}`} fill="none" stroke={color}
                        strokeWidth={lit && on ? 2.4 : 1.6} strokeDasharray={dash} strokeLinejoin="round" opacity={on ? 1 : 0.12}
                        markerEnd={`url(#ah-${color.slice(1)})`} />
                    ))}
                  </svg>
                  {edges.map(({ e, on, loop, last }) => last && (
                    <div key={`l${e.id}`} className="edge-label" style={{ left: last[0] + 5, top: last[1] - 19, opacity: on ? 1 : 0.15, color: loop ? '#6FC7C1' : undefined }}>
                      {loop ? `↺ ${e.items.length === 1 ? label(e.items[0]!.item) + ' ' : ''}` : ''}{edgeText(e)}
                    </div>
                  ))}
                  {graph.boxes.map((b) => (
                    <div key={b.id} className="gcard-wrap" style={{ left: pos.nodes[b.id]?.x ?? 0, top: pos.nodes[b.id]?.y ?? 0, width: b.w, height: b.h, opacity: cardStyle(b).opacity }}>
                      <button type="button" className={`gcard gcard-${b.kind}`} style={{ ...cardStyle(b), left: 0, top: 0, opacity: 1 }}
                        aria-pressed={b.id === selId} aria-label={`${b.title}: ${b.lines.join(', ')}`}
                        onClick={() => setSel(b.id === selId ? null : b.id)}>
                        <span className="gcard-title">
                          {b.kind === 'raw' && <span className="dot" style={{ background: resourceColor(b.resource) }} aria-hidden="true" />}
                          {b.title}
                        </span>
                        {b.lines.map((l, i) => <span key={i} className={`gcard-line${i === 1 && b.boosted ? ' boosted' : ''}`}>{l}</span>)}
                      </button>
                      {b.kind === 'module' && (
                        <button type="button" className="gcard-expand" aria-label={`Expand ${b.title}`} title="Expand" onClick={() => expand(b.module!)}>+</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {pos && (
            <div className="minimap" style={{ width: W * ms, height: H * ms }}>
              <button type="button" aria-label="Minimap: click to move the view" className="minimap-hit"
                onClick={(ev) => {
                  const el = scroller.current; if (!el) return;
                  const r = ev.currentTarget.getBoundingClientRect();
                  el.scrollLeft = ((ev.clientX - r.left) / ms) * zoom - el.clientWidth / 2;
                  el.scrollTop = ((ev.clientY - r.top) / ms) * zoom - el.clientHeight / 2;
                }} />
              {graph.boxes.map((b) => {
                const p = pos.nodes[b.id]; if (!p) return null;
                const c = b.id === selId ? '#F59A3E' : { raw: '#6B4520', supply: '#3F5E45', recipe: '#5A6068', module: '#8A9098', out: '#3B6E99', surplus: '#6B5A1E' }[b.kind];
                return <span key={b.id} aria-hidden="true" style={{ position: 'absolute', left: p.x * ms, top: p.y * ms, width: Math.max(2, b.w * ms), height: Math.max(2, b.h * ms), background: c, opacity: !lit || lit.has(b.id) ? 1 : 0.35, pointerEvents: 'none' }} />;
              })}
              <span aria-hidden="true" className="minimap-view" style={{ left: (view.sx / zoom) * ms, top: (view.sy / zoom) * ms, width: Math.min(W * ms, (view.vw / zoom) * ms), height: Math.min(H * ms, (view.vh / zoom) * ms) }} />
            </div>
          )}
        </div>

        {selBox && <Drawer box={selBox} graph={graph} fullBoxes={full.boxes} label={label} mode={mode} edgeText={edgeText}
          onSelect={(id) => { setSel(id); pendingCenter.current = id; setView((v) => ({ ...v })); }}
          onExpand={(m, then) => expand(m, then)} onCollapse={collapseModule} onClose={() => setSel(null)} onShowBuildings={onShowBuildings}
          moduleOf={full.moduleOf} expanded={expanded} />}
      </div>

      <div className="row note" style={{ gap: '6px 18px' }}>
        <Legend bg="#2A2016" border="#6B4520" text="Extraction" />
        <Legend bg="#22262B" border="#3A4048" text="Recipe · buildings · real clock · main output" />
        {full.modules.length > 0 && <Legend bg="#1F2328" border="#5A6068" text="Module (several recipes)" />}
        <Legend bg="#22262B" border="#B07A3A" text="Boosted (Somersloops or shards)" />
        <Legend bg="#17283A" border="#3B6E99" text="Delivered" />
        <Legend bg="#2A2512" border="#6B5A1E" text="Surplus" />
        <span className="row" style={{ gap: 6 }}><svg width="26" height="8" aria-hidden="true"><path d="M1 4 H25" stroke="#A3A9B0" strokeWidth="2" strokeDasharray="2 4" /></svg>Byproduct</span>
        <span className="row" style={{ gap: 6 }}><svg width="26" height="8" aria-hidden="true"><path d="M1 4 H25" stroke="#6FC7C1" strokeWidth="2" strokeDasharray="7 4" /></svg>Loops back up the chain</span>
        <span>Raw items keep their resource colour. Select a box to focus its chain.</span>
      </div>
    </section>
  );
}

function Legend({ bg, border, text }: { bg: string; border: string; text: string }) {
  return <span className="row" style={{ gap: 6 }}><span aria-hidden="true" style={{ width: 16, height: 12, background: bg, border: `1px solid ${border}`, borderRadius: 2 }} />{text}</span>;
}

function Drawer({ box, graph, fullBoxes, label, edgeText, onSelect, onExpand, onCollapse, onClose, onShowBuildings, moduleOf, expanded }: {
  box: Box; graph: ReturnType<typeof collapse>; fullBoxes: Box[]; label: (id: string) => string; mode: string; edgeText: (e: Edge) => string;
  onSelect: (id: string) => void; onExpand: (m: string, then?: string) => void; onCollapse: (m: string) => void; onClose: () => void; onShowBuildings: () => void;
  moduleOf: Record<string, string>; expanded: Set<string>;
}) {
  const byId = new Map(graph.boxes.map((b) => [b.id, b]));
  const title = (id: string) => byId.get(id)?.title ?? id;
  const ins = graph.edges.filter((e) => e.to === box.id);
  const outs = graph.edges.filter((e) => e.from === box.id);
  const kindLabel = { raw: 'Extraction', supply: 'Your supply', recipe: 'Recipe', module: 'Module', out: 'Delivered', surplus: 'Surplus' }[box.kind];
  const mod = moduleOf[box.id];
  const members = box.members?.map((id) => fullBoxes.find((b) => b.id === id)!).filter(Boolean) ?? [];
  const row = (e: Edge, dir: 'in' | 'out') => e.items.map((it) => (
    <li key={`${e.id}${it.item}`}>
      <button type="button" className="drawer-row" onClick={() => onSelect(dir === 'in' ? e.from : e.to)}>
        <span className="dot" style={{ background: resourceColor(it.item) }} aria-hidden="true" />
        <span style={{ flex: 1 }}>{label(it.item)}{it.byproduct ? ' (byproduct)' : ''} <span className="faint">{dir === 'in' ? 'from' : 'to'} {title(dir === 'in' ? e.from : e.to)}</span></span>
        <span className="mono" style={{ fontSize: 13 }}>{e.items.length > 1 ? num(it.rate) : edgeText(e)}</span>
      </button>
    </li>
  ));
  return (
    <aside className="panel drawer" aria-label="Details">
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow">{kindLabel}</div>
          <h2 style={{ fontSize: 24, lineHeight: 1.1 }}>{box.title}</h2>
        </div>
        <button type="button" className="btn-icon" aria-label="Close details" onClick={onClose}><Icon.x /></button>
      </div>
      <ul className="bullets" style={{ gap: 4 }}>
        {box.lines.map((l) => <li key={l}>{l}</li>)}
        {box.powerMW !== undefined && box.kind !== 'module' && <li>{num(box.powerMW, 1)} MW at real clocks</li>}
      </ul>
      {members.length > 0 && (
        <div>
          <h3 className="h2" style={{ fontSize: 15, marginBottom: 6 }}>Inside</h3>
          <ul className="plain">
            {members.map((m) => (
              <li key={m.id}><button type="button" className="drawer-row" onClick={() => onExpand(box.module!, m.id)}><span style={{ flex: 1 }}>{m.title}</span><span className="note-faint">{m.lines[0]}</span></button></li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="h2" style={{ fontSize: 15, marginBottom: 6 }}>In</h3>
        {ins.length ? <ul className="plain">{ins.flatMap((e) => row(e, 'in'))}</ul> : <p className="note">Nothing — this is where the chain starts.</p>}
      </div>
      <div>
        <h3 className="h2" style={{ fontSize: 15, marginBottom: 6 }}>Out</h3>
        {outs.length ? <ul className="plain">{outs.flatMap((e) => row(e, 'out'))}</ul> : <p className="note">Nothing — end of the chain.</p>}
      </div>
      <div className="row" style={{ marginTop: 'auto' }}>
        {box.kind === 'module' && <button type="button" className="btn btn-sm" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 0 }} onClick={() => onExpand(box.module!)}>Expand module</button>}
        {mod && expanded.has(mod) && <button type="button" className="btn btn-sm" onClick={() => onCollapse(mod)}>Collapse {graph.modules.find((m) => m.id === mod)?.label}</button>}
        {(box.kind === 'recipe' || box.kind === 'raw' || box.kind === 'module') && <button type="button" className="btn btn-sm" onClick={onShowBuildings}>In Buildings table</button>}
      </div>
    </aside>
  );
}
