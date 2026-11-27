/** The two file loaders (game data, save), used by First run and Setup. */
import { useState, type DragEvent } from 'react';
import { useApp, type LoadState } from '../state';
import { Icon, Message } from '../ui/kit';
import type { EngineError } from '../engine/protocol';

const STAGES: Record<string, string> = {
  decode: 'Detecting encoding',
  parse: 'Reading recipes and items',
  labels: 'Building game data',
  header: 'Reading header',
  decompress: 'Decompressing body',
  objects: 'Reading world objects',
  summary: 'Summarizing unlocks and nodes',
};
const DOCS_ORDER = ['decode', 'parse', 'labels'];
const SAVE_ORDER = ['header', 'decompress', 'objects', 'summary'];

function progressOf(kind: 'docs' | 'save', l: LoadState): number {
  const order = kind === 'docs' ? DOCS_ORDER : SAVE_ORDER;
  const i = Math.max(0, order.indexOf(l.stage ?? ''));
  const within = l.stage === 'objects' ? (l.fraction ?? 0) : 0;
  return Math.round(((i + within + 0.5) / (order.length + 0.5)) * 100);
}

function errorCopy(kind: 'docs' | 'save', e: EngineError): { title: string; body: string; path?: string; copy?: boolean } {
  if (e.kind === 'solver' || e.kind === 'other') {
    return { title: e.message || 'The planner engine couldn’t start', body: 'Nothing was loaded. Reload the page to try again; if it keeps happening, the details below help find out why.', copy: true };
  }
  if (kind === 'docs') {
    return {
      title: 'That isn’t the game’s Docs file',
      body: 'It has none of the recipe and item classes the planner needs. Use en-US.json, or another language’s file, from the game install:',
      path: 'Satisfactory/CommunityResources/Docs/en-US.json',
    };
  }
  if (e.kind === 'unsupported-version') {
    return /1\.0/.test(e.message)
      ? { title: 'This save is from before Satisfactory 1.0', body: 'The planner reads saves from Update 1.0 onward. Open it in the current game, save again, and load the new file.' }
      : { title: 'This save is from before Update 1.1', body: 'The planner reads saves from Update 1.1 onward. Open it in the current game, save again, and load the new file.' };
  }
  if (e.kind === 'needs-game-data') return { title: 'Load game data first', body: e.message };
  return {
    title: 'Couldn’t read this save',
    body: 'The file may still have been copying, or was cut off. Try it again, or pick the matching autosave.',
    copy: true,
  };
}

