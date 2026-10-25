/** Plans: list with freshness, open / duplicate / rename / delete, export and import. */
import { useCallback, useEffect, useState } from 'react';
import { useApp, type PlanRow } from '../state';
import { Message, ago, mw, num } from '../ui/kit';
import type { ImportReport } from '../../src';

function badgeFor(row: PlanRow): { cls: string; text: string; why: string } {
  if (row.errors.length) return { cls: 'badge-bad', text: 'Can’t open', why: 'Saved by another version of the planner, or edited outside it.' };
  const f = row.freshness;
  const r = row.plan?.lastResult?.result;
  if (!f || f.state === 'never-solved' || !r) return { cls: 'badge-neutral', text: 'Not solved', why: 'No result yet.' };
  const summary = `${r.buildingCount} buildings · ${mw(r.power.actualMW)}`;
  if (f.state === 'stale') {
    const reason = f.reasons[0];
    const text = { 'request-changed': 'Request changed', 'game-data-changed': 'Game data changed', 'save-changed': 'Save changed', 'solver-changed': 'Solver changed', 'never-solved': 'Not solved' }[reason ?? 'request-changed'];
    return { cls: 'badge-warn', text, why: f.messages[0] ?? summary };
  }
  if (r.status === 'targets-not-met') {
    const s = r.infeasibility?.shortfalls[0];
    return { cls: 'badge-bad', text: 'Short of target', why: s ? `Reaches ${num(s.achieved)} of ${num(s.target)}/min` : summary };
  }
  return { cls: 'badge-ok', text: 'Fresh', why: `All targets met · ${summary}` };
}

function requestLine(row: PlanRow, label: (id: string) => string): string {
  const q = row.plan?.request;
  if (!q) return '';
  const parts = [
    ...q.targets.map((t) => `${num(t.ratePerMin)} ${label(t.item)}`),
    ...q.maximize.map((m) => `max ${label(m.item)}`),
  ];
  return parts.length ? parts.join(' · ') : 'Empty request';
}

