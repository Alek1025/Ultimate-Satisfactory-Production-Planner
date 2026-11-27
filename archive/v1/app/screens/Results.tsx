/** Results pane: stat strip, diagnosis when short, and the result tabs. */
import { useState } from 'react';
import { useApp } from '../state';
import { Message, mw, num, pct } from '../ui/kit';
import type { LimitRef, PlanResult, PlanRequest, Label } from '../../src';
import { FlowGraph } from '../graph/FlowGraph';

type Tab = 'graph' | 'buildings' | 'why' | 'flows' | 'raw' | 'assumptions';
const PURITY: Record<string, string> = { pure: 'pure', normal: 'normal', impure: 'impure' };

function describeLimit(l: LimitRef, label: Label): string {
  switch (l.kind) {
    case 'nodes': return `${label(l.resource ?? l.id)} ${l.purity ? PURITY[l.purity] : ''} nodes`;
    case 'well': return `${label(l.resource ?? l.id)} resource wells`;
    case 'raw-cap': return `Your ${label(l.id)} cap`;
    case 'somersloop-budget': return 'Somersloop budget';
    case 'shard-budget': return 'Power Shard budget';
  }
}
const KIND: Record<LimitRef['kind'], string> = { nodes: 'Nodes', well: 'Wells', 'raw-cap': 'Your cap', 'somersloop-budget': 'Budget', 'shard-budget': 'Budget' };
const TIER: Record<string, { text: string; cls: string }> = {
  budget: { text: 'You hold these', cls: 'tag-ok' },
  cap: { text: 'Your cap', cls: 'tag-default' },
  'over-holdings': { text: 'Beyond what you hold', cls: 'tag-warn' },
  map: { text: 'More than the map has', cls: 'tag-warn' },
};

/** Turn one suggested increase into a request change (null when the user can't apply it). */
function applyIncrease(req: PlanRequest, l: LimitRef, extra: number): PlanRequest | null {
  const to = Math.ceil(l.capacity + extra - 1e-9);
  if (l.kind === 'somersloop-budget') return { ...req, budgets: { ...req.budgets, somersloops: to } };
  if (l.kind === 'shard-budget') return { ...req, budgets: { ...req.budgets, powerShards: to } };
  if (l.kind === 'raw-cap') return { ...req, rawCaps: req.rawCaps.map((c) => (c.item === l.id ? { ...c, maxPerMin: to } : c)) };
  return null;
}

