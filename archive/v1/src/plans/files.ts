/**
 * Plan export/import through the platform's FileAccess (download / file picker in the
 * browser, save dialog / filesystem on desktop). Same JSON on both platforms.
 */
import type { FileAccess } from '../platform/types';
import { decodeText } from '../util/text-decode';
import type { ImportReport, PlanStore } from './store';
import { PlanImportError } from './store';
import type { PlanBundle } from './types';

export const PLAN_FILE_MIME = 'application/json';
export const PLAN_FILE_EXTENSION = '.satplan.json';

export function bundleToBytes(bundle: PlanBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle, null, 1));
}

export function bytesToJson(bytes: Uint8Array): unknown {
  const { text } = decodeText(bytes);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PlanImportError(`The file is not valid JSON (${(e as Error).message}).`);
  }
}

export function exportFileName(bundle: PlanBundle): string {
  const base = bundle.plans.length === 1 ? bundle.plans[0]!.name : `satisfactory-plans-${bundle.exportedAt.slice(0, 10)}`;
  const safe = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'plans';
  return `${safe}${PLAN_FILE_EXTENSION}`;
}

export async function exportPlansToFile(
  files: FileAccess, store: PlanStore, ids?: string[], opts?: { includeSummaries?: boolean; includeResults?: boolean },
): Promise<{ fileName: string; plans: number }> {
  const bundle = await store.exportBundle(ids, opts);
  const fileName = exportFileName(bundle);
  await files.exportFile(fileName, bundleToBytes(bundle), PLAN_FILE_MIME);
  return { fileName, plans: bundle.plans.length };
}

/** Pick one or more plan files and import them; one bad file doesn't stop the others. */
export async function importPlansFromFiles(files: FileAccess, store: PlanStore): Promise<ImportReport> {
  const picked = await files.pickFiles({ accept: ['.json'], multiple: true, purpose: 'plan-import' });
  const total: ImportReport = { imported: [], skipped: 0, warnings: [] };
  for (const f of picked) {
    try {
      const r = await store.importBundle(bytesToJson(await f.read()));
      total.imported.push(...r.imported);
      total.skipped += r.skipped;
      total.warnings.push(...r.warnings.map((w) => (picked.length > 1 ? `${f.name}: ${w}` : w)));
    } catch (e) {
      total.warnings.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  return total;
}
