/**
 * Satisfactory save reader (1.1 / 1.2 format: header v14, save version >= 53).
 * Produces a generic object graph; game-specific interpretation lives in
 * `extract.ts`.
 *
 * Nothing is dropped: every object keeps its serialized data entry byte-for-byte
 * (`record`), including classes the planner does not interpret and objects whose
 * properties fail to decode. Concatenating a level's records after its object count
 * reproduces the level's data blob exactly.
 */
import { BinaryReader, SaveFormatError } from './binary-reader';
import { inflateSaveBody } from './decompress';
import { readSaveHeader, SaveHeader, SaveVersion } from './header';
import {
  newStats, ObjectRef, ParseStats, PropertyBag, PropertyContext, readObjectRef, readPropertyList,
} from './properties';

/** UE5 object version at which property tags carry complete type names. */
const UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME = 1012;
const SAVE_VERSION_64BIT_ARCHIVE = 41;

export interface EngineVersionData {
  objectVersionDataVersion: number;
  ue4Version: number;
  ue5Version: number;
  licenseeVersion: number;
  engine: { major: number; minor: number; patch: number; changelist: number; branch: string };
  customVersions: Array<{ guid: string; version: number }>;
}

export interface SaveObject {
  kind: 'entity' | 'component';
  typePath: string;
  /** Class name, e.g. "BP_ResourceNode_C" (last segment of typePath). */
  className: string;
  rootObject: string;
  instanceName: string;
  flags: number;
  /** Entities only. */
  transform?: { rotation: number[]; translation: number[]; scale: number[] };
  wasPlacedInLevel?: boolean;
  /** Components only: owning entity instance name. */
  parentEntityName?: string;
  /** Entities only: owner reference and component references. */
  parent?: ObjectRef;
  components?: ObjectRef[];
  properties: PropertyBag;
  /** Number of bytes after the property list (class-specific native data). */
  trailingBytes: number;
  /** The bytes after the property list, kept unparsed (empty when properties were skipped or failed). */
  trailing: Uint8Array;
  /**
   * The object's whole entry in the level data blob, byte-for-byte: save version, migrate flag,
   * size, payload and optional per-object version data. A view into the inflated body.
   */
  record: Uint8Array;
  /** True when the property list itself could not be decoded. */
  failed?: string;
  level: string;
}

export interface SaveLevel {
  name: string;
  objects: SaveObject[];
  /** Actors placed in the level but destroyed/collected (non-persistent levels). */
  collectables: ObjectRef[];
  /** The level's TOC and data blobs as stored (views into the inflated body). */
  raw: { toc: Uint8Array; data: Uint8Array };
}

export interface ParsedSave {
  header: SaveHeader;
  versionData: EngineVersionData;
  levels: SaveLevel[];
  /** Persistent level: level name -> destroyed actor references. */
  destroyedActors: Map<string, ObjectRef[]>;
  /**
   * The ref list the game writes after the destroyed-actor map (meaning not established; seen
   * holding Mercer Shrines in streamed levels). Kept, not interpreted.
   */
  persistentRefs: ObjectRef[];
  stats: ParseStats & { objects: number; failedObjects: number };
  /**
   * 'game': written by the game. 'persistent-toc-version': the persistent level ends with an
   * i32 TOC version and keeps destroyed actors in its TOC blob (third-party save editors).
   */
  layout: SaveLayout;
}

export type SaveLayout = 'game' | 'persistent-toc-version';

export interface ReadSaveOptions {
  /** Return false to skip decoding properties for an object (faster). Header data is always kept. */
  wantProperties?: (className: string) => boolean;
  onProgress?: (fraction: number, message: string) => void;
}

function readVersionData(r: BinaryReader): EngineVersionData {
  const objectVersionDataVersion = r.u32();
  const ue4Version = r.i32();
  const ue5Version = r.i32();
  const licenseeVersion = r.i32();
  const major = r.u16(), minor = r.u16(), patch = r.u16();
  const changelist = r.u32() & 0x7fffffff; // high bit = licensee changelist flag
  const branch = r.fstring();
  const n = r.i32();
  const customVersions: Array<{ guid: string; version: number }> = [];
  for (let i = 0; i < n; i++) customVersions.push({ guid: r.guid(), version: r.i32() });
  return {
    objectVersionDataVersion, ue4Version, ue5Version, licenseeVersion,
    engine: { major, minor, patch, changelist, branch }, customVersions,
  };
}

