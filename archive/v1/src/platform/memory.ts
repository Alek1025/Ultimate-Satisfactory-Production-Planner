/**
 * In-memory KeyValueStore. Used by tests, and as the fallback when the browser has no
 * usable IndexedDB (e.g. some private-browsing modes); nothing survives a reload.
 * Values are structured-cloned on the way in and out, like IndexedDB.
 */
import type { KeyValueStore } from './types';

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.has(key) ? structuredClone(this.data.get(key)) as T : undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async keys(prefix = ''): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
