/** Small shared pieces: icons, messages, formatting. */
import type { ReactNode } from 'react';

export const Icon = {
  logo: () => (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2 L25 8 V20 L14 26 L3 20 V8 Z" fill="none" stroke="#F59A3E" strokeWidth="2" /><path d="M9 11 H19 M9 14 H16 M9 17 H19" stroke="#ECE7DE" strokeWidth="2" /></svg>
  ),
  plus: () => <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2 V12 M2 7 H12" stroke="currentColor" strokeWidth="1.6" /></svg>,
  x: () => <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor" strokeWidth="1.6" /></svg>,
  up: () => <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 7 L6 2 L11 7" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>,
  down: () => <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1 L6 6 L11 1" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>,
  play: () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2 L13 8 L4 14 Z" fill="currentColor" /></svg>,
  check: () => <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7.5 L5.5 11 L12 3.5" fill="none" stroke="#8EC5F5" strokeWidth="1.8" /></svg>,
  upload: () => <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 21 V6 M10 12 L16 6 L22 12 M6 20 V26 H26 V20" fill="none" stroke="#A3A9B0" strokeWidth="2" /></svg>,
  warn: () => <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2 L21 19 H1 Z" fill="none" stroke="#F2CC5B" strokeWidth="1.8" /><path d="M11 8 V13 M11 15.5 V16.5" stroke="#F2CC5B" strokeWidth="1.8" /></svg>,
  bad: () => <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="#FF8A7A" strokeWidth="1.8" /><path d="M7.5 7.5 L14.5 14.5 M14.5 7.5 L7.5 14.5" stroke="#FF8A7A" strokeWidth="1.8" /></svg>,
  info: () => <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="#8EC5F5" strokeWidth="1.5" /><path d="M8 7 V11.5 M8 4.5 V5.5" stroke="#8EC5F5" strokeWidth="1.5" /></svg>,
  ok: () => <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="9" fill="none" stroke="#8EC5F5" strokeWidth="1.8" /><path d="M6.5 11.5 L9.5 14.5 L15.5 7.5" fill="none" stroke="#8EC5F5" strokeWidth="1.8" /></svg>,
  lock: () => <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="3" y="8" width="12" height="8" fill="none" stroke="#FF8A7A" strokeWidth="1.6" /><path d="M6 8 V5.5 A3 3 0 0 1 12 5.5 V8" fill="none" stroke="#FF8A7A" strokeWidth="1.6" /></svg>,
  grip: () => <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">{[3, 8, 13].flatMap((y) => [3, 7].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.3" fill="#8A9098" />))}</svg>,
  panel: () => <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><rect x="1" y="1" width="14" height="12" fill="none" stroke="#A3A9B0" strokeWidth="1.5" /><path d="M6 1 V13" stroke="#A3A9B0" strokeWidth="1.5" /></svg>,
};

export function Message({ tone, title, children, action, details, role }: {
  tone: 'warn' | 'bad' | 'info' | 'ok'; title?: ReactNode; children?: ReactNode; action?: ReactNode; details?: string; role?: 'alert' | 'status';
}) {
  const icon = tone === 'warn' ? <Icon.warn /> : tone === 'bad' ? <Icon.bad /> : tone === 'ok' ? <Icon.ok /> : <Icon.info />;
  return (
    <div className={`msg msg-${tone}`} role={role ?? (tone === 'bad' ? 'alert' : 'status')}>
      {icon}
      <div className="stack" style={{ flex: 1, minWidth: 0, gap: 6 }}>
        {title && <div className="msg-title">{title}</div>}
        {children && <div className="msg-body">{children}</div>}
        {details && (
          <details className="tech">
            <summary>Technical details</summary>
            <code className="block">{details}</code>
          </details>
        )}
      </div>
      {action && <div style={{ alignSelf: 'center' }}>{action}</div>}
    </div>
  );
}

export function abbr(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words.map((w) => w[0]).join('').slice(0, 3).toUpperCase();
}

/** Rates: up to 2 decimals, thousands separators, trailing zeros trimmed. */
export function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return r.toLocaleString('en-US', { maximumFractionDigits: digits });
}
export const pct = (f: number) => `${num(f * 100, 1)}%`;
export function mw(n: number): string {
  return n >= 1000 ? `${num(n / 1000, 2)} GW` : `${num(n, 1)} MW`;
}
export function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
