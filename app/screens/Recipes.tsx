/** Recipes: turn recipes off for this plan (request.disabledRecipes). */
import { useMemo, useState } from 'react';
import { useApp } from '../state';
import { num } from '../ui/kit';
import type { RecipeInfo } from '../engine/protocol';

type Filter = 'all' | 'used' | 'alt' | 'off' | 'locked';

export function RecipesScreen() {
  const { state, label, updateRequest, freshness } = useApp();
  const plan = state.plan;
  const problem = state.problem;
  const [scope, setScope] = useState<'chain' | 'all'>('chain');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const result = plan?.lastResult?.result;
  const chainItems = useMemo(() => {
    const s = new Set<string>();
    if (!plan) return s;
    plan.request.targets.forEach((t) => s.add(t.item));
    plan.request.maximize.forEach((m) => s.add(m.item));
    result?.items.forEach((f) => { if (f.produced > 1e-9 || f.delivered > 1e-9) s.add(f.item); });
    return s;
  }, [plan, result]);
  const used = useMemo(() => new Set(result?.buildings.map((b) => b.recipe) ?? []), [result]);

  if (!plan || !problem) return <div className="page-narrow"><p className="muted">Load a save and open a plan first.</p></div>;
  const disabled = new Set(plan.request.disabledRecipes);
  const rawItems = new Set(problem.items.filter((i) => i.raw).map((i) => i.id));
  const recipes = problem.recipes.filter((r) => r.products.length > 0 && !rawItems.has(r.products[0]!.item));
  const mainOf = (r: RecipeInfo) => r.products[0]!.item;

  const inScope = recipes.filter((r) => scope === 'all' || chainItems.has(mainOf(r)));
  const q = query.trim().toLowerCase();
  const matches = (r: RecipeInfo) => {
    if (filter === 'used' && !used.has(r.id)) return false;
    if (filter === 'alt' && !r.isAlternate) return false;
    if (filter === 'off' && !disabled.has(r.id)) return false;
    if (filter === 'locked' && r.status !== 'recipe-locked') return false;
    if (q && !label(r.id).toLowerCase().includes(q) && !label(mainOf(r)).toLowerCase().includes(q)) return false;
    return true;
  };
  const groups = new Map<string, RecipeInfo[]>();
  for (const r of inScope.filter(matches)) { const l = groups.get(mainOf(r)) ?? []; l.push(r); groups.set(mainOf(r), l); }
  const order = { runnable: 0, 'building-locked': 1, 'recipe-locked': 2 } as const;
  const sorted = [...groups].sort((a, b) => label(a[0]).localeCompare(label(b[0])))
    .map(([item, list]) => [item, list.sort((x, y) => order[x.status] - order[y.status] || Number(x.isAlternate) - Number(y.isAlternate) || label(x.id).localeCompare(label(y.id)))] as const);

  const toggle = (id: string) => updateRequest((r) => ({
    ...r, disabledRecipes: r.disabledRecipes.includes(id) ? r.disabledRecipes.filter((x) => x !== id) : [...r.disabledRecipes, id],
  }));
  const counts: Record<Filter, number> = {
    all: inScope.length,
    used: inScope.filter((r) => used.has(r.id)).length,
    alt: inScope.filter((r) => r.isAlternate).length,
    off: inScope.filter((r) => disabled.has(r.id)).length,
    locked: inScope.filter((r) => r.status === 'recipe-locked').length,
  };
  const runnableAlts = recipes.filter((r) => r.isAlternate && r.status === 'runnable').length;
  const io = (xs: RecipeInfo['ingredients']) => xs.map((x) => `${num(x.perMin)} ${label(x.item)}`).join(' + ');

  return (
    <div className="page-narrow">
      <div className="row" style={{ alignItems: 'flex-end', gap: '12px 24px' }}>
        <div style={{ minWidth: 0 }}>
          <a href="#/plan" className="note" style={{ textDecoration: 'none' }}>‹ {plan.name}</a>
          <h1 className="h1 h1-upper">Recipes</h1>
          <p className="lede">Every recipe this save can run is allowed. Turn one off to keep the solver from using it — in this plan only.</p>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <span className="note">{runnableAlts} alternates available · {disabled.size} turned off</span>
          <button type="button" className="btn" disabled={!disabled.size} onClick={() => updateRequest((r) => ({ ...r, disabledRecipes: [] }))}>Allow all</button>
        </div>
      </div>

      {freshness?.state === 'stale' && freshness.reasons.includes('request-changed') && (
        <div className="msg msg-warn" role="status" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 280px', color: 'var(--warn-text)' }}>The plan changed. Solve again to use these recipe choices.</span>
          <a className="btn btn-sm" href="#/plan" style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}>Back to plan</a>
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <div className="seg" role="group" aria-label="Which recipes">
          <button type="button" aria-pressed={scope === 'chain'} onClick={() => setScope('chain')}>This plan’s items</button>
          <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All items</button>
        </div>
        {(['all', 'used', 'alt', 'off', 'locked'] as const).map((f) => (
          <button key={f} type="button" className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {{ all: 'All', used: 'In this result', alt: 'Alternates', off: 'Turned off', locked: 'Not unlocked' }[f]}<span className="mono note-faint">{counts[f]}</span>
          </button>
        ))}
        <label className="row input" style={{ marginLeft: 'auto', minWidth: 240, gap: 8, flexWrap: 'nowrap' }}>
          <span className="sr-only">Find a recipe or item</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a recipe or item" style={{ flex: 1, minWidth: 0, border: 0, background: 'transparent', outline: 'none' }} />
        </label>
      </div>
      <p className="note-faint" style={{ marginTop: -12 }}>
        {scope === 'chain' ? (chainItems.size ? 'Items your targets and last result use. ' : 'Add targets and solve to narrow this to your plan’s items. ') : ''}
        Rates are per building at 100%.
      </p>

      {sorted.length === 0 && <p className="panel muted" style={{ padding: 24, textAlign: 'center' }}>{filter === 'used' && !result ? 'No result yet — solve the plan to see which recipes it uses.' : scope === 'chain' && !chainItems.size ? 'No items yet — add a target, or show all items.' : 'Nothing matches this filter.'}</p>}

      {sorted.map(([item, list]) => (
        <section key={item} className="panel" style={{ padding: 0, overflow: 'hidden' }}>
          <h2 className="h2" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>{label(item)}</h2>
          <ul className="plain">
            {list.map((r) => {
              const on = !disabled.has(r.id);
              const runnable = r.status === 'runnable';
              const kind = r.isAlternate ? { t: 'Alternate', c: 'tag-save' } : { t: 'Standard', c: 'tag-default' };
              const note = r.status === 'recipe-locked'
                ? (r.isAlternate ? 'Not unlocked: find its hard drive to unlock it.' : 'Not unlocked: needs a milestone or research this save hasn’t done.')
                : r.status === 'building-locked' ? `Needs the ${label(r.building)}, which this save hasn’t unlocked.`
                : !on ? 'Turned off for this plan.' : '';
              return (
                <li key={r.id} className="recipe-row" style={{ opacity: runnable ? 1 : 0.72 }}>
                  <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{label(r.id).replace(/^Alternate: /, '')}</span>
                      <span className={`tag ${kind.c}`}>{kind.t}</span>
                      {r.status === 'recipe-locked' && <span className="tag tag-default">Not unlocked</span>}
                      {used.has(r.id) && <span className="tag tag-ok">In this result</span>}
                    </div>
                    <div className="note">{label(r.building)} · <span className="mono" style={{ fontSize: 12 }}>{io(r.ingredients)} → {io(r.products)}</span></div>
                    {note && <div className="note" style={{ color: !on && runnable ? 'var(--warn)' : undefined }}>{note}</div>}
                  </div>
                  {runnable && (
                    <button type="button" role="switch" aria-checked={on} aria-label={`Allow ${label(r.id)}`} className="switch" onClick={() => toggle(r.id)}>
                      <span className="switch-label" style={{ color: on ? undefined : 'var(--warn)' }}>{on ? 'On' : 'Off'}</span>
                      <span className={`switch-track${on ? ' on' : ''}`} aria-hidden="true"><span className="switch-knob" /></span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
