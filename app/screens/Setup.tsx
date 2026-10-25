/** Setup: what the planner read from the game data and the save. */
import { useApp } from '../state';
import { LoaderCard } from './Loaders';
import { Message, num } from '../ui/kit';
import type { Setting } from '../../src';

function SourceTag({ s }: { s: Setting<unknown> }) {
  return <span className={`tag ${s.source === 'save' ? 'tag-save' : 'tag-default'}`}>{s.source === 'save' ? 'Save' : 'Default'}</span>;
}

const PURITY: Record<string, string> = { default: 'Map as built', 'all-pure': 'All pure', random: 'Random', unknown: 'Unknown value' };
const RANDOM: Record<string, string> = { off: 'Off (map as built)', strict: 'Strict', 'advanced-rich': 'Advanced, resource rich' };

export function Setup() {
  const { state, label } = useApp();
  const s = state.summary;
  const p = state.problem;
  return (
    <div className="page-narrow">
      <div>
        <h1 className="h1 h1-upper">Setup</h1>
        <p className="lede">Everything stays on this computer. The save tells the planner what you’ve unlocked and how your world is set up; plans always start from scratch.</p>
      </div>

      <div className="grid-auto">
        <LoaderCard kind="docs" compact />
        <LoaderCard kind="save" compact />
      </div>

      {s && p && (
        <>
          <div className="grid-auto">
            <section className="panel" style={{ padding: 20 }}>
              <h2 className="h2-lg">Game Mode</h2>
              <p className="note" style={{ margin: '4px 0 12px' }}>The game only writes settings you changed. <strong style={{ color: 'var(--text)' }}>Default</strong> means the save didn’t store it.</p>
              <table className="kv">
                <tbody>
                  <tr><th scope="row">Parts cost</th><td className="mono">{num(s.gameMode.partsCostMultiplier.value)}×</td><td><SourceTag s={s.gameMode.partsCostMultiplier} /></td></tr>
                  <tr><th scope="row">Space Elevator parts cost</th><td className="mono">{num(s.gameMode.spacePartsCostMultiplier.value)}×</td><td><SourceTag s={s.gameMode.spacePartsCostMultiplier} /></td></tr>
                  <tr><th scope="row">Node purity</th><td>{PURITY[s.gameMode.nodePurity.value] ?? s.gameMode.nodePurity.value}</td><td>{s.gameMode.nodePurity.value === 'unknown' ? <span className="tag tag-warn">Unknown value</span> : <SourceTag s={s.gameMode.nodePurity} />}</td></tr>
                  <tr><th scope="row">Node resources</th><td>{RANDOM[s.gameMode.nodeRandomization.value] ?? s.gameMode.nodeRandomization.value}</td><td><SourceTag s={s.gameMode.nodeRandomization} /></td></tr>
                  <tr><th scope="row">Node seed</th><td className="mono">{s.gameMode.nodeRandomizationSeed.value ?? '—'}</td><td><SourceTag s={s.gameMode.nodeRandomizationSeed} /></td></tr>
                  <tr><th scope="row">Overclocking</th><td>{s.progression.overclockUnlocked ? 'Unlocked' : 'Locked'}</td><td><span className="tag tag-save">Save</span></td></tr>
                  <tr><th scope="row">Somersloop boosting</th><td>{s.progression.productionBoostUnlocked ? 'Unlocked' : 'Locked'}</td><td><span className="tag tag-save">Save</span></td></tr>
                </tbody>
              </table>
              {Object.keys(s.gameMode.unrecognized).length > 0 && (
                <p className="note" style={{ marginTop: 10 }}>Also in the save but not used by the planner: {Object.keys(s.gameMode.unrecognized).join(', ')}.</p>
              )}
            </section>

            <div className="stack-lg">
              <section className="panel" style={{ padding: 20 }}>
                <h2 className="h2-lg" style={{ marginBottom: 12 }}>Progress</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px 20px' }}>
                  <Fact k="Space Elevator" v={s.progression.phase.currentIndex !== undefined ? `Phase ${s.progression.phase.currentIndex}` : '—'} sub={s.progression.phase.target ? `working toward ${label(s.progression.phase.target)}` : ''} />
                  <Fact k="Milestones" v={`Tier ${s.progression.highestMilestoneTier}`} sub={`${s.progression.milestones.length} purchased`} />
                  <Fact k="MAM research" v={String(s.progression.mamResearch.length)} sub="nodes researched" />
                  <Fact k="Alternates" v={String(s.progression.unlockedAlternateRecipes.length)} sub={`recipes unlocked · ${p.alternateRecipeCount} runnable`} />
                  <Fact k="Best belt" v={p.belt ? label(p.belt.id).replace('Conveyor Belt ', '') : 'None'} sub={p.belt ? `${num(p.belt.ratePerMin)} / min` : 'no belt unlocked'} />
                  <Fact k="Best pipe" v={p.pipe ? label(p.pipe.id).replace('Pipeline ', '') : 'None'} sub={p.pipe ? `${num(p.pipe.ratePerMin)} m³ / min` : 'no pipe unlocked'} />
                </div>
              </section>
              <section className="panel" style={{ padding: 20 }}>
                <h2 className="h2-lg" style={{ marginBottom: 12 }}>Collected</h2>
                <div className="stack" style={{ gap: 10, fontSize: 14 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span>Somersloops</span><span className="mono">{s.holdings.somersloops.total} <span className="muted">= {s.holdings.somersloops.stored} stored + {s.holdings.somersloops.inBuildings} slotted</span></span></div>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span>Power Shards</span><span className="mono">{s.holdings.powerShards.total} <span className="muted">= {s.holdings.powerShards.stored} stored + {s.holdings.powerShards.inBuildings} slotted</span></span></div>
                  <div className="row" style={{ justifyContent: 'space-between' }}><span>Power Slugs</span><span className="mono">{s.holdings.powerSlugs.blue} · {s.holdings.powerSlugs.yellow} · {s.holdings.powerSlugs.purple} <span className="muted">→ {s.holdings.powerSlugs.shardEquivalent} shards</span></span></div>
                </div>
                <p className="note-faint" style={{ marginTop: 10 }}>Slotted items count as available, since plans start from scratch. Slugs aren’t counted until crafted.</p>
              </section>
            </div>
          </div>

          <section className="panel" style={{ padding: 20 }}>
            <h2 className="h2-lg" style={{ marginBottom: 12 }}>Resource nodes</h2>
            <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
              <div className="inset"><div className="mono" style={{ fontSize: 24 }}>{p.nodes.extractable}</div><div className="note">extractable nodes, plus {p.nodes.geysers} geysers</div></div>
              <div className="inset"><div className="row" style={{ gap: 8 }}><span className="mono" style={{ fontSize: 24 }}>{p.nodes.purityFromSave} / {p.nodes.extractable}</span><span className="tag tag-save">Save</span></div><div className="note">purities stored in the save</div></div>
              <div className="inset"><div className="row" style={{ gap: 8 }}><span className="mono" style={{ fontSize: 24 }}>{p.nodes.resourceFromSave}</span><span className="tag tag-default">Catalog</span></div><div className="note">nodes with a resource stored in the save — the rest come from the bundled 1.2 map</div></div>
            </div>
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="data">
                <thead><tr><th>Resource</th><th className="num">Impure</th><th className="num">Normal</th><th className="num">Pure</th><th className="num">Map capacity / min</th></tr></thead>
                <tbody>
                  {p.nodes.counts.map((c) => (
                    <tr key={c.resource}>
                      <td>{label(c.resource)}</td><td className="num">{c.impure}</td><td className="num">{c.normal}</td><td className="num">{c.pure}</td>
                      <td className="num">{p.mapAvailability[c.resource] !== undefined ? num(p.mapAvailability[c.resource]!, 0) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {p.nodes.assumptions.map((a) => <p key={a} className="note" style={{ marginTop: 10 }}>{a}</p>)}
          </section>

          {(s.assumptions.length > 0 || s.warnings.length > 0 || state.storageWarnings.length > 0) && (
            <section className="panel" style={{ padding: 20 }}>
              <h2 className="h2-lg" style={{ marginBottom: 12 }}>Notes from reading</h2>
              <div className="stack">
                {state.storageWarnings.map((w) => <Message key={w} tone="warn">{w}</Message>)}
                {s.warnings.map((w) => <Message key={w} tone="warn">{w}</Message>)}
              </div>
              {s.assumptions.length > 0 && <ul className="bullets" style={{ marginTop: 12 }}>{s.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>}
            </section>
          )}

          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <a className="btn btn-primary" href="#/plan">Go to plan</a>
          </div>
        </>
      )}
    </div>
  );
}

function Fact({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div>
      <div className="eyebrow">{k}</div>
      <div className="mono" style={{ fontSize: 18 }}>{v}</div>
      <div className="note">{sub}</div>
    </div>
  );
}
