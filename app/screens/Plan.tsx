/** Plan workspace: request editor on the left, results on the right. */
import { useMemo, useState } from 'react';
import { useApp } from '../state';
import { Icon, Message, abbr, ago, num } from '../ui/kit';
import { Picker, type PickerEntry } from './Picker';
import { Results } from './Results';
import { DEFAULT_OBJECTIVE_ORDER, type ObjectiveKind, type PlanRequest } from '../../src';

const OBJ_LABEL: Record<ObjectiveKind, string> = {
  targets: 'Meet targets', maximize: 'Maximize items', scarcity: 'Use scarce resources least', power: 'Least power', buildings: 'Fewest buildings',
};

type PickerKind = 'target' | 'maximize' | 'manual' | 'cap';

export function PlanScreen() {
  const app = useApp();
  const { state, label, freshness, updateRequest, updateOptions, solve, newPlan, openPlan, renamePlan } = app;
  const plan = state.plan;
  const problem = state.problem;
  const [picker, setPicker] = useState<PickerKind | null>(null);
  const [showRequest, setShowRequest] = useState(() => window.innerWidth >= 760);
  const [editingName, setEditingName] = useState<string | null>(null);

  const entries = useMemo(() => {
    if (!problem) return { make: [], manual: [], raw: [] };
    const byName = (a: PickerEntry, b: PickerEntry) => a.name.localeCompare(b.name);
    const make = problem.items.filter((i) => !i.raw).map((i) => ({ id: i.id, name: label(i.id), disabled: !i.reachable, note: i.reachable ? (i.fluid ? 'fluid' : '') : 'can’t be made yet' }))
      .sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled) || byName(a, b));
    const manual = problem.items.filter((i) => !i.raw).map((i) => ({ id: i.id, name: label(i.id), note: i.fluid ? 'fluid' : '' })).sort(byName);
    const raw = problem.items.filter((i) => i.raw && problem.mapAvailability[i.id] !== undefined).map((i) => ({ id: i.id, name: label(i.id), note: `map ${num(problem.mapAvailability[i.id]!, 0)}/min` })).sort(byName);
    return { make, manual, raw };
  }, [problem, label]);

  if (!plan || !problem) {
    return (
      <div className="page-narrow">
        {state.planLoadErrors.length > 0 && (
          <Message tone="bad" title="This plan can’t be opened" details={state.planLoadErrors.join('\n')}>
            It was saved by another version of the planner, or edited outside it. Nothing was changed.
          </Message>
        )}
        <div className="panel" style={{ padding: 24 }}>
          <h1 className="h2-lg">No plan open</h1>
          <p className="lede">Start one from the loaded save.</p>
          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" disabled={!state.summary} onClick={() => void newPlan()}>New plan</button>
          </div>
        </div>
      </div>
    );
  }

  const req = plan.request;
  const result = plan.lastResult?.result;
  const set = (patch: Partial<PlanRequest>) => updateRequest((r) => ({ ...r, ...patch }));
  const used = new Set([...req.targets.map((t) => t.item), ...req.maximize.map((m) => m.item)]);
  const nothingToSolve = req.targets.length === 0 && req.maximize.length === 0;
  const stale = freshness?.state === 'stale';
  const badge = state.solving ? { cls: 'badge-neutral', text: 'Solving…' }
    : freshness?.state === 'fresh' ? { cls: 'badge-ok', text: `Fresh · solved ${ago(result!.provenance.solvedAt)}` }
    : freshness?.state === 'stale' ? { cls: 'badge-warn', text: freshness.reasons.includes('request-changed') ? 'Request changed · solve again' : 'Out of date · solve again' }
    : { cls: 'badge-neutral', text: 'Not solved' };
  const flowOf = (item: string) => result?.items.find((f) => f.item === item);
  const integerPass = plan.solveOptions.integerPass ?? 'auto';

  const pickEntries: Record<PickerKind, PickerEntry[]> = {
    target: entries.make.map((e) => (used.has(e.id) ? { ...e, disabled: true, note: 'added' } : e)),
    maximize: entries.make.map((e) => (used.has(e.id) ? { ...e, disabled: true, note: 'added' } : e)),
    manual: entries.manual.map((e) => (req.manualInputs.some((m) => m.item === e.id) ? { ...e, disabled: true, note: 'added' } : e)),
    cap: entries.raw.map((e) => (req.rawCaps.some((c) => c.item === e.id) ? { ...e, disabled: true, note: 'added' } : e)),
  };
  const onPick = (id: string) => {
    if (picker === 'target') set({ targets: [...req.targets, { item: id, ratePerMin: 10 }] });
    else if (picker === 'maximize') set({ maximize: [...req.maximize, { item: id }] });
    else if (picker === 'manual') set({ manualInputs: [...req.manualInputs, { item: id, ratePerMin: 60 }] });
    else if (picker === 'cap') set({ rawCaps: [...req.rawCaps, { item: id, maxPerMin: Math.round((problem.mapAvailability[id] ?? 600) / 10) }] });
    setPicker(null);
  };
  const rate = (v: string) => Math.max(0, Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);

  const moveObjective = (i: number, d: number) => {
    const o = [...req.objectiveOrder];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    set({ objectiveOrder: o });
  };

  const budgets = [
    { key: 'somersloops' as const, name: 'Somersloops', held: problem.holdings.somersloops, unlocked: problem.productionBoostUnlocked, lockNote: 'this save hasn’t unlocked Somersloop boosting, so no building is boosted' },
    { key: 'powerShards' as const, name: 'Power Shards', held: problem.holdings.powerShards, unlocked: problem.overclockUnlocked, lockNote: 'this save hasn’t unlocked overclocking yet, so every building runs at 100% or less' },
  ];

  return (
    <>
      <div className="planbar">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <label htmlFor="plan-select" className="eyebrow">Plan</label>
            <select id="plan-select" className="input" style={{ minHeight: 32, fontSize: 13 }} value={plan.id}
              onChange={(e) => { if (e.target.value === '__new') void newPlan(); else void openPlan(e.target.value); }}>
              {state.plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.sessionName.trim()}</option>)}
              <option value="__new">+ New plan</option>
            </select>
          </div>
          <div className="row" style={{ gap: 12, marginTop: 4 }}>
            {editingName === null ? (
              <h1 className="h1">
                <button type="button" style={{ all: 'unset', cursor: 'text' }} title="Rename plan" onClick={() => setEditingName(plan.name)}>{plan.name}</button>
              </h1>
            ) : (
              <input className="input h1" style={{ fontFamily: 'var(--font-head)', fontWeight: 700, fontSize: 28, minHeight: 44 }} aria-label="Plan name" autoFocus
                value={editingName} onChange={(e) => setEditingName(e.target.value)}
                onBlur={() => { void renamePlan(editingName); setEditingName(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditingName(null); }} />
            )}
            <span role="status" className={`badge ${badge.cls}`}>{badge.text}</span>
          </div>
        </div>
        <div className="row" style={{ marginLeft: 'auto', gap: 12 }}>
          <button type="button" className="btn" aria-expanded={showRequest} onClick={() => setShowRequest(!showRequest)}><Icon.panel />{showRequest ? 'Hide request' : 'Show request'}</button>
          <div className="row" role="group" aria-label="Whole buildings" style={{ gap: 8 }}>
            <span className="note">Whole buildings</span>
            <div className="seg">
              {(['auto', 'on', 'off'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={integerPass === m} onClick={() => updateOptions({ integerPass: m })}>
                  {m === 'auto' ? 'Auto' : m === 'on' ? 'Always' : 'Off'}
                </button>
              ))}
            </div>
          </div>
          {nothingToSolve && <span id="solve-hint" className="note">Add a target or an item to maximize.</span>}
          <button type="button" className="btn btn-primary" disabled={nothingToSolve || state.solving} aria-describedby={nothingToSolve ? 'solve-hint' : undefined} onClick={() => void solve()}>
            <Icon.play />{state.solving ? 'Solving…' : 'Solve'}
          </button>
        </div>
      </div>

      <div className="workspace">
        {showRequest && (
          <aside className="request" aria-label="Request">
            <section className="panel">
              <div className="panel-head"><h2 className="h2">Targets</h2><span className="note-faint">per minute</span></div>
              <div className="stack">
                {req.targets.length === 0 && <p className="note">No targets yet. Add what you want per minute, like 20 Motor.</p>}
                {req.targets.map((t, i) => {
                  const f = !stale ? flowOf(t.item) : undefined;
                  const short = !!f && f.shortfall > 1e-6;
                  const delivered = f ? f.delivered : 0;
                  return (
                    <div key={t.item} className={`item-row${short ? ' short' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <span className="item-tile" aria-hidden="true">{abbr(label(t.item))}</span>
                        <span className="item-name">{label(t.item)}</span>
                        <input type="number" min={0} step="any" className="input-num" aria-label={`${label(t.item)} target per minute`} value={t.ratePerMin}
                          onChange={(e) => set({ targets: req.targets.map((x, j) => (j === i ? { ...x, ratePerMin: rate(e.target.value) } : x)) })} />
                        <button type="button" className="btn-icon" aria-label={`Remove ${label(t.item)}`} onClick={() => set({ targets: req.targets.filter((_, j) => j !== i) })}><Icon.x /></button>
                      </div>
                      {f && (
                        <div className="row" style={{ gap: 8, fontSize: 13, color: short ? 'var(--bad)' : 'var(--ok)', flexWrap: 'nowrap' }}>
                          <div className="progress" role="img" aria-label={`${num(delivered)} of ${num(t.ratePerMin)} per minute`}>
                            <div style={{ width: `${Math.min(100, t.ratePerMin ? (delivered / t.ratePerMin) * 100 : 100)}%`, background: short ? 'var(--bad)' : 'var(--ok)' }} />
                          </div>
                          <span className="mono">{num(delivered)} · {short ? `short ${num(f.shortfall)}` : 'met'}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="btn-dashed" onClick={() => setPicker('target')}><Icon.plus />Add target item</button>
              </div>
            </section>

            <section className="panel">
              <h2 className="h2">Maximize</h2>
              <p className="note" style={{ margin: '4px 0 12px' }}>Make as much as possible from what’s left, in this order.</p>
              <div className="stack">
                {req.maximize.map((m, i) => (
                  <div key={m.item} className="item-row">
                    <span className="prio-n">{i + 1}</span>
                    <span className="item-name">{label(m.item)}</span>
                    {!stale && flowOf(m.item) && <span className="mono note">{num(flowOf(m.item)!.delivered)}/min</span>}
                    <button type="button" className="btn-icon" aria-label={`Remove ${label(m.item)}`} onClick={() => set({ maximize: req.maximize.filter((_, j) => j !== i) })}><Icon.x /></button>
                  </div>
                ))}
                <button type="button" className="btn-dashed" onClick={() => setPicker('maximize')}><Icon.plus />Add item to maximize</button>
              </div>
            </section>

            <section className="panel">
              <h2 className="h2">Budgets</h2>
              <p className="note" style={{ margin: '4px 0 12px' }}>Start at 0. Raise one to let the solver use it.</p>
              <div className="stack" style={{ gap: 12 }}>
                {budgets.map((b) => {
                  const v = req.budgets[b.key];
                  const setV = (n: number) => set({ budgets: { ...req.budgets, [b.key]: Math.max(0, Math.round(n)) } });
                  return (
                    <div key={b.key}>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ font: '600 15px var(--font-head)', letterSpacing: '.06em', textTransform: 'uppercase' }}>{b.name}</div>
                          <div className="mono muted" style={{ fontSize: 13 }}>{v} / {b.held} held</div>
                        </div>
                        <div className={`stepper${v > b.held || (v > 0 && !b.unlocked) ? ' over' : ''}`}>
                          <button type="button" aria-label={`Lower ${b.name} budget`} onClick={() => setV(v - 1)}>−</button>
                          <input type="number" min={0} aria-label={`${b.name} budget`} value={v} onChange={(e) => setV(rate(e.target.value))} />
                          <button type="button" aria-label={`Raise ${b.name} budget`} onClick={() => setV(v + 1)}>+</button>
                        </div>
                      </div>
                      {v > 0 && !b.unlocked && <p className="note" style={{ marginTop: 6, color: 'var(--warn)' }}>Ignored: {b.lockNote}.</p>}
                      {b.unlocked && v > b.held && <p className="note" style={{ marginTop: 6, color: 'var(--warn)' }}>Above the {b.held} you hold. Allowed — results will say how many more the plan needs.</p>}
                    </div>
                  );
                })}
                {problem.holdings.slugShardEquivalent > 0 && (
                  <p className="note inset" style={{ padding: '8px 10px' }}>Your Power Slugs make up to {problem.holdings.slugShardEquivalent} more shards once crafted. Not counted in the budget.</p>
                )}
              </div>
            </section>

            <section className="panel">
              <h2 className="h2">I already produce</h2>
              <p className="note" style={{ margin: '4px 0 12px' }}>Supplies you have elsewhere. The solver treats them as free.</p>
              <div className="stack">
                {req.manualInputs.map((m, i) => (
                  <div key={m.item} className="item-row">
                    <span className="item-tile" aria-hidden="true">{abbr(label(m.item))}</span>
                    <span className="item-name">{label(m.item)}</span>
                    <input type="number" min={0} step="any" className="input-num" aria-label={`${label(m.item)} supplied per minute`} value={m.ratePerMin}
                      onChange={(e) => set({ manualInputs: req.manualInputs.map((x, j) => (j === i ? { ...x, ratePerMin: rate(e.target.value) } : x)) })} />
                    <button type="button" className="btn-icon" aria-label={`Remove ${label(m.item)}`} onClick={() => set({ manualInputs: req.manualInputs.filter((_, j) => j !== i) })}><Icon.x /></button>
                  </div>
                ))}
                <button type="button" className="btn-dashed" onClick={() => setPicker('manual')}><Icon.plus />Add a manual input</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head" style={{ marginBottom: 4 }}>
                <h2 className="h2">Priorities</h2>
                <button type="button" className="btn-link" onClick={() => set({ objectiveOrder: [...DEFAULT_OBJECTIVE_ORDER] })}>Reset order</button>
              </div>
              <p className="note" style={{ margin: '0 0 12px' }}>Each step is settled before the next.</p>
              <ol className="stack" style={{ listStyle: 'none', margin: 0, padding: 0, gap: 6 }}>
                {req.objectiveOrder.map((o, i) => {
                  const idle = o === 'maximize' && req.maximize.length === 0;
                  return (
                    <li key={o} className="prio-row">
                      <span className="prio-n">{i + 1}</span>
                      <span style={{ flex: 1, opacity: idle ? 0.6 : 1 }}>{OBJ_LABEL[o]} {idle && <span className="note-faint">nothing to maximize</span>}</span>
                      <button type="button" className="btn-icon" disabled={i === 0} aria-label={`Move ${OBJ_LABEL[o]} up`} onClick={() => moveObjective(i, -1)}><Icon.up /></button>
                      <button type="button" className="btn-icon" disabled={i === req.objectiveOrder.length - 1} aria-label={`Move ${OBJ_LABEL[o]} down`} onClick={() => moveObjective(i, 1)}><Icon.down /></button>
                    </li>
                  );
                })}
              </ol>
              <p className="note-faint" style={{ marginTop: 10 }}>Tie-break, always last: fewest Somersloops and shards.</p>
            </section>

            <section className="panel">
              <h2 className="h2">Raw caps</h2>
              <p className="note" style={{ margin: '4px 0 12px' }}>Limit how much of a raw resource the plan may use. Every node in the save is available otherwise.</p>
              <div className="stack">
                {req.rawCaps.map((c, i) => (
                  <div key={c.item} className="item-row">
                    <span className="item-name">{label(c.item)}</span>
                    <input type="number" min={0} step="any" className="input-num" aria-label={`${label(c.item)} cap per minute`} value={c.maxPerMin}
                      onChange={(e) => set({ rawCaps: req.rawCaps.map((x, j) => (j === i ? { ...x, maxPerMin: rate(e.target.value) } : x)) })} />
                    <span className="note">/min</span>
                    <button type="button" className="btn-icon" aria-label={`Remove ${label(c.item)} cap`} onClick={() => set({ rawCaps: req.rawCaps.filter((_, j) => j !== i) })}><Icon.x /></button>
                  </div>
                ))}
                <button type="button" className="btn-dashed" onClick={() => setPicker('cap')}><Icon.plus />Add a cap</button>
              </div>
            </section>

            <section className="panel stack" style={{ gap: 10 }}>
              <h2 className="h2">Sources</h2>
              <a href="#/nodes" className="source-link">
                <span style={{ flex: 1 }}>Nodes and raw caps</span>
                <span className="note">{problem.nodes.extractable} nodes · {req.excludedNodes.length} excluded</span>
                <span aria-hidden="true">›</span>
              </a>
              <a href="#/recipes" className="source-link">
                <span style={{ flex: 1 }}>Recipes</span>
                <span className="note">{problem.alternateRecipeCount} alternates · {req.disabledRecipes.length} off</span>
                <span aria-hidden="true">›</span>
              </a>
              <div>
              </div>
            </section>
          </aside>
        )}

        <Results />
      </div>

      {picker && (
        <Picker
          title={{ target: 'Add target item', maximize: 'Add item to maximize', manual: 'Add a manual input', cap: 'Cap a raw resource' }[picker]}
          entries={pickEntries[picker]} onPick={onPick} onClose={() => setPicker(null)}
          emptyNote={picker === 'cap' ? 'No raw resource matches.' : 'No item matches. Items this save can’t make yet are listed as “can’t be made yet”.'} />
      )}
    </>
  );
}