export function PlansScreen() {
  const { state, label, planRows, openPlan, newPlan, duplicatePlan, deletePlan, renamePlanById, exportPlans, importPlans } = useApp();
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  const reload = useCallback(async () => setRows(await planRows()), [planRows]);
  useEffect(() => { void reload(); }, [reload, state.plans, state.plan?.lastResult]);

  const open = async (id: string) => { await openPlan(id); location.hash = '#/plan'; };
  const doExport = async (ids?: string[]) => {
    const r = await exportPlans(ids);
    if (r) setExported(`Exported ${r.plans} plan${r.plans === 1 ? '' : 's'} as ${r.fileName}.`);
  };
  const doImport = async () => {
    const r = await importPlans();
    if (r) { setReport(r); await reload(); }
  };

  return (
    <div className="page-narrow" style={{ maxWidth: 1320 }}>
      <div className="row" style={{ alignItems: 'flex-end', gap: '12px 24px' }}>
        <div>
          <h1 className="h1 h1-upper">Plans</h1>
          <p className="lede">
            {state.noStorage ? 'This browser isn’t keeping plans — export any you want before closing the tab.'
              : state.storageWarnings.length ? 'The browser may clear saved plans if it runs low on space. Export plans you want to keep.'
              : 'Kept in this browser. Export plans to move them to another computer or the desktop app.'}
          </p>
        </div>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <button type="button" className="btn" onClick={() => void doImport()}>Import…</button>
          <button type="button" className="btn" disabled={!rows?.length} onClick={() => void doExport(checked.size ? [...checked] : undefined)}>
            {checked.size ? `Export selected (${checked.size})` : 'Export all'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!state.summary} onClick={() => void newPlan().then(() => { location.hash = '#/plan'; })}>New plan</button>
        </div>
      </div>

      {exported && <Message tone="ok" title={exported} action={<button type="button" className="btn-link" onClick={() => setExported(null)}>Dismiss</button>} />}

      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        <section aria-label="Your plans" className="panel" style={{ flex: '999 1 640px', minWidth: 0, padding: 0, overflow: 'hidden' }}>
          {rows === null ? <p className="note" style={{ padding: 16 }}>Loading plans…</p> : rows.length === 0 ? (
            <div className="empty">
              <h2 className="h2-lg">No plans yet</h2>
              <p className="muted" style={{ maxWidth: '44ch', margin: 0 }}>A plan holds your targets, budgets and its last result. Start one from a loaded save, or import plans exported from another computer.</p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button type="button" className="btn btn-primary" disabled={!state.summary} onClick={() => void newPlan().then(() => { location.hash = '#/plan'; })}>New plan</button>
                <button type="button" className="btn" onClick={() => void doImport()}>Import…</button>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data" style={{ minWidth: 820 }}>
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>
                      <input type="checkbox" aria-label="Select all plans" checked={checked.size === rows.length} onChange={(e) => setChecked(e.target.checked ? new Set(rows.map((r) => r.listing.id)) : new Set())} />
                    </th>
                    <th>Plan</th><th>Save</th><th>Result</th><th><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const l = row.listing;
                    const b = badgeFor(row);
                    const active = state.plan?.id === l.id;
                    const stale = row.freshness?.state === 'stale';
                    return (
                      <tr key={l.id} style={{ background: active ? '#1f2328' : undefined }}>
                        <td><input type="checkbox" aria-label={`Select ${l.name}`} checked={checked.has(l.id)} onChange={(e) => { const s = new Set(checked); if (e.target.checked) s.add(l.id); else s.delete(l.id); setChecked(s); }} /></td>
                        <td>
                          {renaming?.id === l.id ? (
                            <input className="input" aria-label="Plan name" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: l.id, name: e.target.value })}
                              onBlur={() => { void renamePlanById(l.id, renaming.name); setRenaming(null); }}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                          ) : <div style={{ fontWeight: 600, fontSize: 15 }}>{l.name}{active && <span className="note-faint"> · open</span>}</div>}
                          <div className="note">{requestLine(row, label)}</div>
                          <div className="note-faint">Edited {ago(l.updatedAt)}</div>
                        </td>
                        <td>
                          <div>{l.sessionName.trim() || l.saveName}</div>
                          <div className="mono note-faint" style={{ fontSize: 12 }}>build {row.plan?.save.buildVersion ?? '—'}</div>
                        </td>
                        <td>
                          <span className={`badge ${b.cls}`}>{b.text}</span>
                          <div className="note" style={{ marginTop: 4, maxWidth: '38ch' }}>{b.why}</div>
                          {row.errors.length > 0 && <ul className="mono note-faint" style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>{row.errors.slice(0, 3).map((e) => <li key={e}>{e}</li>)}</ul>}
                        </td>
                        <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {confirmDelete === l.id ? (
                            <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                              <span className="note">Delete this plan?</span>
                              <button type="button" className="btn btn-sm" style={{ borderColor: 'var(--bad-border)', color: '#ff9a8f' }} onClick={() => { setConfirmDelete(null); void deletePlan(l.id); }}>Delete</button>
                              <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(null)}>Keep</button>
                            </span>
                          ) : (
                            <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                              {!row.errors.length && <button type="button" className="btn btn-sm" onClick={() => void open(l.id)}>{stale ? 'Open to solve again' : 'Open'}</button>}
                              {!row.errors.length && <button type="button" className="btn btn-sm" onClick={() => void duplicatePlan(l.id)}>Duplicate</button>}
                              {!row.errors.length && <button type="button" className="btn btn-sm" onClick={() => setRenaming({ id: l.id, name: l.name })}>Rename</button>}
                              {!row.errors.length && <button type="button" className="btn btn-sm" onClick={() => void doExport([l.id])}>Export</button>}
                              <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(l.id)}>Delete</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows && rows.length > 0 && <p className="note-faint" style={{ padding: '10px 16px' }}>Deleting the last plan that uses a save summary removes that summary too. Exports include the save summary and result, so a plan opens on another computer without the .sav.</p>}
        </section>

        {report && (
          <aside aria-label="Import report" className="panel" style={{ flex: '1 1 320px', maxWidth: 420, minWidth: 0 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <h2 className="h2" style={{ flex: 1 }}>Imported</h2>
              <button type="button" className="btn-link" onClick={() => setReport(null)}>Dismiss</button>
            </div>
            <ul className="plain stack" style={{ marginTop: 10 }}>
              {report.imported.map((x) => (
                <li key={x.id} className="inset">
                  <div style={{ fontWeight: 600 }}>{x.name}</div>
                  <div className="note">{x.renamedFrom ? `Added beside your copy of “${x.renamedFrom}”, which you edited after this was exported.` : 'Added, or replaced an older copy.'}</div>
                </li>
              ))}
              {report.skipped > 0 && !report.warnings.some((w) => /skipped/i.test(w)) && <li className="inset note">{report.skipped} plan{report.skipped === 1 ? ' was' : 's were'} skipped: identical to what you already have.</li>}
              {report.warnings.map((w) => <li key={w}><Message tone={/unchanged; skipped/.test(w) ? 'info' : 'warn'}>{w}</Message></li>)}
              {report.imported.length === 0 && report.skipped === 0 && report.warnings.length === 0 && <li className="note">Nothing was imported.</li>}
            </ul>
            <p className="note-faint" style={{ marginTop: 10 }}>Everything in an import is checked before it’s kept. A save summary that doesn’t match its own contents is treated as a different save, so plans using it need solving again.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
