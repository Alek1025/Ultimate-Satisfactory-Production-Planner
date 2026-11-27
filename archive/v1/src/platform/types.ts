/**
 * Platform boundary. Parsers and the solver only ever see bytes and plain
 * objects; anything that touches files or storage goes through these
 * interfaces, implemented once for the browser (file picker + IndexedDB) and
 * once for the Tauri desktop app (filesystem). No other module may assume
 * which platform it runs on.
 */

export interface PickedFile {
  name: string;
  /** Platform path when known (desktop); undefined in the browser. */
  path?: string;
  lastModified?: number;
  read(): Promise<Uint8Array>;
}

export interface FileAccess {
  /** Let the user choose files. `accept` is a list of extensions like ".sav". */
  pickFiles(options: { accept: string[]; multiple?: boolean; purpose: 'save' | 'game-data' | 'plan-import' }): Promise<PickedFile[]>;
  /** Desktop only: candidate save files from the default save folder. */
  findSaveFiles?(): Promise<PickedFile[]>;
  /** Desktop only: Docs.json / <locale>.json files from the detected game install. */
  findGameDataFiles?(): Promise<PickedFile[]>;
  /** Offer bytes to the user as a downloadable / saved file. */
  exportFile(name: string, bytes: Uint8Array, mimeType: string): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** Ask the platform to keep data (navigator.storage.persist in browsers). */
  requestPersistence?(): Promise<boolean>;
}

export interface Platform {
  kind: 'browser' | 'desktop';
  files: FileAccess;
  store: KeyValueStore;
}
