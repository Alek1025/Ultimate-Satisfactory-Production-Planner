/**
 * Browser platform: IndexedDB storage (falls back to memory with a warning) and file
 * picker / download for files. The desktop (Tauri) platform implements the same
 * interfaces on the filesystem.
 */
import type { Platform } from '../types';
import { MemoryStore } from '../memory';
import { IndexedDbStore } from './indexeddb-store';
import { BrowserFileAccess } from './file-access';

export async function createBrowserPlatform(): Promise<{ platform: Platform; warnings: string[] }> {
  const warnings: string[] = [];
  let store: Platform['store'];
  try {
    store = await IndexedDbStore.open();
  } catch (e) {
    warnings.push(`Plans can't be saved in this browser (${(e as Error).message}). They will be lost on reload; export them to keep them.`);
    store = new MemoryStore();
  }
  return { platform: { kind: 'browser', files: new BrowserFileAccess(), store }, warnings };
}

export { IndexedDbStore, BrowserFileAccess };
