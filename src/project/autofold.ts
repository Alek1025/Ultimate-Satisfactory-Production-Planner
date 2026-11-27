// Folds pending journal entries into revisions after a quiet period (architecture: "after 30 s
// idle"). Main calls touch() after each journal() and flush() on save or quit.
import type { ProjectStore } from './store';

export const DEFAULT_IDLE_MS = 30_000;

export interface AutoFoldOptions {
  idleMs?: number;
  message?: string;
  onFold?: (folded: Record<string, string>) => void;
  /** A failed idle fold leaves the edits pending (they replay on next open); report it here. */
  onError?: (error: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class AutoFolder {
  private handle: unknown = null;
  private readonly idleMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly store: ProjectStore, private readonly opts: AutoFoldOptions = {}) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Restart the idle timer. Call after every journal write. */
  touch(): void {
    this.cancel();
    this.handle = this.setTimer(() => {
      this.handle = null;
      try {
        this.flush();
      } catch (e) {
        this.opts.onError?.(e);
      }
    }, this.idleMs);
  }

  /** Fold everything pending now ("save"). */
  flush(): Record<string, string> {
    this.cancel();
    const folded = this.store.foldAll(this.opts.message === undefined ? {} : { message: this.opts.message });
    if (Object.keys(folded).length > 0) this.opts.onFold?.(folded);
    return folded;
  }

  get scheduled(): boolean {
    return this.handle !== null;
  }

  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
  }
}
