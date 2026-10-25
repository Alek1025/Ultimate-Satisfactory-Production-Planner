/**
 * Node catalog: map data the save does not contain (each node's resource and
 * default purity), keyed by the node's stable instance name ("BP_ResourceNode620").
 *
 * The save provides identity, position and purity overrides; the catalog fills
 * in the rest. Without a catalog, nodes resolve with resource = null.
 */
import type { GameData, NodePurity } from './types';
import type { NodeKind, SaveSummary } from '../save/summary-types';
import bundled12 from './data/node-catalog-1.2.json';

export interface NodeCatalogEntry {
  id: string;
  kind: NodeKind;
  /** Item ClassName, e.g. "Desc_OreIron_C". Geysers and well cores may omit it. */
  resource?: string;
  purity?: NodePurity;
  /** For well satellites: the id of the well core they belong to. */
  wellCore?: string;
}

export interface NodeCatalog {
  /** Where the data came from (shown to the user). */
  source: string;
  gameVersion: string;
  entries: Map<string, NodeCatalogEntry>;
}

export class NodeCatalogError extends Error {}

export function parseNodeCatalog(json: unknown): NodeCatalog {
  const o = json as { source?: unknown; gameVersion?: unknown; entries?: unknown };
  if (!o || typeof o !== 'object' || typeof o.source !== 'string' || !Array.isArray(o.entries)) {
    throw new NodeCatalogError('Node catalog must be {source, gameVersion, entries: [...]}');
  }
  const entries = new Map<string, NodeCatalogEntry>();
  for (const e of o.entries as NodeCatalogEntry[]) {
    if (!e || typeof e.id !== 'string' || typeof e.kind !== 'string') throw new NodeCatalogError(`Bad catalog entry: ${JSON.stringify(e)}`);
    if (entries.has(e.id)) throw new NodeCatalogError(`Duplicate catalog entry ${e.id}`);
    entries.set(e.id, e);
  }
  return { source: o.source, gameVersion: String(o.gameVersion ?? ''), entries };
}

/**
 * The bundled Update 1.2 map catalog (608 nodes + 17 well cores). Built by
 * scripts/build-node-catalog.ts and validated against the fixture saves.
 */
export function loadBundledNodeCatalog(): NodeCatalog {
  return parseNodeCatalog(bundled12);
}

export interface ResolvedNode {
  id: string;
  kind: NodeKind;
  position: [number, number, number];
  resource: string | null;
  purity: NodePurity | null;
  puritySource: 'save-override' | 'catalog' | 'unknown';
  resourceSource: 'save-override' | 'catalog' | 'unknown';
  wellCore?: string;
}

export interface NodeResolution {
  nodes: ResolvedNode[];
  /** resource -> purity -> count, extractable nodes only. */
  counts: Map<string, Record<NodePurity, number>>;
  /** Plain-language notes on values that came from the catalog rather than the save. */
  assumptions: string[];
  warnings: string[];
}

export function resolveNodes(summary: SaveSummary, gd: GameData, catalog?: NodeCatalog): NodeResolution {
  const warnings: string[] = [];
  const extractable = summary.nodes.filter((n) => n.kind === 'resource-node' || n.kind === 'well-satellite');
  const selfContained = extractable.every((n) => n.resourceOverride && n.purityOverride);
  if (!catalog && !selfContained) {
    warnings.push('No node catalog loaded: nodes without a resource/purity stored in the save are unknown, so raw-resource limits cannot be computed yet.');
  }
  const nodes: ResolvedNode[] = [];
  const counts = new Map<string, Record<NodePurity, number>>();
  let missing = 0;
  for (const n of summary.nodes) {
    const entry = catalog?.entries.get(n.id);
    if (catalog && !entry) missing++;
    if (entry && entry.kind !== n.kind) warnings.push(`Catalog says ${n.id} is a ${entry.kind}, save says ${n.kind}.`);
    const resource = n.resourceOverride ?? entry?.resource ?? null;
    if (resource && !gd.items.get(resource)?.isRawResource) warnings.push(`Catalog resource ${resource} for ${n.id} is not a raw resource in the game data.`);
    const purity = n.purityOverride ?? entry?.purity ?? null;
    const resolved: ResolvedNode = {
      id: n.id, kind: n.kind, position: n.position, resource, purity,
      puritySource: n.purityOverride ? 'save-override' : entry?.purity ? 'catalog' : 'unknown',
      resourceSource: n.resourceOverride ? 'save-override' : entry?.resource ? 'catalog' : 'unknown',
      ...(entry?.wellCore ? { wellCore: entry.wellCore } : {}),
    };
    nodes.push(resolved);
    if (resource && purity && (n.kind === 'resource-node' || n.kind === 'well-satellite')) {
      const c = counts.get(resource) ?? { impure: 0, normal: 0, pure: 0 };
      c[purity]++;
      counts.set(resource, c);
    }
  }
  const assumptions: string[] = [];
  const fromCatalog = (f: 'resourceSource' | 'puritySource') => nodes.filter((n) => (n.kind === 'resource-node' || n.kind === 'well-satellite') && n[f] === 'catalog').length;
  const resCat = fromCatalog('resourceSource'), purCat = fromCatalog('puritySource');
  if (catalog && (resCat || purCat)) {
    assumptions.push(`Not stored in the save, so taken from the map defaults (${catalog.source}): resource type for ${resCat} node(s), purity for ${purCat} node(s).`);
  }
  if (catalog) {
    if (missing) warnings.push(`${missing} save node(s) are missing from the node catalog (${catalog.source}).`);
    const inSave = new Set(summary.nodes.map((n) => n.id));
    const extra = [...catalog.entries.keys()].filter((id) => !inSave.has(id));
    if (extra.length) warnings.push(`${extra.length} catalog node(s) do not exist in this save (e.g. ${extra.slice(0, 3).join(', ')}).`);
  }
  return { nodes, counts, assumptions, warnings };
}
