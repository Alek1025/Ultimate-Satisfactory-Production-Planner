/**
 * Golden fixtures: the files in `fixtures/` (gitignored, listed in fixtures/README.md).
 *
 * Missing fixtures FAIL tests; they are never skipped. `fixture()` throws when a file is absent,
 * so there is deliberately no `hasFixture`/`skipIf` helper. `test/fixtures.test.ts` also checks
 * every file against the SHA-256 pinned below, so a wrong copy fails loudly.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readDocsFile, parseGameData } from '../src/gamedata/docs-parser';
import { readCatalogPack, type NodeCatalog } from '../src/gamedata/node-catalog';
import { readSave, type ParsedSave } from '../src/save/save-reader';
import { summarizeSave } from '../src/save/extract';
import type { GameData } from '../src/gamedata/types';
import type { SaveSummary } from '../src/save/summary-types';

/** File name -> SHA-256 of the expected bytes. */
export const FIXTURE_SHA256 = {
  'en-US.json': '9c651f6840a11743df0aaa2f47f1005487abe8f3a93fa299c5092882bb4a76e3',
  'da.json': '62dfa09c61011a838ae83faf4cb223ca45b8e5728cfb1fc14b5831e14bb0eb0a',
  'he.json': '48bd523d9407d982f8112e1575a3118a739ace35b3a92a4215194cf61cca99c3',
  'all-pure-nodes.sav': 'f4e2d42e8de658409622f350c920e3a2c3adb49b407201b4460cf54fea28b7de',
  'obsidian-gears.sav': 'd8d3b83465785b0b4be376d8bbbc1ad461d8c44a9408dfa1d8f57c5685ad1060',
  'max-milestone-multiplier.sav': 'baba8a7135f036b80d9f681c5ad155f6552efd5460e619bc14cd21182be0971a',
  'random-nodes.sav': '877b9a7f78063bbd39b9b340c5c3bc2770d66d801e27fc0225795980977157a9',
  'default.sav': 'ced91ef574c3a66c2f4d3c7ca6c88298b970a96b22ab2d4590652a33da307818',
  'resource-rich-random-purity.sav': 'c9b2a7a9cd3d303d823ab477858d7a8d5cfc74408cd414a34429ea0271b08869',
  'node-catalog-1.2.json': 'f6a450f8cb3cf3952554955bd72b24fa2fc011da245874da0a8c44300de0c5fe',
} as const;

export type FixtureName = keyof typeof FIXTURE_SHA256;

export class MissingFixtureError extends Error {
  constructor(name: string) {
    super(`Missing fixture fixtures/${name}. Copy it as described in fixtures/README.md; fixture tests never skip.`);
    this.name = 'MissingFixtureError';
  }
}

export const fixturePath = (name: FixtureName): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const bytesCache = new Map<string, Uint8Array>();
/** Bytes of a fixture file. Throws MissingFixtureError when it is absent. */
export function fixture(name: FixtureName): Uint8Array {
  let b = bytesCache.get(name);
  if (!b) {
    const path = fixturePath(name);
    if (!existsSync(path)) throw new MissingFixtureError(name);
    b = new Uint8Array(readFileSync(path));
    bytesCache.set(name, b);
  }
  return b;
}

let gd: GameData | undefined;
/** Game data parsed from fixtures/en-US.json (cached). */
export function gameData(): GameData {
  gd ??= parseGameData(readDocsFile(fixture('en-US.json')));
  return gd;
}

let catalog: NodeCatalog | undefined;
/** The Update 1.2 CatalogPack fixture, read through the hash-pinned loader (cached). */
export function nodeCatalog(): NodeCatalog {
  catalog ??= readCatalogPack(fixture('node-catalog-1.2.json'), { expectedSha256: FIXTURE_SHA256['node-catalog-1.2.json'] }).catalog;
  return catalog;
}

const parsedCache = new Map<string, ParsedSave>();
/** A fixture save parsed with `readSave` (cached; treat as read-only). */
export function parsedSave(name: SaveFile): ParsedSave {
  let p = parsedCache.get(name);
  if (!p) { p = readSave(fixture(name)); parsedCache.set(name, p); }
  return p;
}

const summaryCache = new Map<string, SaveSummary>();
/** A fixture save's SaveSummary against `gameData()` (cached; treat as read-only). */
export function saveSummary(name: SaveFile): SaveSummary {
  let s = summaryCache.get(name);
  if (!s) { s = summarizeSave(parsedSave(name), gameData()); summaryCache.set(name, s); }
  return s;
}

