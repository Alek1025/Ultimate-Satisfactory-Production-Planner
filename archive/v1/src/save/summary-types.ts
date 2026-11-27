import type { ItemAmount, NodePurity } from '../gamedata/types';

/** A value read from the save, or the engine default because the save omits it. */
export interface Setting<T> {
  value: T;
  /** 'save' = present in the file; 'default' = absent (Unreal omits default-valued properties). */
  source: 'save' | 'default';
  raw?: unknown;
}

export type NodePuritySetting = 'default' | 'all-pure' | 'random' | 'unknown';

export interface Holdings {
  total: number;
  /** Player inventories, containers, Dimensional Depot, crates. */
  stored: number;
  /** Slotted into buildings (production-boost / overclock slots). Movable, since plans start from scratch. */
  inBuildings: number;
}

export type NodeKind = 'resource-node' | 'well-satellite' | 'well-core' | 'geyser';

export interface SaveNode {
  /** Stable map instance name, e.g. "BP_ResourceNode620". Key for the node catalog. */
  id: string;
  kind: NodeKind;
  position: [number, number, number];
  /** Present only when the save overrides map purity (Game Mode node purity settings). */
  purityOverride?: NodePurity;
  /** Item ClassName. Present only when Game Mode node randomization reassigned the resource. */
  resourceOverride?: string;
  /** -1 = infinite. Absent = default (infinite). */
  resourcesLeft?: number;
}

export interface VersionCheck {
  status: 'supported' | 'warning';
  gameVersion: string;
  message?: string;
}

export interface SaveSummary {
  schemaVersion: 1;
  source: {
    saveName: string;
    sessionName: string;
    headerVersion: number;
    saveVersion: number;
    buildVersion: number;
    engine: string;
    branch: string;
    savedAt: string;
    playDurationSeconds: number;
    saveIdentifier: string;
    isModded: boolean;
    creativeMode: boolean;
  };
  version: VersionCheck;
  gameMode: {
    /** Multiplier on milestone / MAM / shop schematic costs. */
    partsCostMultiplier: Setting<number>;
    /** Multiplier on Space Elevator (Project Assembly) phase costs. */
    spacePartsCostMultiplier: Setting<number>;
    nodePurity: Setting<NodePuritySetting>;
    /** Node resource randomization mode: 'off' (absent), 'strict', 'advanced-rich', … (from ENodeRandomizationMode). */
    nodeRandomization: Setting<string>;
    nodeRandomizationSeed: Setting<number | null>;
    /** Game-State properties that look like Game Mode settings but are not interpreted yet. */
    unrecognized: Record<string, unknown>;
  };
  progression: {
    highestMilestoneTier: number;
    milestones: string[];
    activeMilestone?: string;
    phase: { current?: string; currentIndex?: number; target?: string; targetPaidOff: ItemAmount[] };
    mamResearch: string[];
    alternateSchematics: string[];
    awesomeShopSchematics: string[];
    otherSchematics: string[];
    /** From the Recipe Manager: the authoritative unlocked-recipe list. */
    unlockedRecipes: string[];
    /** Unlocked production recipes that are alternates. */
    unlockedAlternateRecipes: string[];
    overclockUnlocked: boolean;
    productionBoostUnlocked: boolean;
  };
  holdings: {
    somersloops: Holdings;
    powerShards: Holdings;
    powerSlugs: { blue: number; yellow: number; purple: number; shardEquivalent: number };
  };
  nodes: SaveNode[];
  /** Plain-language notes on values the reader had to assume. */
  assumptions: string[];
  warnings: string[];
  parseStats: { objects: number; failedObjects: number; rawProperties: number };
}
