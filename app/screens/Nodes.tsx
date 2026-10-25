/** Nodes: exclude nodes on a schematic map of the save's node positions, and cap raw resources. */
import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useApp } from '../state';
import { num } from '../ui/kit';
import { resourceColor } from '../ui/resources';
import type { MapNode } from '../engine/protocol';

const MULT = { impure: 0.5, normal: 1, pure: 2 } as const;
const PURITIES = ['pure', 'normal', 'impure'] as const;
const VIEW_W = 1000;

export function NodesScreen() {
  const { state, label, updateRequest } = useApp();
  const plan = state.plan;
  const problem = state.problem;
  const [focus, setFocus] = useState<string>('Desc_OreIron_C');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const svgRef = useRef<SVGSVGElement>(null);

  const nodes = problem?.mapNodes ?? [];
  const geo = useMemo(() => {
    if (!nodes.length) return null;
    const xs = nodes.map((n) => n.x); const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 0.03 * (maxX - minX);
    const s = VIEW_W / (maxX - minX + 2 * pad);
    return { s, minX: minX - pad, minY: minY - pad, h: (maxY - minY + 2 * pad) * s };
  }, [nodes]);

  const resources = useMemo(() => {
    const m = new Map<string, MapNode[]>();
    for (const n of nodes) if (n.resource) { const l = m.get(n.resource) ?? []; l.push(n); m.set(n.resource, l); }
    return [...m].sort((a, b) => b[1].length - a[1].length);
  }, [nodes]);

  if (!plan || !problem || !geo) return <div className="page-narrow"><p className="muted">Load a save and open a plan first.</p></div>;
  const req = plan.request;
  const excluded = new Set(req.excludedNodes);
  const capOf = (r: string) => req.rawCaps.find((c) => c.item === r)?.maxPerMin;
  const px = (n: MapNode) => (n.x - geo.minX) * geo.s;
  const py = (n: MapNode) => (n.y - geo.minY) * geo.s;
  const isFocused = (n: MapNode) => focus === 'all' || n.resource === focus;

  const setExcluded = (ids: string[], on: boolean) => updateRequest((r) => {
    const set = new Set(r.excludedNodes);
    for (const id of ids) { if (on) set.add(id); else set.delete(id); }
    return { ...r, excludedNodes: [...set] };
  });
  const setCap = (res: string, v: string) => updateRequest((r) => {
    const rest = r.rawCaps.filter((c) => c.item !== res);
    const n = parseFloat(v);
    return { ...r, rawCaps: v.trim() === '' || !Number.isFinite(n) ? rest : [...rest, { item: res, maxPerMin: Math.max(0, n) }] };
  });

  const toSvg = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * VIEW_W, y: ((e.clientY - r.top) / r.height) * geo.h };
  };
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-node]')) return;
    const p = toSvg(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => { if (drag) { const p = toSvg(e); setDrag({ ...drag, x1: p.x, y1: p.y }); } };
  const onUp = () => {
    if (!drag) return;
    const [x0, x1] = [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)];
    const [y0, y1] = [Math.min(drag.y0, drag.y1), Math.max(drag.y0, drag.y1)];
    setDrag(null);
    if (x1 - x0 < 4 && y1 - y0 < 4) { setSelected(new Set()); return; }
    setSelected(new Set(nodes.filter((n) => isFocused(n) && px(n) >= x0 && px(n) <= x1 && py(n) >= y0 && py(n) <= y1).map((n) => n.id)));
  };

  const focusNodes = focus === 'all' ? nodes : nodes.filter((n) => n.resource === focus);
  const units = (list: MapNode[]) => list.reduce((u, n) => u + (n.purity ? MULT[n.purity] : 0), 0);
  const capacity = (res: string, list: MapNode[]) => (problem.perNormalNode[res] ?? 0) * units(list);
  const sel = [...selected];
  const selExcluded = sel.filter((id) => excluded.has(id)).length;
  const excludedNodes = nodes.filter((n) => excluded.has(n.id));
  const nodeLabel = (n: MapNode) => `${label(n.resource ?? '')}, ${n.purity ?? 'unknown purity'}${n.kind === 'well-satellite' ? ' well satellite' : ''}`;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row" style={{ alignItems: 'flex-end', gap: '12px 24px' }}>
        <div>
          <div className="eyebrow">{plan.name}</div>
          <h1 className="h1 h1-upper">Nodes</h1>
          <p className="lede">Every node in the save is available unless you exclude it. Click a node, or drag a box around several. Exclusions and caps belong to this plan; solve again to use them.</p>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" disabled={!excluded.size} onClick={() => updateRequest((r) => ({ ...r, excludedNodes: [] }))}>Include all</button>
          <a className="btn btn-primary" href="#/plan">Back to plan</a>
        </div>
      </div>

      <div className="row" role="group" aria-label="Show resource" style={{ gap: 8 }}>
        <button type="button" className="chip" aria-pressed={focus === 'all'} onClick={() => { setFocus('all'); setSelected(new Set()); }}>
          <span className="dot" style={{ border: '1.5px solid var(--muted)' }} aria-hidden="true" />All<span className="mono note-faint">{nodes.length}</span>
        </button>
        {resources.map(([res, list]) => (
          <button key={res} type="button" className="chip" aria-pressed={focus === res} onClick={() => { setFocus(res); setSelected(new Set()); }}>
            <span className="dot" style={{ background: resourceColor(res) }} aria-hidden="true" />{label(res)}<span className="mono note-faint">{list.length}</span>
          </button>
        ))}
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        <section className="panel" aria-label="Node map" style={{ flex: '999 1 560px', minWidth: 0, padding: 12 }}>
          <div className="row note" style={{ gap: '6px 16px', marginBottom: 10 }}>
            <span>Colour = resource ·</span>
            <span className="row" style={{ gap: 6 }}><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5.5" fill="#C8CDD3" /></svg>Pure</span>
            <span className="row" style={{ gap: 6 }}><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="3.8" fill="#C8CDD3" /></svg>Normal</span>
            <span className="row" style={{ gap: 6 }}><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="3.6" fill="none" stroke="#C8CDD3" strokeWidth="1.8" /></svg>Impure</span>
            <span className="row" style={{ gap: 6 }}><span aria-hidden="true" style={{ fontWeight: 700, color: 'var(--text)' }}>×</span>Excluded</span>
            <span className="row" style={{ gap: 6 }}><svg width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#ECE7DE" strokeWidth="1.5" /></svg>Selected</span>
            <div className="row" style={{ marginLeft: 'auto', gap: 6 }}>
              <button type="button" className="btn btn-sm" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(Math.max(1, zoom - 0.5))}>−</button>
              <span className="mono" style={{ minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <button type="button" className="btn btn-sm" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(Math.min(4, zoom + 0.5))}>+</button>
            </div>
          </div>
          <div className="map-scroll">
            <div style={{ position: 'relative', width: `${zoom * 100}%` }}>
              <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${geo.h}`} className="node-map" role="img"
                aria-label={`Map of ${nodes.length} resource nodes from the save. ${excluded.size} excluded.`}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                {[...nodes].sort((a, b) => Number(isFocused(a)) - Number(isFocused(b))).map((n) => {
                  const on = isFocused(n);
                  const c = resourceColor(n.resource);
                  const ex = excluded.has(n.id);
                  const r = n.purity === 'pure' ? 5.5 : n.purity === 'impure' ? 3.6 : 3.8;
                  const ring = n.purity === 'impure';
                  const x = px(n); const y = py(n);
                  return (
                    <g key={n.id} data-node={n.id} opacity={on ? 1 : 0.18} style={{ cursor: on ? 'pointer' : 'default', pointerEvents: on ? 'auto' : 'none' }}
                      onClick={() => setExcluded([n.id], !ex)}>
                      <title>{`${nodeLabel(n)}${ex ? ' — excluded, click to include' : ' — click to exclude'}`}</title>
                      {n.kind === 'well-satellite'
                        ? <rect x={x - r} y={y - r} width={r * 2} height={r * 2} transform={`rotate(45 ${x} ${y})`} fill={ring ? 'none' : c} stroke={ring ? c : 'none'} strokeWidth={1.8} opacity={ex ? 0.35 : 1} />
                        : <circle cx={x} cy={y} r={r} fill={ring ? 'none' : c} stroke={ring ? c : 'none'} strokeWidth={1.8} opacity={ex ? 0.35 : 1} />}
                      {selected.has(n.id) && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="#ECE7DE" strokeWidth={1.5} />}
                      {ex && <text x={x} y={y + 4} textAnchor="middle" className="node-x">×</text>}
                      <circle cx={x} cy={y} r={9} fill="transparent" />
                    </g>
                  );
                })}
                {drag && <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} fill="rgba(236,231,222,.06)" stroke="#ECE7DE" strokeDasharray="5 4" />}
              </svg>
            </div>
          </div>
          <div className="row" style={{ marginTop: 10, minHeight: 44 }}>
            {sel.length > 0 ? (
              <>
                <span>{sel.length} selected{selExcluded ? ` · ${selExcluded} already excluded` : ''}</span>
                <button type="button" className="btn btn-sm" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 0 }} onClick={() => { setExcluded(sel, true); setSelected(new Set()); }}>Exclude</button>
                {selExcluded > 0 && <button type="button" className="btn btn-sm" onClick={() => { setExcluded(sel, false); setSelected(new Set()); }}>Include</button>}
                <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
              </>
            ) : <span className="note-faint">Positions from the save · top view · north up. Drag on empty map to select an area{focus !== 'all' ? ` of ${label(focus)} nodes` : ''}.</span>}
          </div>
        </section>

        <aside aria-label="Resources" className="stack" style={{ flex: '1 1 340px', maxWidth: 420, minWidth: 0, gap: 12 }}>
          {focus !== 'all' && (
            <section className="panel" style={{ borderColor: resourceColor(focus) }}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="dot" style={{ width: 14, height: 14, background: resourceColor(focus) }} aria-hidden="true" />
                <h2 className="h2" style={{ flex: 1 }}>{label(focus)}</h2>
                <span className="note"><span className="mono" style={{ color: 'var(--text)' }}>{focusNodes.filter((n) => !excluded.has(n.id)).length}</span> of {focusNodes.length} nodes</span>
              </div>
              <table className="kv" style={{ marginTop: 10 }}>
                <thead><tr><th className="eyebrow" style={{ fontWeight: 600 }}>Purity</th><th className="eyebrow" style={{ textAlign: 'right', fontWeight: 600 }}>Nodes</th><th className="eyebrow" style={{ textAlign: 'right', fontWeight: 600 }}>Excluded</th></tr></thead>
                <tbody>
                  {PURITIES.map((p) => {
                    const l = focusNodes.filter((n) => n.purity === p);
                    const e = l.filter((n) => excluded.has(n.id)).length;
                    return <tr key={p}><td style={{ textAlign: 'left' }}>{p[0]!.toUpperCase() + p.slice(1)}</td><td className="mono" style={{ textAlign: 'right' }}>{l.length}</td><td className="mono" style={{ textAlign: 'right', color: e ? 'var(--text)' : 'var(--faint)' }}>{e}</td></tr>;
                  })}
                </tbody>
              </table>
              {focusNodes.some((n) => n.kind === 'well-satellite') && <p className="note-faint" style={{ marginTop: 6 }}>Diamonds are resource-well satellites.</p>}
              <div className="row" style={{ marginTop: 12 }}>
                <label htmlFor="rescap">Cap</label>
                <input id="rescap" type="number" min={0} step="any" className="input-num" style={{ width: 110 }} placeholder="no cap"
                  value={capOf(focus) ?? ''} onChange={(e) => setCap(focus, e.target.value)} />
                <span className="note">/min</span>
              </div>
              <p className="note" style={{ marginTop: 10 }}>
                Map capacity <span className="mono" style={{ color: 'var(--text)' }}>{num(problem.mapAvailability[focus] ?? 0, 0)}</span>/min ·{' '}
                <span className="mono" style={{ color: 'var(--text)' }}>{num(capacity(focus, focusNodes.filter((n) => !excluded.has(n.id))), 0)}</span> after exclusions. Scarcity weights ignore exclusions.
              </p>
            </section>
          )}

          <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            <h2 className="h2" style={{ padding: '12px 16px 8px' }}>All resources</h2>
            <ul className="plain">
              {resources.map(([res, list]) => {
                const ex = list.filter((n) => excluded.has(n.id)).length;
                const cap = capOf(res);
                return (
                  <li key={res}>
                    <button type="button" className="drawer-row" aria-pressed={focus === res} style={{ minHeight: 44, padding: '0 16px', background: focus === res ? 'var(--inset)' : undefined }} onClick={() => { setFocus(res); setSelected(new Set()); }}>
                      <span className="dot" style={{ background: resourceColor(res) }} aria-hidden="true" />
                      <span style={{ flex: 1 }}>{label(res)}</span>
                      <span className="note">{ex ? `${list.length - ex} of ${list.length}` : `${list.length} nodes`}{cap !== undefined ? ` · cap ${num(cap)}` : ''}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel">
            <h2 className="h2" style={{ marginBottom: 8 }}>Excluded · {excludedNodes.length}</h2>
            {excludedNodes.length === 0 ? <p className="note">Nothing excluded — every node is available.</p> : (
              <ul className="plain">
                {excludedNodes.slice(0, 40).map((n) => (
                  <li key={n.id} className="row" style={{ flexWrap: 'nowrap', borderTop: '1px solid var(--border-row)', padding: '2px 0' }}>
                    <span className="dot" style={{ background: resourceColor(n.resource) }} aria-hidden="true" />
                    <span style={{ flex: 1, fontSize: 14 }}>{nodeLabel(n)} <span className="mono note-faint">{num(n.x / 100, 0)} · {num(n.y / 100, 0)} m</span></span>
                    <button type="button" className="btn-link" onClick={() => setExcluded([n.id], false)}>Include</button>
                  </li>
                ))}
                {excludedNodes.length > 40 && <li className="note" style={{ paddingTop: 6 }}>and {excludedNodes.length - 40} more</li>}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