/**
 * Expected values per save. Object/recipe/schematic counts and Game Mode values were
 * cross-checked against an independent parser (@etothepii/satisfactory-file-parser 4.1.2).
 * `savedAt` is the header's .NET ticks as UTC (the file names carry local time, UTC-5).
 * `resourceOverrides`/`purityOverrides` are the "Resources stored"/"Purities stored" columns of
 * rewrite-notes §2.
 */
export const SAVES = {
  'all-pure-nodes.sav': {
    sessionName: 'All Pure Nodes', buildVersion: 513885, objects: 8658, levels: 509,
    savedAt: '2026-10-18T22:32:20.480Z',
    purchasedSchematics: 440, unlockedRecipes: 804,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'all-pure', seed: 114343741,
    tier: 4, milestones: 17, mam: 110, alternates: 109,
    somersloops: { total: 106, stored: 106, inBuildings: 0 },
    shards: { total: 5306, stored: 5194, inBuildings: 112 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    overclock: true, boost: true, pureOverrides: 577, phase: 1, randomization: 'off',
    resourceOverrides: 0, purityOverrides: 577, persistentRefs: 0,
  },
  'max-milestone-multiplier.sav': {
    sessionName: '1.2 Max Milestone Multiplier ', buildVersion: 495413, objects: 18797, levels: 3760,
    savedAt: '2026-06-30T16:03:35.417Z',
    purchasedSchematics: 98, unlockedRecipes: 177,
    partsCost: { value: 2, source: 'save' }, spaceCost: { value: 100, source: 'save' },
    purity: 'default', seed: null,
    tier: 4, milestones: 17, mam: 53, alternates: 5,
    somersloops: { total: 106, stored: 105, inBuildings: 1 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 50, yellow: 12, purple: 11, shardEquivalent: 129 },
    overclock: true, boost: true, pureOverrides: 0, phase: 1, randomization: 'off',
    resourceOverrides: 0, purityOverrides: 0, persistentRefs: 0,
  },
  'obsidian-gears.sav': {
    sessionName: "Obsidian Gears xVx_K00L_S1D's_KluB_xVx", buildVersion: 513885, objects: 11897, levels: 1914,
    savedAt: '2026-10-22T02:27:31.508Z',
    purchasedSchematics: 69, unlockedRecipes: 131,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: null,
    tier: 3, milestones: 12, mam: 44, alternates: 0,
    somersloops: { total: 5, stored: 5, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 35, yellow: 15, purple: 3, shardEquivalent: 80 },
    overclock: true, boost: false, pureOverrides: 0, phase: 1, randomization: 'off',
    resourceOverrides: 0, purityOverrides: 0, persistentRefs: 13,
  },
  'random-nodes.sav': {
    sessionName: 'Test Random Nodes', buildVersion: 513885, objects: 1326, levels: 220,
    savedAt: '2026-10-24T16:05:20.458Z',
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: 1998474106,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Strict randomization stores a resource on every node, but purity only on well satellites.
    overclock: false, boost: false, pureOverrides: 66, phase: 0, randomization: 'strict',
    resourceOverrides: 594, purityOverrides: 118, persistentRefs: 0,
  },
  'default.sav': {
    sessionName: '1.2 Default', buildVersion: 513885, objects: 1140, levels: 184,
    savedAt: '2026-10-24T16:10:33.544Z',
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: null,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Default Game Mode: the save stores no node resource or purity at all (map defaults apply).
    overclock: false, boost: false, pureOverrides: 0, phase: 0, randomization: 'off',
    resourceOverrides: 0, purityOverrides: 0, persistentRefs: 0,
  },
  'resource-rich-random-purity.sav': {
    sessionName: '1.2 advanced resource rich + random purity', buildVersion: 513885, objects: 1252, levels: 210,
    savedAt: '2026-10-24T16:12:51.147Z',
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'random', seed: 1767073982,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Both randomizers on: every node stores resource and purity, so no catalog is needed.
    overclock: false, boost: false, pureOverrides: 208, phase: 0, randomization: 'advanced-rich',
    resourceOverrides: 594, purityOverrides: 577, persistentRefs: 0,
  },
} as const;

export type SaveFile = keyof typeof SAVES;
export const SAVE_FILES = Object.keys(SAVES) as SaveFile[];
