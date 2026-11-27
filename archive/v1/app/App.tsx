/** App shell: top bar, banner slot, routing between screens. */
import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './state';
import { FirstRun } from './screens/Loaders';
import { Setup } from './screens/Setup';
import { PlanScreen } from './screens/Plan';
import { NodesScreen } from './screens/Nodes';
import { RecipesScreen } from './screens/Recipes';
import { PlansScreen } from './screens/Plans';
import { Icon, Message } from './ui/kit';

type Route = 'plan' | 'nodes' | 'recipes' | 'plans' | 'setup';
const ROUTES: Route[] = ['plan', 'nodes', 'recipes', 'plans', 'setup'];
const routeOf = (h: string): Route => (ROUTES as string[]).includes(h.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '') ? (h.replace(/^#\/?/, '').split(/[/?]/)[0] as Route) : 'plan';

export function App() {
  if (location.protocol === 'file:') return <FileProtocol />;
  return <AppProvider><Shell /></AppProvider>;
}

function Shell() {
  const { state } = useApp();
  const [route, setRoute] = useState<Route>(routeOf(location.hash));
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  useEffect(() => {
    const on = () => setRoute(routeOf(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const ready = !!state.docs && !!state.summary;
  // Decide once boot finishes; afterwards first run only ends by pressing Continue.
  useEffect(() => { if (!state.booting && firstRun === null) setFirstRun(!ready); }, [state.booting, ready, firstRun]);
  const inFirstRun = firstRun !== false || !ready;

  const go = (r: Route) => { location.hash = `#/${r}`; };
  const s = state.summary;
  const d = state.docs;

  return (
    <>
      <div className="stripe" aria-hidden="true" />
      <header className="topbar">
        <div className="brand"><Icon.logo /><span className="wordmark">Production Planner</span><span className="version-chip">U1.2</span></div>
        <nav className="nav" aria-label="Main">
          {inFirstRun ? (
            <>
              <span aria-disabled="true" title="Load a save first">Plan</span>
              <span aria-disabled="true" title="Load a save first">Nodes</span>
              <a href="#/setup" aria-current="page" onClick={(e) => e.preventDefault()}>Setup</a>
            </>
          ) : (
            <>
              <a href="#/plan" aria-current={route === 'plan' || route === 'recipes' ? 'page' : undefined}>Plan</a>
              <a href="#/nodes" aria-current={route === 'nodes' ? 'page' : undefined}>Nodes</a>
              <a href="#/plans" aria-current={route === 'plans' ? 'page' : undefined}>Plans</a>
              <a href="#/setup" aria-current={route === 'setup' ? 'page' : undefined}>Setup</a>
            </>
          )}
        </nav>
        <div className="chips">
          {s && !inFirstRun && (
            <a className="file-chip" href="#/setup" title="Loaded save">{s.source.sessionName.trim() || s.source.saveName}<span className="mono">v{s.source.saveVersion} · {s.source.buildVersion}</span></a>
          )}
          {d && !inFirstRun && (
            <a className="file-chip" href="#/setup" title="Loaded game data">{d.fileName.replace(/^.*[\\/]/, '').replace(/^[0-9a-f]{8}-/, '')}<span className="mono">#{d.contentHash.slice(0, 8)}</span></a>
          )}
        </div>
      </header>
      <div className="banner-slot">
        {state.noStorage && (
          <Message tone="warn" title="Plans won’t be kept.">{state.storageWarnings[0]}</Message>
        )}
      </div>

      {state.booting ? <div className="splash" role="status">Loading the planner…</div>
        : state.fatal ? <div className="page-narrow"><Message tone="bad" title={state.fatal.message} details={state.fatal.detail}>Reload the page to try again.</Message></div>
        : inFirstRun ? <FirstRun onContinue={() => { setFirstRun(false); go('setup'); }} />
        : route === 'setup' ? <Setup />
        : route === 'nodes' ? <NodesScreen />
        : route === 'recipes' ? <RecipesScreen />
        : route === 'plans' ? <PlansScreen />
        : <PlanScreen />}
    </>
  );
}

function FileProtocol() {
  return (
    <div className="page-narrow" style={{ maxWidth: 760, paddingTop: 64 }}>
      <div className="panel" style={{ borderTop: '4px solid var(--accent)', padding: 24 }}>
        <h1 className="h1 h1-upper">Open the planner through its local server</h1>
        <p className="lede" style={{ color: 'var(--text-2)' }}>This page was opened straight from a file. Browsers block the solver and plan storage there, so nothing would work.</p>
        <ol style={{ color: 'var(--text-2)' }}>
          <li>Start the planner’s local server (<code className="mono">npm run preview</code>), or open the desktop app.</li>
          <li>Open the address it prints, for example <code className="mono">http://localhost:4173</code>.</li>
        </ol>
        <p className="note-faint">Plans saved under that address are still there.</p>
      </div>
    </div>
  );
}
