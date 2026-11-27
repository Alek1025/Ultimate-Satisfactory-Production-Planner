/** Minimal single-consumer async queue: producers push, one `for await` drains. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;
  /** Called once when the consumer stops early (break/return) or the queue ends. */
  onClose: (() => void) | null = null;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: item, done: false }); }
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
  }

  get isEnded(): boolean { return this.ended; }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
      return: () => {
        this.items = [];
        this.end();
        const close = this.onClose;
        this.onClose = null;
        close?.();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