export function LoaderCard({ kind, compact }: { kind: 'docs' | 'save'; compact?: boolean }) {
  const { state, pick, loadDocs, loadSave } = useApp();
  const [over, setOver] = useState(false);
  const isDocs = kind === 'docs';
  const l = isDocs ? state.docsLoad : state.saveLoad;
  const locked = !isDocs && !state.docs;
  const loaded = l.phase === 'done' || l.phase === 'warn';
  const tone = { idle: 'var(--border)', reading: 'var(--border-strong)', done: 'var(--ok-border)', warn: 'var(--warn-border)', error: 'var(--bad-border)' }[l.phase];
  const status = locked ? 'Waiting for game data'
    : { idle: 'Not loaded', reading: 'Reading…', done: 'Loaded', warn: 'Loaded with a warning', error: l.error?.kind === 'unsupported-version' ? 'Refused' : 'Not loaded' }[l.phase];
  const statusColor = { idle: 'var(--faint)', reading: 'var(--default)', done: 'var(--ok)', warn: 'var(--warn)', error: '#ff9a8f' }[l.phase];

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (locked) return;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const file = { name: f.name, read: async () => new Uint8Array(await f.arrayBuffer()) };
    void (isDocs ? loadDocs(file) : loadSave(file));
  };

  const err = l.phase === 'error' && l.error ? errorCopy(kind, l.error) : undefined;
  const s = state.summary;
  const d = state.docs;

  return (
    <section className="panel" style={{ borderColor: tone, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      onDragOver={(e) => { e.preventDefault(); if (!locked) setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="row">
        <span className={`step-n${locked ? ' locked' : ''}`}>{isDocs ? 1 : 2}</span>
        <h2 className="h2-lg">{isDocs ? 'Game data' : 'Save'}</h2>
        <span style={{ marginLeft: 'auto', fontSize: 13, color: statusColor }}>{status}</span>
      </div>

      {l.phase === 'idle' && (
        <button type="button" className={`drop${over ? ' over' : ''}`} disabled={locked} onClick={() => void pick(isDocs ? 'game-data' : 'save')}>
          <Icon.upload />
          <span style={{ fontWeight: 600 }}>{locked ? 'Load game data first' : isDocs ? 'Drop en-US.json here, or choose it' : 'Drop a .sav here, or choose one'}</span>
          <span className="muted" style={{ fontSize: 14 }}>
            {locked ? 'The save is read against the game data.' : isDocs ? 'Any language’s Docs file works.' : 'Saves from Update 1.0 or later.'}
          </span>
        </button>
      )}

      {l.phase === 'reading' && (
        <div className="reading" role="status">
          <div className="mono muted" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{l.fileName}</div>
          <div style={{ fontWeight: 600 }}>{STAGES[l.stage ?? ''] ?? 'Reading…'}</div>
          <div className="bar-track" role="progressbar" aria-label={`Reading ${isDocs ? 'game data' : 'save'}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressOf(kind, l)}>
            <div className="bar-fill" style={{ width: `${progressOf(kind, l)}%` }} />
          </div>
        </div>
      )}

      {loaded && isDocs && d && (
        <div className="loaded-card">
          <div className="row" style={{ fontWeight: 600, fontSize: 17, gap: 8 }}><Icon.check />{d.language} game data</div>
          <div className="mono muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{d.fileName}</div>
          <div className="note">{d.encoding.toUpperCase()} · {d.itemCount} items · {d.recipeCount} recipes · content hash <span className="mono" style={{ color: 'var(--text)' }}>{d.contentHash}</span></div>
        </div>
      )}
      {loaded && !isDocs && s && (
        <div className="loaded-card">
          <div className="row" style={{ fontWeight: 600, fontSize: 17, gap: 8 }}><Icon.check />{s.source.sessionName.trim() || s.source.saveName}</div>
          <div className="mono muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{l.fileName ?? s.source.saveName}</div>
          <div className="note">
            Saved {new Date(s.source.savedAt).toLocaleString()} · save version <span className="mono" style={{ color: 'var(--text)' }}>{s.source.saveVersion}</span> · build <span className="mono" style={{ color: 'var(--text)' }}>{s.source.buildVersion}</span>
          </div>
        </div>
      )}
      {l.phase === 'warn' && s && (
        <Message tone="warn" title="Newer than this planner knows">
          {s.version.message ?? 'This save’s version is not one the planner was verified against.'} Check the Game Mode values before planning.
        </Message>
      )}

      {err && l.error && (
        <div className="msg msg-bad" role="alert" style={{ flexDirection: 'column', gap: 10 }}>
          <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <Icon.bad />
            <div>
              <div className="msg-title">{err.title}</div>
              <div className="msg-body">{err.body}</div>
            </div>
          </div>
          {err.path && <code className="path">{err.path}</code>}
          {l.error.detail && (
            <details className="tech">
              <summary>Technical details</summary>
              <code className="block">{l.fileName ? `${l.fileName}: ` : ''}{l.error.detail}</code>
            </details>
          )}
          {err.copy && l.error.detail && (
            <button type="button" className="btn-link" style={{ alignSelf: 'flex-start' }}
              onClick={() => void navigator.clipboard?.writeText(`${l.fileName}\n${l.error?.detail}`)}>Copy details</button>
          )}
        </div>
      )}

      {(l.phase === 'error' || loaded) && !compact && (
        <div className="row">
          <button type="button" className="btn" onClick={() => void pick(isDocs ? 'game-data' : 'save')}>
            {l.phase === 'error' ? (isDocs ? 'Choose another file' : 'Choose another save') : 'Choose a different file'}
          </button>
        </div>
      )}
      {(l.phase === 'error' || loaded) && compact && (
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => void pick(isDocs ? 'game-data' : 'save')}>
            {isDocs ? 'Choose another file' : 'Choose another save'}
          </button>
        </div>
      )}

      <p className="note-faint">
        {isDocs ? 'In the game install: ' : 'Saves on Windows: '}
        <code className="mono" style={{ fontSize: 12, color: 'var(--default)', overflowWrap: 'anywhere' }}>
          {isDocs ? 'CommunityResources/Docs/' : '%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/<id>/'}
        </code>
      </p>
    </section>
  );
}

export function FirstRun({ onContinue }: { onContinue: () => void }) {
  const { state } = useApp();
  const ready = !!state.docs && (state.saveLoad.phase === 'done' || state.saveLoad.phase === 'warn');
  return (
    <div className="page-narrow" style={{ maxWidth: 1120, paddingTop: 40 }}>
      <div>
        <h1 className="hero">Plan a factory from your save</h1>
        <p className="lede" style={{ marginTop: 10, maxWidth: '68ch' }}>
          Two files get you started: the game’s own data, so recipes and numbers match your install, and a save, so plans use what you’ve unlocked and how your world is set up. Both stay on this computer.
        </p>
      </div>
      <div className="grid-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
        <LoaderCard kind="docs" />
        <LoaderCard kind="save" />
      </div>
      <div className="panel row" style={{ padding: '16px 20px', gap: '12px 20px' }}>
        <div className="stack" style={{ flex: '1 1 360px', gap: 4, fontSize: 14, color: 'var(--muted)' }}>
          <span>Nothing is uploaded. Files are read in this browser.</span>
          <span>Using the desktop app? It finds your game install and save folder for you.</span>
        </div>
        <button type="button" className="btn-primary btn" disabled={!ready} onClick={onContinue}>
          {state.saveLoad.phase === 'warn' ? 'Continue anyway' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
