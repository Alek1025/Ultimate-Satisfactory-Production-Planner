/** Promise wrapper around the engine worker. One request runs at a time per type. */
import type { EngineError, EngineRequest, EngineResponse, WorkerMessage } from './protocol';

type Progress = (stage: string, fraction?: number) => void;
type Pending = { resolve: (r: EngineResponse) => void; reject: (e: EngineError) => void; onProgress?: Progress };

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === 'progress') { p.onProgress?.(m.stage, m.fraction); return; }
      this.pending.delete(m.id);
      if (m.kind === 'ok') p.resolve(m.response); else p.reject(m.error);
    };
    this.worker.onerror = (ev) => {
      const error: EngineError = { kind: 'solver', message: 'The planner engine couldn’t start', detail: ev.message || 'Worker failed to load' };
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  request<T extends EngineResponse['type']>(req: EngineRequest, onProgress?: Progress): Promise<Extract<EngineResponse, { type: T }>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: EngineResponse) => void, reject, onProgress });
      // Copy bytes so the caller's buffer stays usable (they may also be persisted).
      this.worker.postMessage({ id, req });
    });
  }
}
