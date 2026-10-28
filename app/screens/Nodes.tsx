/** Nodes: exclude nodes on a schematic map of the save's node positions, and cap raw resources. */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from 'react';
import { useApp } from '../state';
import { num } from '../ui/kit';
import { resourceColor } from '../ui/resources';
import type { MapNode } from '../engine/protocol';
import outline from '../ui/map-outline.json';
import biomeMap from '../ui/map-biomes.json';
import seaGlowUrl from '../ui/map-sea.png';

const MULT = { impure: 0.5, normal: 1, pure: 2 } as const;
const PURITIES = ['pure', 'normal', 'impure'] as const;
const VIEW_W = 1000;
const MIN_ZOOM = 0.25;
const DRAG_THRESHOLD = 4; // px a press may move and still count as a click
const MAX_ZOOM = 4;
// Faint screen-space grain over the map, so the dark sea glow's 8-bit steps don't show as bands.
const GRAIN = (() => {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    if (!g) return '';
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.random() * 7; }
    g.putImageData(img, 0, 0);
    return `url(${c.toDataURL()})`;
  } catch { return ''; }
})();

// Coastline, lakes and rivers, traced from the full game map by scripts/trace-map-outline.py.
// Lines are flat [x0, y0, x1, y1, ...] in metres; nodes are in centimetres.
const OUTLINE_BOUNDS = (() => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of outline.coast) for (let i = 0; i < r.length; i += 2) {
    minX = Math.min(minX, r[i]! * 100); maxX = Math.max(maxX, r[i]! * 100);
    minY = Math.min(minY, r[i + 1]! * 100); maxY = Math.max(maxY, r[i + 1]! * 100);
  }
  return { minX, maxX, minY, maxY };
})();

