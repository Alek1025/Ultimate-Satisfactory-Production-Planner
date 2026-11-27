/**
 * Browser FileAccess: <input type=file> to pick, a Blob download to export (or the
 * File System Access save dialog where the browser has it).
 */
import type { FileAccess, PickedFile } from '../types';

export class BrowserFileAccess implements FileAccess {
  constructor(private readonly doc: Document = document) {}

  pickFiles(options: { accept: string[]; multiple?: boolean }): Promise<PickedFile[]> {
    return new Promise((resolve) => {
      const input = this.doc.createElement('input');
      input.type = 'file';
      input.accept = options.accept.join(',');
      input.multiple = !!options.multiple;
      input.style.display = 'none';
      const done = (files: File[]) => { input.remove(); resolve(files.map(toPicked)); };
      input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
      input.addEventListener('cancel', () => done([]), { once: true });
      this.doc.body.appendChild(input);
      input.click();
    });
  }

  async exportFile(name: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const w = this.doc.defaultView as (Window & { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }) | null;
    if (w?.showSaveFilePicker) {
      try {
        const handle = await w.showSaveFilePicker({ suggestedName: name, types: [{ accept: { [mimeType]: ['.json'] } }] });
        const out = await handle.createWritable();
        await out.write(bytes as BlobPart);
        await out.close();
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return; // user cancelled
        // fall through to a plain download
      }
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    const a = this.doc.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    this.doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function toPicked(f: File): PickedFile {
  return { name: f.name, lastModified: f.lastModified, read: async () => new Uint8Array(await f.arrayBuffer()) };
}
