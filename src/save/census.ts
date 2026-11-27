/**
 * Class census of a parsed save: every class present, how many objects it has, and whether
 * the summary interprets it. Unknown classes are reported here rather than dropped, so later
 * layers can show them (and anything that depends on them) as N/A.
 */
import { INTERPRETED_CLASSES } from './extract';
import type { ParsedSave } from './save-reader';

export interface ClassCensusEntry {
  className: string;
  /** Full type path of the first object seen, e.g. "/Game/FactoryGame/.../Build_X.Build_X_C". */
  typePath: string;
  entities: number;
  components: number;
  /** Objects of this class whose property list could not be decoded (kept as raw records). */
  failed: number;
  /** Total serialized bytes kept for this class (sum of record lengths). */
  bytes: number;
  interpreted: boolean;
}

export function classCensus(save: ParsedSave, interpreted: ReadonlySet<string> = INTERPRETED_CLASSES): ClassCensusEntry[] {
  const out = new Map<string, ClassCensusEntry>();
  for (const level of save.levels) {
    for (const o of level.objects) {
      let e = out.get(o.className);
      if (!e) {
        e = { className: o.className, typePath: o.typePath, entities: 0, components: 0, failed: 0, bytes: 0, interpreted: interpreted.has(o.className) };
        out.set(o.className, e);
      }
      if (o.kind === 'entity') e.entities++; else e.components++;
      if (o.failed) e.failed++;
      e.bytes += o.record.byteLength;
    }
  }
  return [...out.values()].sort((a, b) => (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
}
