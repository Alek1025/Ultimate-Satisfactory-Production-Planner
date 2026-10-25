/** Searchable item picker dialog. Searches display names; returns ClassNames. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, abbr } from '../ui/kit';

export interface PickerEntry { id: string; name: string; note?: string; disabled?: boolean }

export function Picker({ title, entries, onPick, onClose, emptyNote }: {
  title: string; entries: PickerEntry[]; onPick: (id: string) => void; onClose: () => void; emptyNote: string;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return entries.filter((e) => !s || e.name.toLowerCase().includes(s)).slice(0, 200);
  }, [entries, q]);
  const choose = (e?: PickerEntry) => { if (e && !e.disabled) onPick(e.id); };

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); choose(list[active]); }
        }}>
        <div className="row" style={{ padding: '14px 16px 10px', flexWrap: 'nowrap' }}>
          <h2 id="picker-title" className="h2-lg" style={{ flex: 1 }}>{title}</h2>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon.x /></button>
        </div>
        <div style={{ padding: '0 16px 10px' }}>
          <label htmlFor="picker-search" className="note" style={{ display: 'block', marginBottom: 6 }}>Search items</label>
          <input id="picker-search" ref={input} type="search" className="input" style={{ width: '100%', minHeight: 44 }} value={q}
            placeholder="e.g. rotor" onChange={(e) => { setQ(e.target.value); setActive(0); }} />
        </div>
        <div className="dialog-list" role="listbox" aria-label="Items">
          {list.map((e, i) => (
            <button key={e.id} type="button" role="option" aria-selected={i === active} className={`pick${i === active ? ' active' : ''}`}
              disabled={e.disabled} onMouseEnter={() => setActive(i)} onClick={() => choose(e)}>
              <span className="item-tile" aria-hidden="true">{abbr(e.name)}</span>
              <span style={{ flex: 1 }}>{e.name}</span>
              {e.note && <span className="note-faint">{e.note}</span>}
            </button>
          ))}
          {list.length === 0 && <p className="note" style={{ margin: 8 }}>{emptyNote}</p>}
        </div>
      </div>
    </div>
  );
}
