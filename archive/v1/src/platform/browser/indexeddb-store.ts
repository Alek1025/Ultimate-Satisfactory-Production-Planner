/**
 * Browser KeyValueStore on IndexedDB (one object store, string keys, structured-clone
 * values). Requests persistent storage so the browser doesn't evict plans under disk
 * pressure. Needs http(s)://, not file://, which is why the app is served locally.
 */
import type { KeyValueStore } from '../types';

const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbStore implements KeyValueStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'satisfactory-planner', factory: IDBFactory = globalThis.indexedDB): Promise<IndexedDbStore> {
    if (!factory) throw new Error('IndexedDB is not available in this browser.');
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('Could not open IndexedDB'));
      open.onblocked = () => reject(new Error('IndexedDB is blocked by another open tab of the planner; close it and reload.'));
    });
    return new IndexedDbStore(db);
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await req(this.tx('readonly').get(key))) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const t = this.db.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    await new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB write aborted (storage full?)'));
    });
  }

  async delete(key: string): Promise<void> {
    await req(this.tx('readwrite').delete(key));
  }

  async keys(prefix = ''): Promise<string[]> {
    // A few hundred keys at most; filtering avoids depending on a global IDBKeyRange.
    const keys = await req(this.tx('readonly').getAllKeys());
    return keys.map(String).filter((k) => k.startsWith(prefix)).sort();
  }

  async requestPersistence(): Promise<boolean> {
    const s = globalThis.navigator?.storage;
    if (!s?.persist) return false;
    return (await s.persisted?.()) || s.persist();
  }

  close(): void {
    this.db.close();
  }
}