function readRefList(r: BinaryReader): ObjectRef[] {
  const n = r.i32();
  const out: ObjectRef[] = [];
  for (let i = 0; i < n; i++) out.push(readObjectRef(r));
  return out;
}

/**
 * `lenient` is for the copy kept at the end of a TOC blob: third-party editors leave out the
 * count of an empty last list there, so a key that ends the blob gets an empty list.
 */
function readDestroyedActorsMap(r: BinaryReader, lenient = false): Map<string, ObjectRef[]> {
  const n = r.i32();
  const map = new Map<string, ObjectRef[]>();
  for (let i = 0; i < n; i++) {
    const key = r.fstring();
    if (lenient && i === n - 1 && r.remaining === 0) { map.set(key, []); break; }
    map.set(key, readRefList(r));
  }
  return map;
}

const EMPTY = new Uint8Array(0);

function classNameOf(typePath: string): string {
  const dot = typePath.lastIndexOf('.');
  return dot >= 0 ? typePath.slice(dot + 1) : typePath;
}

export function readSave(fileBytes: Uint8Array, options: ReadSaveOptions = {}): ParsedSave {
  const header = readSaveHeader(fileBytes);
  options.onProgress?.(0, 'Decompressing');
  const body = inflateSaveBody(fileBytes, header.bodyOffset);
  const r = new BinaryReader(body);

  const declared = r.i64n();
  if (declared + 8 !== body.byteLength) {
    throw new SaveFormatError(`Body size mismatch: declared ${declared + 8}, actual ${body.byteLength}`);
  }
  const versionData = readVersionData(r);

  // World-partition validation grids (not needed; skip structurally).
  const gridCount = r.i32();
  for (let i = 0; i < gridCount; i++) {
    r.fstring(); r.i32(); r.u32();
    const children = r.u32();
    for (let j = 0; j < children; j++) { r.fstring(); r.u32(); }
  }

  const stats = { ...newStats(), objects: 0, failedObjects: 0 };
  const levels: SaveLevel[] = [];
  let destroyedActors = new Map<string, ObjectRef[]>();
  const levelCount = r.i32();
  let layout: SaveLayout = 'game';
  let persistentRefs: ObjectRef[] = [];

  for (let li = 0; li <= levelCount; li++) {
    const isPersistent = li === levelCount;
    const levelName = isPersistent ? header.mapName : r.fstring();
    if (li % 200 === 0) options.onProgress?.(r.pos / body.byteLength, `Level ${li + 1}/${levelCount + 1}`);

    const tocLength = r.i64n();
    const tocStart = r.pos;
    r.skip(tocLength);
    const dataLength = r.i64n();
    const dataStart = r.pos;
    r.skip(dataLength);

    let levelSaveVersion = header.saveVersion;
    let levelUe5 = versionData.ue5Version;
    let collectables: ObjectRef[] = [];
    if (isPersistent) {
      // The persistent level is last, so its trailer runs to the end of the body. The game
      // writes the destroyed-actor map and then one more ref list. Some third-party save
      // editors (files named *_CALCULATOR.sav) write only a streamed-level style i32 TOC
      // version and keep the map inside the TOC blob, which is read below.
      if (r.remaining === 4) {
        const v = r.i32();
        if (v !== 0) { levelSaveVersion = v; layout = 'persistent-toc-version'; }
      } else {
        destroyedActors = readDestroyedActorsMap(r);
        if (r.remaining > 0) persistentRefs = readRefList(r);
        if (r.remaining !== 0) throw new SaveFormatError(`${r.remaining} unread bytes at the end of the persistent level`);
      }
    } else {
      if (header.saveVersion >= SaveVersion.SerializePerStreamableLevelTOCVersion) levelSaveVersion = r.i32();
      collectables = readRefList(r);
      if (header.saveVersion >= SaveVersion.SerializeDataPackageVersionAndCustomVersions && r.i32() >= 1) {
        levelUe5 = readVersionData(r).ue5Version;
      }
    }
    const afterLevel = r.pos;

    // --- TOC: object headers
    const toc = new BinaryReader(body.subarray(tocStart, tocStart + tocLength));
    const objectCount = toc.i32();
    const objects: SaveObject[] = new Array(objectCount);
    for (let i = 0; i < objectCount; i++) {
      const type = toc.i32();
      const typePath = toc.fstring();
      const rootObject = toc.fstring();
      const instanceName = toc.fstring();
      const flags = levelSaveVersion >= SaveVersion.SerializeObjectFlags ? toc.u32() : 0;
      const base = {
        typePath, className: classNameOf(typePath), rootObject, instanceName, flags,
        properties: {}, trailingBytes: 0, trailing: EMPTY, record: EMPTY, level: levelName,
      };
      if (type === 1) {
        const needTransform = toc.i32(); void needTransform;
        const rotation = [toc.f32(), toc.f32(), toc.f32(), toc.f32()];
        const translation = [toc.f32(), toc.f32(), toc.f32()];
        const scale = [toc.f32(), toc.f32(), toc.f32()];
        const wasPlacedInLevel = toc.i32() !== 0;
        objects[i] = { kind: 'entity', ...base, transform: { rotation, translation, scale }, wasPlacedInLevel };
      } else if (type === 0) {
        objects[i] = { kind: 'component', ...base, parentEntityName: toc.fstring() };
      } else {
        throw new SaveFormatError(`Unknown object type ${type} in level ${levelName}`, tocStart + toc.pos);
      }
    }
    if (toc.remaining > 0) {
      // Some versions store the destroyed-actor / collectables lists inside the TOC blob.
      if (isPersistent) destroyedActors = readDestroyedActorsMap(toc, true);
      else collectables = readRefList(toc);
    }

    // --- Data blob: object contents
    const data = new BinaryReader(body.subarray(dataStart, dataStart + dataLength));
    const dataCount = data.i32();
    if (dataCount !== objectCount) {
      throw new SaveFormatError(`Level ${levelName}: ${dataCount} data entries for ${objectCount} headers`);
    }
    for (let i = 0; i < dataCount; i++) {
      const obj = objects[i]!;
      const recordStart = data.pos;
      const objSaveVersion = data.i32();
      data.i32(); // shouldMigrateObjectRefsToPersistent
      const size = data.i32();
      const objStart = data.pos;
      data.skip(size);
      let objUe5 = levelUe5;
      if (objSaveVersion >= SaveVersion.SerializeDataPackageVersionAndCustomVersions && data.i32() === 1) {
        objUe5 = readVersionData(data).ue5Version;
      }
      const after = data.pos;
      obj.record = data.bytes.subarray(recordStart, after);
      stats.objects++;
      decodeObject(obj, data, objStart, size, {
        completeTags: objUe5 >= UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME
          && objSaveVersion >= SaveVersion.SerializeDataPackageVersionAndCustomVersions,
        doubleVectors: objSaveVersion >= SAVE_VERSION_64BIT_ARCHIVE,
        stats,
      }, options.wantProperties);
      if (obj.failed) stats.failedObjects++;
      data.seek(after);
    }
    if (data.remaining > 0) {
      throw new SaveFormatError(`Level ${levelName}: ${data.remaining} unread bytes after the last object`);
    }
    levels.push({
      name: levelName, objects, collectables,
      raw: { toc: body.subarray(tocStart, tocStart + tocLength), data: body.subarray(dataStart, dataStart + dataLength) },
    });
    r.seek(afterLevel);
  }

  options.onProgress?.(1, 'Done');
  return { header, versionData, levels, destroyedActors, persistentRefs, stats, layout };
}

function decodeObject(
  obj: SaveObject, data: BinaryReader, start: number, size: number, ctx: PropertyContext,
  wantProperties?: (className: string) => boolean,
): void {
  data.seek(start);
  const end = start + size;
  try {
    if (obj.kind === 'entity') {
      obj.parent = readObjectRef(data);
      const n = data.i32();
      obj.components = [];
      for (let i = 0; i < n; i++) obj.components.push(readObjectRef(data));
    }
    if (wantProperties && !wantProperties(obj.className)) return;
    if (ctx.completeTags) data.u8(); // serialization control byte
    obj.properties = readPropertyList(data, ctx);
    if (data.i32() > 0) data.skip(16); // object GUID
    obj.trailingBytes = end - data.pos;
    if (obj.trailingBytes < 0) throw new SaveFormatError(`over-read by ${-obj.trailingBytes} bytes`);
    obj.trailing = data.bytes.subarray(data.pos, end);
  } catch (e) {
    // Fail soft: the object stays in the graph with its raw record, flagged as failed.
    obj.properties = {};
    obj.trailingBytes = 0;
    obj.trailing = EMPTY;
    obj.failed = (e as Error).message;
  }
}
