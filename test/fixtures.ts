import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readDocsFile, parseGameData } from '../src/gamedata/docs-parser';
import type { GameData } from '../src/gamedata/types';

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));

/** True when every named fixture file is present (some are kept outside the archive). */
export const hasFixture = (...names: string[]): boolean =>
  names.every((n) => existsSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url))));

let cached: GameData | undefined;
export function gameData(): GameData {
  cached ??= parseGameData(readDocsFile(fixture('en-US.json')));
  return cached;
}

/**
 * Expected values per save. Object/recipe/schematic counts and Game Mode values were
 * cross-checked against an independent parser (@etothepii/satisfactory-file-parser 4.1.2).
 */
export const SAVES = {
  'all-pure-nodes.sav': {
    sessionName: 'All Pure Nodes', buildVersion: 513885, objects: 8658,
    purchasedSchematics: 440, unlockedRecipes: 804,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'all-pure', seed: 114343741,
    tier: 4, milestones: 17, mam: 110, alternates: 109,
    somersloops: { total: 106, stored: 106, inBuildings: 0 },
    shards: { total: 5306, stored: 5194, inBuildings: 112 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    overclock: true, boost: true, pureOverrides: 577, phase: 1, randomization: 'off', resourceOverrides: 0,
  },
  'max-milestone-multiplier.sav': {
    sessionName: '1.2 Max Milestone Multiplier ', buildVersion: 495413, objects: 18797,
    purchasedSchematics: 98, unlockedRecipes: 177,
    partsCost: { value: 2, source: 'save' }, spaceCost: { value: 100, source: 'save' },
    purity: 'default', seed: null,
    tier: 4, milestones: 17, mam: 53, alternates: 5,
    somersloops: { total: 106, stored: 105, inBuildings: 1 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 50, yellow: 12, purple: 11, shardEquivalent: 129 },
    overclock: true, boost: true, pureOverrides: 0, phase: 1, randomization: 'off', resourceOverrides: 0,
  },
  'obsidian-gears.sav': {
    sessionName: "Obsidian Gears xVx_K00L_S1D's_KluB_xVx", buildVersion: 513885, objects: 11897,
    purchasedSchematics: 69, unlockedRecipes: 131,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: null,
    tier: 3, milestones: 12, mam: 44, alternates: 0,
    somersloops: { total: 5, stored: 5, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 35, yellow: 15, purple: 3, shardEquivalent: 80 },
    overclock: true, boost: false, pureOverrides: 0, phase: 1, randomization: 'off', resourceOverrides: 0,
  },
  'random-nodes.sav': {
    sessionName: 'Test Random Nodes', buildVersion: 513885, objects: 1326,
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: 1998474106,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Strict randomization stores a resource on every node, but purity only on well satellites.
    overclock: false, boost: false, pureOverrides: 66, phase: 0, randomization: 'strict', resourceOverrides: 594,
  },
  'default.sav': {
    sessionName: '1.2 Default', buildVersion: 513885, objects: 1140,
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'default', seed: null,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Default Game Mode: the save stores no node resource or purity at all (map defaults apply).
    overclock: false, boost: false, pureOverrides: 0, phase: 0, randomization: 'off', resourceOverrides: 0,
  },
  'resource-rich-random-purity.sav': {
    sessionName: '1.2 advanced resource rich + random purity', buildVersion: 513885, objects: 1252,
    purchasedSchematics: 7, unlockedRecipes: 26,
    partsCost: { value: 1, source: 'default' }, spaceCost: { value: 1, source: 'default' },
    purity: 'random', seed: 1767073982,
    tier: 0, milestones: 0, mam: 0, alternates: 0,
    somersloops: { total: 0, stored: 0, inBuildings: 0 },
    shards: { total: 0, stored: 0, inBuildings: 0 },
    slugs: { blue: 0, yellow: 0, purple: 0, shardEquivalent: 0 },
    // Both randomizers on: every node stores resource and purity, so no catalog is needed.
    overclock: false, boost: false, pureOverrides: 208, phase: 0, randomization: 'advanced-rich', resourceOverrides: 594,
  },
} as const;

/** The fixture saves present in this checkout; tests over "every save" use these. */
export const PRESENT_SAVES = Object.fromEntries(Object.entries(SAVES).filter(([f]) => hasFixture(f))) as Partial<typeof SAVES>;
