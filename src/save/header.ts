import { BinaryReader, SaveFormatError } from './binary-reader';

/** Save header versions we know about (FSaveHeader::Type). */
export const SaveHeaderType = {
  AddedSaveIdentifier: 11,
  AddedWorldPartitionSupport: 12,
  AddedSaveModificationChecksum: 13,
  AddedIsCreativeModeEnabled: 14,
} as const;

/** FSaveCustomVersion values the reader branches on. */
export const SaveVersion = {
  SaveFileIsCompressed: 21,
  UnrealEngine5: 37,
  IntroducedWorldPartition: 38,
  SerializeObjectFlags: 49,
  SerializePerStreamableLevelTOCVersion: 51,
  SerializeDataPackageVersionAndCustomVersions: 53,
} as const;

export interface SaveHeader {
  headerVersion: number;
  saveVersion: number;
  buildVersion: number;
  saveName: string;
  mapName: string;
  mapOptions: string;
  sessionName: string;
  playDurationSeconds: number;
  /** ISO timestamp of the save (from .NET ticks). */
  saveDateTime: string;
  sessionVisibility: number;
  editorObjectVersion: number;
  modMetadata: string;
  isModded: boolean;
  saveIdentifier: string;
  isPartitionedWorld: boolean;
  saveDataHash: string;
  isCreativeModeEnabled: boolean;
  /** Byte offset where the compressed body begins. */
  bodyOffset: number;
}

const TICKS_AT_UNIX_EPOCH = 621355968000000000n;

export function readSaveHeader(bytes: Uint8Array): SaveHeader {
  const r = new BinaryReader(bytes);
  const headerVersion = r.i32();
  const saveVersion = r.i32();
  const buildVersion = r.i32();
  if (headerVersion < SaveHeaderType.AddedIsCreativeModeEnabled) {
    throw new SaveFormatError(
      `Save header version ${headerVersion} is older than Satisfactory 1.0 and is not supported`,
      undefined, 'unsupported-version',
    );
  }
  const saveName = r.fstring();
  const mapName = r.fstring();
  const mapOptions = r.fstring();
  const sessionName = r.fstring();
  const playDurationSeconds = r.i32();
  const ticks = r.i64();
  const saveDateTime = new Date(Number((ticks - TICKS_AT_UNIX_EPOCH) / 10000n)).toISOString();
  const sessionVisibility = r.u8();
  const editorObjectVersion = r.i32();
  const modMetadata = r.fstring();
  const isModded = r.i32() !== 0;
  const saveIdentifier = r.fstring();
  const isPartitionedWorld = r.i32() !== 0;
  const saveDataHash = Array.from(r.bytesView(20), (b) => b.toString(16).padStart(2, '0')).join('');
  const isCreativeModeEnabled = r.i32() !== 0;
  if (saveVersion < SaveVersion.SerializeDataPackageVersionAndCustomVersions) {
    throw new SaveFormatError(`Save version ${saveVersion} predates Update 1.1 and is not supported`, undefined, 'unsupported-version');
  }
  return {
    headerVersion, saveVersion, buildVersion, saveName, mapName, mapOptions, sessionName,
    playDurationSeconds, saveDateTime, sessionVisibility, editorObjectVersion, modMetadata,
    isModded, saveIdentifier, isPartitionedWorld, saveDataHash, isCreativeModeEnabled,
    bodyOffset: r.pos,
  };
}

/** Parse "?key=value?flag" map options into a record (flags map to ""). */
export function parseMapOptions(options: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of options.split('?')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) out[part] = '';
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}
