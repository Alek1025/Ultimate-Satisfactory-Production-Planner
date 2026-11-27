/**
 * Node catalog (CatalogPack): map data the save does not contain (each node's default resource
 * and purity, and which well core a satellite belongs to), keyed by the node's stable instance
 * name ("BP_ResourceNode620").
 *
 * The app bundles no catalog. The player supplies a pack file, which is pinned by its SHA-256:
 * a project records the hash and `readCatalogPack` rejects a file whose hash differs.
 *
 * The save provides identity, position and any Game Mode overrides; the catalog fills in the
 * rest. Without a catalog, nodes the save does not describe resolve with resource = null.
 */
import { decodeText } from '../util/text-decode';
import { sha256Hex } from '../util/hash';
import type { GameData, NodePurity } from './types';
import type { NodeKind, SaveSummary } from '../save/summary-types';

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

export type NodeCatalogErrorCode = 'invalid' | 'hash-mismatch';

export class NodeCatalogError extends Error {
  constructor(message: string, public readonly code: NodeCatalogErrorCode = 'invalid') {
    super(message);
    this.name = 'NodeCatalogError';
  }
}

const KINDS: ReadonlySet<string> = new Set<NodeKind>(['resource-node', 'well-satellite', 'well-core', 'geyser']);
const PURITIES: ReadonlySet<string> = new Set<NodePurity>(['impure', 'normal', 'pure']);

/** Validate a parsed pack. Treats the input as untrusted: unknown fields are ignored, bad ones rejected. */
export function parseNodeCatalog(json: unknown): NodeCatalog {
  const o = json as { source?: unknown; gameVersion?: unknown; entries?: unknown };
  if (!o || typeof o !== 'object' || typeof o.source !== 'string' || !Array.isArray(o.entries)) {
    throw new NodeCatalogError('Node catalog must be {source, gameVersion, entries: [...]}');
  }
  const entries = new Map<string, NodeCatalogEntry>();
  for (const raw of o.entries as unknown[]) {
    const e = raw as Record<string, unknown> | null;
    const bad = (why: string) => new NodeCatalogError(`Bad catalog entry (${why}): ${JSON.stringify(raw)?.slice(0, 200)}`);
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id) throw bad('id');
    if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) throw bad('kind');
    if (e.resource !== undefined && (typeof e.resource !== 'string' || !e.resource)) throw bad('resource');
    if (e.purity !== undefined && (typeof e.purity !== 'string' || !PURITIES.has(e.purity))) throw bad('purity');
    if (e.wellCore !== undefined && (typeof e.wellCore !== 'string' || !e.wellCore)) throw bad('wellCore');
    if (entries.has(e.id)) throw new NodeCatalogError(`Duplicate catalog entry ${e.id}`);
    entries.set(e.id, {
      id: e.id,
      kind: e.kind as NodeKind,
      ...(e.resource !== undefined ? { resource: e.resource as string } : {}),
      ...(e.purity !== undefined ? { purity: e.purity as NodePurity } : {}),
      ...(e.wellCore !== undefined ? { wellCore: e.wellCore as string } : {}),
    });
  }
  for (const e of entries.values()) {
    if (e.wellCore && entries.get(e.wellCore)?.kind !== 'well-core') {
      throw new NodeCatalogError(`Catalog entry ${e.id} points at well core ${e.wellCore}, which is not a well core in the catalog`);
    }
  }
  return { source: o.source, gameVersion: String(o.gameVersion ?? ''), entries };
}

export interface CatalogPack {
  catalog: NodeCatalog;
  /** SHA-256 of the file bytes as supplied. */
  sha256: string;
}

/**
 * Read a CatalogPack file. With `expectedSha256` (the hash a project pinned), a file whose
 * bytes differ is rejected with code 'hash-mismatch' before it is parsed.
 */
export function readCatalogPack(bytes: Uint8Array, options: { expectedSha256?: string } = {}): CatalogPack {
  const sha256 = sha256Hex(bytes);
  if (options.expectedSha256 !== undefined && options.expectedSha256.toLowerCase() !== sha256) {
    throw new NodeCatalogError(`CatalogPack hash mismatch: expected ${options.expectedSha256}, file is ${sha256}`, 'hash-mismatch');
  }
  let json: unknown;
  try { json = JSON.parse(decodeText(bytes).text); } catch (e) {
    throw new NodeCatalogError(`CatalogPack is not valid JSON: ${(e as Error).message}`);
  }
  return { catalog: parseNodeCatalog(json), sha256 };
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