export function Results() {
  const { state, label, freshness, updateRequest, solve } = useApp();
  const [tab, setTab] = useState<Tab>('graph');
  const plan = state.plan!;
  const result = plan.lastResult?.result;
  const stale = freshness?.state === 'stale';

  if (state.solveError) {
    return (
      <main className="results">
        <Message tone="bad" title={state.solveError.message} details={state.solveError.detail}
          action={<button type="button" className="btn btn-sm" onClick={() => location.reload()}>Reload</button>}>
          Your request is saved. Reload the page to try again.
        </Message>
      </main>
    );
  }
  if (!result) {
    return (
      <main className="results">
        <div className="panel" style={{ padding: 24, borderStyle: 'dashed', borderColor: 'var(--border-strong)' }}>
          <h2 className="h2-lg">{state.solving ? 'Solving…' : 'Nothing solved yet'}</h2>
          <p className="muted" style={{ margin: '8px 0' }}>Add a target on the left, then Solve. You’ll get:</p>
          <ul className="bullets">
            <li>every building with the clock it actually runs at</li>
            <li>item flows and how many belt or pipe lines each needs</li>
            <li>power, raw resource use, and which limits shaped the plan — in plain words</li>
          </ul>
        </div>
      </main>
    );
  }

  const r = result;
  const targets = r.items.filter((f) => f.target !== undefined && f.target > 0);
  const met = targets.filter((f) => f.shortfall <= 1e-6).length;
  const extractors = r.extraction.reduce((s, e) => s + e.count, 0);
  const sl = r.budgets.somersloops;
  const sh = r.budgets.powerShards;
  const inf = r.infeasibility;

  return (
    <main className="results" aria-label="Results">
      {stale && (
        <div className="msg msg-warn" role="status" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 280px', color: 'var(--warn-text)' }}>{freshness?.messages[0] ?? 'The results below are from the last solve.'}</span>
          <button type="button" className="btn btn-sm" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} disabled={state.solving} onClick={() => void solve()}>Solve again</button>
        </div>
      )}
      <div className={stale ? 'dim stack-lg' : 'stack-lg'}>
        {r.status === 'error' && (
          <Message tone="bad" title="This request can’t be solved as written">{r.explanation.map((e) => <div key={e}>{e}</div>)}</Message>
        )}
        {r.status === 'unbounded' && (
          <Message tone="warn" title="No upper limit">Something in the request can grow without bound — usually a maximize item made from water alone. Add a raw cap or a target.</Message>
        )}
        {inf && <Diagnosis result={r} />}
        {!inf && r.status === 'optimal' && targets.length > 0 && (
          <Message tone="ok" title={`${targets.length === 1 ? 'Target' : 'All targets'} met`}>{r.explanation[0]}</Message>
        )}
        {!r.provenOptimal && (
          <Message tone="warn" title="Good plan, possibly not the best">
            Finding whole-building counts took longer than the time limit, so the search stopped there. Every target and limit is still met.
          </Message>
        )}

        <div className="stats">
          <Stat k="Targets" v={targets.length ? `${met} / ${targets.length}` : '—'} sub={targets.length === 0 ? 'maximize only' : met === targets.length ? 'all met' : `${targets.length - met} short`} color={targets.length && met < targets.length ? '#ff9a8f' : 'var(--ok)'} />
          <Stat k="Power" v={mw(r.power.actualMW)} sub="at real clocks" />
          <Stat k="Buildings" v={num(r.buildingCount, 0)} sub={`${r.buildingCount - extractors} production · ${extractors} extractors`} />
          <Stat k="Somersloops" v={`${sl.used} / ${sl.budget}`} sub={sl.used > sl.available ? `${sl.used - sl.available} more than the ${sl.available} you hold` : `used / budget · ${sl.available} held`} color={sl.used > sl.available ? 'var(--warn)' : undefined} />
          <Stat k="Power Shards" v={`${sh.used} / ${sh.budget}`} sub={sh.used > sh.available ? `${sh.used - sh.available} more than the ${sh.available} you hold` : `used / budget · ${sh.available} held`} color={sh.used > sh.available ? 'var(--warn)' : undefined} />
        </div>

        <div className="tabs" role="tablist" aria-label="Result views">
          {([['graph', 'Flow graph'], ['buildings', 'Buildings'], ['why', 'Why this plan'], ['flows', 'Item flows'], ['raw', 'Raw resources'], ['assumptions', 'Assumptions']] as const).map(([id, text]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {text}{id === 'assumptions' && <span className="count">{r.assumptions.length + r.warnings.length}</span>}
            </button>
          ))}
        </div>

        {tab === 'graph' && <FlowGraph result={r} onShowBuildings={() => setTab('buildings')} />}
        {tab === 'buildings' && <BuildingsTab r={r} label={label} />}
        {tab === 'why' && (
          <section className="panel panel-lg prose" role="tabpanel">
            {r.explanation.map((line, i) => (
              <p key={i} style={line.startsWith('  ') ? { paddingLeft: 18, color: 'var(--muted)' } : undefined}>{line.trim()}</p>
            ))}
          </section>
        )}
        {tab === 'flows' && <FlowsTab r={r} label={label} />}
        {tab === 'raw' && <RawTab r={r} label={label} />}
        {tab === 'assumptions' && (
          <section className="panel panel-lg" role="tabpanel">
            {r.warnings.length > 0 && <div className="stack" style={{ marginBottom: 14 }}>{r.warnings.map((w) => <Message key={w} tone="warn">{w}</Message>)}</div>}
            <ul className="bullets">{r.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            <p className="note-faint" style={{ marginTop: 14 }}>
              Solved {new Date(r.provenance.solvedAt).toLocaleString()} · {r.provenance.solver} · {r.pass === 'integer' ? 'whole-building pass' : 'linear pass'} · game data {r.provenance.gameDataHash} · save build {r.provenance.saveBuild}
            </p>
          </section>
        )}
      </div>
    </main>
  );

  function Diagnosis({ result }: { result: PlanResult }) {
    const d = result.infeasibility!;
    const applicable = d.relaxation.filter((x) => applyIncrease(plan.request, x.limit, x.extraNeeded));
    const applyAll = () => {
      let req = plan.request;
      for (const x of applicable) req = applyIncrease(req, x.limit, x.extraNeeded) ?? req;
      void solve(req);
    };
    const lowerTargets = () => {
      const targets = plan.request.targets.map((t) => {
        const s = d.shortfalls.find((x) => x.item === t.item);
        return s ? { ...t, ratePerMin: Math.floor(s.achieved * 10) / 10 } : t;
      }).filter((t) => !d.unreachable.some((u) => u.item === t.item));
      void solve({ targets });
    };
    const shortText = d.shortfalls.map((s) => `${label(s.item)} reaches ${num(s.achieved)} of ${num(s.target)}/min`).join('; ');
    return (
      <>
        <div className="msg msg-bad" role="status" style={{ padding: '16px 20px', alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <div style={{ font: '700 22px var(--font-head)', letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--bad-text)' }}>Targets not met</div>
            <div className="msg-body">{shortText}{d.unreachable.length ? `. ${d.unreachable.map((u) => label(u.item)).join(', ')} can’t be made with what this plan allows — see why below.` : '.'}</div>
          </div>
        </div>

        {d.binding.length > 0 && (
          <section className="panel panel-lg">
            <h2 className="h2" style={{ marginBottom: 12 }}>What’s in the way</h2>
            <div className="stack">
              {d.binding.map((l) => (
                <div key={`${l.kind}:${l.id}`} className="inset row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{describeLimit(l, label)}</span>
                  <span className="row" style={{ gap: 10 }}>
                    <span className="mono">{num(l.used)} / {num(l.capacity)}</span>
                    <span className="tag tag-default">{KIND[l.kind]}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {d.relaxation.length > 0 && (
          <section className="panel panel-lg" style={{ borderColor: 'var(--accent)' }}>
            <h2 className="h2">Smallest change that meets every reachable target</h2>
            <p className="note" style={{ margin: '4px 0 14px' }}>Uses what you already hold first, then your own caps.</p>
            <ol className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 10 }}>
              {d.relaxation.map((x, i) => {
                const next = applyIncrease(plan.request, x.limit, x.extraNeeded);
                const tier = TIER[x.tier] ?? { text: x.tier, cls: 'tag-default' };
                return (
                  <li key={`${x.limit.kind}:${x.limit.id}`} className="inset row" style={{ gap: '10px 16px' }}>
                    <span className="prio-n">{i + 1}</span>
                    <span style={{ flex: '1 1 220px', fontWeight: 600 }}>{x.tier === 'map' ? `${describeLimit(x.limit, label)}: needs more than the map has` : `Raise the ${describeLimit(x.limit, label).replace(/^Your /, 'your ')}`}</span>
                    <span className="mono">{num(x.limit.capacity)} → {num(Math.ceil(x.limit.capacity + x.extraNeeded - 1e-9))}</span>
                    <span className={`tag ${tier.cls}`}>{tier.text}</span>
                    {next && <button type="button" className="btn btn-sm" onClick={() => updateRequest(() => next)}>Apply</button>}
                  </li>
                );
              })}
            </ol>
            <div className="row" style={{ marginTop: 14 }}>
              {applicable.length > 0 && <button type="button" className="btn btn-primary" style={{ fontSize: 16 }} disabled={state.solving} onClick={applyAll}>{applicable.length > 1 ? 'Apply all and solve' : 'Apply and solve'}</button>}
              {d.shortfalls.length > 0 && <button type="button" className="btn" disabled={state.solving} onClick={lowerTargets}>Lower {d.shortfalls.length > 1 ? 'targets' : 'the target'} to what’s reachable</button>}
            </div>
          </section>
        )}

        {d.unreachable.length > 0 && (
          <section className="panel panel-lg">
            <h2 className="h2" style={{ marginBottom: 12 }}>Can’t be made</h2>
            <div className="stack">
              {d.unreachable.map((u) => (
                <div key={u.item} className="inset row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{label(u.item)}</div>
                    {u.reasons.map((x) => <div key={x} className="note">{x}</div>)}
                  </div>
                  {plan.request.targets.some((t) => t.item === u.item) && (
                    <button type="button" className="btn btn-sm" onClick={() => updateRequest((q) => ({ ...q, targets: q.targets.filter((t) => t.item !== u.item) }))}>Remove target</button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </>
    );
  }
}

function Stat({ k, v, sub, color }: { k: string; v: string; sub: string; color?: string }) {
  return (
    <div className="stat">
      <div className="eyebrow">{k}</div>
      <div className="stat-value" style={color ? { color } : undefined}>{v}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

const clockText = (c: number) => pct(c);
const io = (xs: { item: string; ratePerMin: number }[], label: Label) => xs.map((x) => `${num(x.ratePerMin)} ${label(x.item)}`).join(' + ');

function BuildingsTab({ r, label }: { r: PlanResult; label: Label }) {
  const rows = [...r.buildings].sort((a, b) => b.powerMW - a.powerMW);
  return (
    <section className="panel panel-lg" role="tabpanel">
      <div className="panel-head">
        <h2 className="h2">Buildings</h2>
        <span className="note">Clock = what each building actually runs at</span>
      </div>
      <div className="table-wrap">
        <table className="data" style={{ minWidth: 820 }}>
          <thead><tr><th>Building</th><th>Recipe</th><th className="num">Count</th><th className="num">Clock</th><th className="num">Boost</th><th>In → out, per min</th><th className="num">MW</th></tr></thead>
          <tbody>
            {r.extraction.map((e, i) => (
              <tr key={`x${i}`}>
                <td>{label(e.extractor)}</td>
                <td>{label(e.resource)}{e.purity ? ` · ${e.purity}` : ''}{e.source === 'well' ? ` · well${e.satellites ? `, ${e.satellites} satellites` : ''}` : ''}</td>
                <td className="num">{e.count}</td>
                <td className="num" style={{ color: e.clockEach < 0.9999 ? 'var(--muted)' : undefined }}>{clockText(e.clockEach)}</td>
                <td className="num">{e.shardsEach ? `${e.shardsEach} shard${e.shardsEach > 1 ? 's' : ''}` : '—'}</td>
                <td className="muted">→ {num(e.ratePerMin)} {label(e.resource)}</td>
                <td className="num">{num(e.powerMW, 1)}</td>
              </tr>
            ))}
            {rows.map((b, i) => (
              <tr key={`b${i}`}>
                <td>{label(b.building)}</td>
                <td>{label(b.recipe)}</td>
                <td className="num">{b.count}</td>
                <td className="num" style={{ color: b.clockEach < 0.9999 ? 'var(--muted)' : b.clockEach > 1.0001 ? 'var(--save)' : undefined }}>{clockText(b.clockEach)}</td>
                <td className="num" style={{ color: b.sloopsEach || b.shardsEach ? 'var(--save)' : undefined }}>
                  {[b.sloopsEach ? `${b.sloopsEach} sloop${b.sloopsEach > 1 ? 's' : ''}` : '', b.shardsEach ? `${b.shardsEach} shard${b.shardsEach > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="muted">{io(b.inputs, label)} → {io(b.outputs, label)}</td>
                <td className="num">{num(b.powerMW, 1)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={2}>Total</td><td className="num">{r.buildingCount}</td><td /><td /><td /><td className="num">{num(r.power.actualMW, 1)}</td></tr></tfoot>
        </table>
      </div>
    </section>
  );
}

function FlowsTab({ r, label }: { r: PlanResult; label: Label }) {
  const rows = [...r.items].sort((a, b) => (b.produced + b.extracted) - (a.produced + a.extracted));
  return (
    <section className="panel panel-lg" role="tabpanel">
      <div className="panel-head"><h2 className="h2">Item flows</h2><span className="note">Lines = how many of your best belt or pipe the total needs</span></div>
      <div className="table-wrap">
        <table className="data" style={{ minWidth: 760 }}>
          <thead><tr><th>Item</th><th className="num">Made</th><th className="num">Used</th><th className="num">Delivered</th><th className="num">Surplus</th><th>Lines</th></tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.item}>
                <td>{label(f.item)}{f.manualUsed > 0 && <span className="note"> · {num(f.manualUsed)} from your supply</span>}</td>
                <td className="num">{num(f.produced + f.extracted)}</td>
                <td className="num">{num(f.consumed)}</td>
                <td className="num" style={{ color: f.delivered > 0 ? 'var(--ok)' : 'var(--faint)' }}>{f.delivered > 0 ? num(f.delivered) : '—'}</td>
                <td className="num" style={{ color: f.surplus > 1e-6 ? 'var(--warn)' : 'var(--faint)' }}>{f.surplus > 1e-6 ? num(f.surplus) : '0'}</td>
                <td>
                  {f.lines ? (
                    <span className="lines" title={label(f.lines.transport)}>
                      {Array.from({ length: Math.min(f.lines.count, 8) }, (_, i) => <span key={i} className="bar" aria-hidden="true" />)}
                      <span className="mono muted" style={{ fontSize: 13, marginLeft: 6 }}>{f.lines.count}{f.lines.count > 8 ? '' : ''} × {label(f.lines.transport)}</span>
                    </span>
                  ) : <span className="faint">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RawTab({ r, label }: { r: PlanResult; label: Label }) {
  return (
    <section className="panel panel-lg" role="tabpanel">
      <h2 className="h2" style={{ marginBottom: 12 }}>Raw resources</h2>
      {r.resources.length === 0 && <p className="note">This plan uses no raw resources.</p>}
      <div className="stack" style={{ gap: 14 }}>
        {r.resources.map((x) => (
          <div key={x.resource} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px 24px', alignItems: 'center' }}>
            <div style={{ fontWeight: 600 }}>{label(x.resource)}</div>
            <div>
              <div className="row note" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span>Used <span className="mono" style={{ color: 'var(--text)' }}>{num(x.used)}/min</span></span>
                <span>{x.available !== null ? <>plan could use <span className="mono">{num(x.available, 0)}</span></> : 'unlimited'}</span>
              </div>
              {x.available !== null && (
                <div className="bar-track" role="img" aria-label={`${num(x.used)} of ${num(x.available, 0)} per minute`}>
                  <div className="bar-fill" style={{ width: `${Math.max(1, Math.min(100, (x.used / Math.max(x.available, 1e-9)) * 100))}%` }} />
                </div>
              )}
            </div>
            <div className="note">{x.mapShare !== null ? <>{pct(x.mapShare)} of the map’s {label(x.resource)} · map <span className="mono">{num(x.mapAvailability ?? 0, 0)}</span>/min</> : 'Water Extractors: unlimited'}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