export function NodesScreen() {
  const { state, label, updateRequest } = useApp();
  const plan = state.plan;
  const problem = state.problem;
  const [focus, setFocus] = useState<string>('Desc_OreIron_C');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Camera: the map is drawn at `zoom` × the viewport width and shifted by (x, y) px. No bounds, so it pans freely.
  const [cam, setCam] = useState({ x: 0, y: 0, zoom: 1 });
  const zoom = cam.zoom;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  // Left-drag pans the map; right-drag box-selects. A left press that doesn't move past DRAG_THRESHOLD is a click.
  const pan = useRef<{ id: number; x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [panning, setPanning] = useState(false);

  /** Zoom to `z` (25–400%), or by `factor`, keeping viewport point (mx, my) — the centre by default — in place. */
  const zoomTo = (z: number | ((zoom: number) => number), mx?: number, my?: number) => setCam((c) => {
    const el = viewport.current;
    const zz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, typeof z === 'function' ? z(c.zoom) : z));
    if (!el) return { ...c, zoom: zz };
    const ax = mx ?? el.clientWidth / 2; const ay = my ?? el.clientHeight / 2;
    return { x: ax - ((ax - c.x) / c.zoom) * zz, y: ay - ((ay - c.y) / c.zoom) * zz, zoom: zz };
  });

  // Wheel zooms around the cursor. Registered natively: React's wheel listener is passive and can't stop page scroll.
  // The map only mounts once a save is loaded, so this follows the element rather than running once.
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  const viewportRef = useCallback((el: HTMLDivElement | null) => { viewport.current = el; setViewportEl(el); }, []);
  useEffect(() => {
    const el = viewportEl;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * el.clientHeight : ev.deltaY;
      zoomTo((z) => z * Math.exp(-dy * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportEl]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodes = problem?.mapNodes ?? [];
  const geo = useMemo(() => {
    if (!nodes.length) return null;
    // Frame the whole coastline too, so the outline is never cut off at 100%.
    const xs = [...nodes.map((n) => n.x), OUTLINE_BOUNDS.minX, OUTLINE_BOUNDS.maxX];
    const ys = [...nodes.map((n) => n.y), OUTLINE_BOUNDS.minY, OUTLINE_BOUNDS.maxY];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 0.03 * (maxX - minX);
    const s = VIEW_W / (maxX - minX + 2 * pad);
    return { s, minX: minX - pad, minY: minY - pad, h: (maxY - minY + 2 * pad) * s };
  }, [nodes]);

  const outlinePaths = useMemo(() => {
    if (!geo) return null;
    const X = (m: number) => ((m * 100 - geo.minX) * geo.s).toFixed(1);
    const Y = (m: number) => ((m * 100 - geo.minY) * geo.s).toFixed(1);
    const path = (lines: number[][], closed: boolean) => lines.map((r) => {
      let d = `M${X(r[0]!)} ${Y(r[1]!)}`;
      for (let i = 2; i < r.length; i += 2) d += `L${X(r[i]!)} ${Y(r[i + 1]!)}`;
      return closed ? `${d}Z` : d;
    }).join('');
    const coast = path(outline.coast, true); const lakes = path(outline.lakes, true);
    // Land is coast and lake rings together, filled even-odd: lakes cut holes, and islands
    // inside lakes fill again. The sea is the map box's background.
    // Biomes (scripts/trace-map-biomes.py) run a little past the shore and are clipped to the land.
    const biomes = biomeMap.biomes.map((b) => ({ name: b.name, color: b.color, d: path(b.rings, true), x: +X(b.label[0]!), y: +Y(b.label[1]!) }));
    // Off-map areas (black on the game map, and the Grass Fields pit) are neither land nor water.
    // The sea glow image (scripts/trace-map-outline.py) fades out over open sea, away from land and off-map black.
    const g = outline.seaGlow;
    const sea = { x: +X(g.x0), y: +Y(g.y0), w: +X(g.x1) - +X(g.x0), h: +Y(g.y1) - +Y(g.y0) };
    return { land: coast + lakes, coast, lakes, rivers: path(outline.rivers, false), voids: path(outline.void, true), biomes, sea };
  }, [geo]);
  const [showOutline, setShowOutline] = useState(true);
  const [showBiomes, setShowBiomes] = useState(false);

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
  // Panning lives on the whole viewport, so dragging works on empty space around a zoomed-out map too.
  // The pointer is captured only once the press becomes a drag, so a plain click still reaches the node under it.
  const onPanDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  };
  const onPanMove = (e: RPointerEvent<HTMLDivElement>) => {
    const pn = pan.current;
    if (!pn || pn.id !== e.pointerId) return;
    if (!(e.buttons & 1)) { pan.current = null; setPanning(false); return; } // released outside the map
    const dx = e.clientX - pn.x; const dy = e.clientY - pn.y;
    if (!pn.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      pn.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanning(true);
    }
    setCam((c) => ({ ...c, x: pn.cx + dx, y: pn.cy + dy }));
  };
  const onPanUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (pan.current?.id !== e.pointerId) return;
    dragged.current = pan.current.moved;
    pan.current = null;
    setPanning(false);
  };
  // A pan ends in a click; swallow it so it doesn't toggle a node or clear the selection.
  const onPanClick = (e: RMouseEvent) => { if (dragged.current) { dragged.current = false; e.stopPropagation(); } };

  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 2) return;
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
    if (x1 - x0 < DRAG_THRESHOLD && y1 - y0 < DRAG_THRESHOLD) { setSelected(new Set()); return; }
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
          <p className="lede">Every node in the save is available unless you exclude it. Click a node, or right-drag a box around several; drag to move the map, and scroll to zoom. Exclusions and caps belong to this plan; solve again to use them.</p>
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
              <button type="button" className="chip" aria-pressed={showOutline} onClick={() => setShowOutline(!showOutline)}>Coastline</button>
              <button type="button" className="chip" aria-pressed={showBiomes} onClick={() => setShowBiomes(!showBiomes)}>Biomes</button>
              <button type="button" className="btn btn-sm" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => zoomTo(zoom - 0.25)}>−</button>
              <span className="mono" style={{ minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
              <button type="button" className="btn btn-sm" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => zoomTo(zoom + 0.25)}>+</button>
              <button type="button" className="btn btn-sm" disabled={zoom === 1 && cam.x === 0 && cam.y === 0} onClick={() => setCam({ x: 0, y: 0, zoom: 1 })}>Reset</button>
            </div>
          </div>
          <div ref={viewportRef} className={`map-scroll${showOutline ? ' map-sea' : ''} map-pan${panning ? ' panning' : ''}`} style={{ aspectRatio: `${VIEW_W} / ${geo.h}` }}
            onPointerDown={onPanDown} onPointerMove={onPanMove} onPointerUp={onPanUp} onPointerCancel={onPanUp}
            onClickCapture={onPanClick} onContextMenu={(e) => e.preventDefault()}>
            <div style={{ position: 'absolute', left: 0, top: 0, width: `${zoom * 100}%`, transform: `translate(${cam.x}px, ${cam.y}px)`, transformOrigin: '0 0' }}>
              <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${geo.h}`} className="node-map" role="img" style={{ overflow: 'visible' }}
                aria-label={`Map of ${nodes.length} resource nodes from the save. ${excluded.size} excluded.`}
                onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
                onClick={(e) => { if (!(e.target as Element).closest('[data-node]')) setSelected(new Set()); }}>
                {showOutline && outlinePaths && <image href={seaGlowUrl} x={outlinePaths.sea.x} y={outlinePaths.sea.y} width={outlinePaths.sea.w} height={outlinePaths.sea.h} preserveAspectRatio="none" />}
                {showOutline && outlinePaths && (
                  <g aria-hidden="true" className="map-outline">
                    <path d={outlinePaths.land} className="map-land" />
                  </g>
                )}
                {showBiomes && outlinePaths && (
                  <g className="map-biomes" clipPath="url(#map-land-clip)">
                    <defs><clipPath id="map-land-clip"><path d={outlinePaths.land} clipRule="evenodd" /></clipPath></defs>
                    {outlinePaths.biomes.map((b) => <path key={b.name} d={b.d} fill={b.color}><title>{b.name}</title></path>)}
                  </g>
                )}
                {showOutline && outlinePaths && (
                  <g aria-hidden="true" className="map-outline">
                    <path d={outlinePaths.voids} className="map-void" />
                    <path d={outlinePaths.coast} className="map-coast" />
                    <path d={outlinePaths.lakes} className="map-lake" />
                    <path d={outlinePaths.rivers} className="map-river" />
                  </g>
                )}
                {showBiomes && outlinePaths && (
                  <g aria-hidden="true" className="map-biome-labels">
                    {outlinePaths.biomes.map((b) => <text key={b.name} transform={`translate(${b.x} ${b.y}) scale(${1 / zoom})`} textAnchor="middle" dy="0.35em">{b.name}</text>)}
                  </g>
                )}
                {[...nodes].sort((a, b) => Number(isFocused(a)) - Number(isFocused(b))).map((n) => {
                  const on = isFocused(n);
                  const c = resourceColor(n.resource);
                  const ex = excluded.has(n.id);
                  const r = n.purity === 'pure' ? 5.5 : n.purity === 'impure' ? 3.6 : 3.8;
                  const ring = n.purity === 'impure';
                  const x = px(n); const y = py(n);
                  return (
                    // Drawn at the origin and scaled by 1/zoom, so a node keeps its on-screen size at any zoom.
                    <g key={n.id} data-node={n.id} transform={`translate(${x} ${y}) scale(${1 / zoom})`} opacity={on ? 1 : 0.18} style={{ cursor: on ? 'pointer' : 'default', pointerEvents: on ? 'auto' : 'none' }}
                      onClick={() => setExcluded([n.id], !ex)}>
                      <title>{`${nodeLabel(n)}${ex ? ' — excluded, click to include' : ' — click to exclude'}`}</title>
                      {n.kind === 'well-satellite'
                        ? <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" fill={ring ? 'none' : c} stroke={ring ? c : 'none'} strokeWidth={1.8} opacity={ex ? 0.35 : 1} />
                        : <circle r={r} fill={ring ? 'none' : c} stroke={ring ? c : 'none'} strokeWidth={1.8} opacity={ex ? 0.35 : 1} />}
                      {selected.has(n.id) && <circle r={r + 4} fill="none" stroke="#ECE7DE" strokeWidth={1.5} />}
                      {ex && <text y={4} textAnchor="middle" className="node-x">×</text>}
                      <circle r={9} fill="transparent" />
                    </g>
                  );
                })}
                {drag && <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} fill="rgba(236,231,222,.06)" stroke="#ECE7DE" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
              </svg>
            </div>
            {showOutline && GRAIN && <div className="map-grain" style={{ backgroundImage: GRAIN }} aria-hidden="true" />}
          </div>
          <div className="row" style={{ marginTop: 10, minHeight: 44 }}>
            {sel.length > 0 ? (
              <>
                <span>{sel.length} selected{selExcluded ? ` · ${selExcluded} already excluded` : ''}</span>
                <button type="button" className="btn btn-sm" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 0 }} onClick={() => { setExcluded(sel, true); setSelected(new Set()); }}>Exclude</button>
                {selExcluded > 0 && <button type="button" className="btn btn-sm" onClick={() => { setExcluded(sel, false); setSelected(new Set()); }}>Include</button>}
                <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
              </>
            ) : <span className="note-faint">Positions from the save · top view · north up. Right-drag to select an area{focus !== 'all' ? ` of ${label(focus)} nodes` : ''}; drag to move, scroll to zoom.</span>}
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

