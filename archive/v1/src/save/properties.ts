/**
 * Unreal tagged-property reader for Satisfactory 1.1+ saves (UE5 "complete type
 * name" property tags, UE5 object version >= 1012).
 *
 * Robustness rule: every property and every save object declares its byte size,
 * so anything we cannot decode is kept as raw bytes and the reader re-syncs.
 * Failures are counted in `ParseStats` rather than thrown.
 */
import { BinaryReader, SaveFormatError } from './binary-reader';

export interface ObjectRef { levelName: string; pathName: string; }

export interface TypeNode { name: string; children: TypeNode[]; }

export interface RawValue { raw: Uint8Array; reason: string; }

export interface StructValue {
  struct: string;
  /** Native structs decode to a plain object; tagged ones to a PropertyBag. */
  value: unknown;
}

export interface MapValue { entries: Array<[unknown, unknown]>; }

export interface TextValue {
  historyType: number;
  /** Best-effort display string (culture invariant / base / string-table key). */
  text: string;
  [k: string]: unknown;
}

export interface Property {
  name: string;
  type: string;
  typeNode: TypeNode;
  index: number;
  value: unknown;
}

export type PropertyBag = Record<string, Property>;

export interface ParseStats {
  rawProperties: number;
  rawReasons: Map<string, number>;
}

export function newStats(): ParseStats { return { rawProperties: 0, rawReasons: new Map() }; }

export interface PropertyContext {
  /** UE5 complete-type-name property tags (FPropertyTypeName trees). */
  completeTags: boolean;
  /** Vectors/quats stored as doubles (save version >= SwitchTo64BitSaveArchive). */
  doubleVectors: boolean;
  stats: ParseStats;
}

// Tag flags (EPropertyTagFlags, UE 5.4+)
const TAG_HAS_ARRAY_INDEX = 0x01;
const TAG_HAS_GUID = 0x02;
const TAG_HAS_EXTENSIONS = 0x04;
const TAG_BINARY_OR_NATIVE = 0x08;
const TAG_BOOL_TRUE = 0x10;

function readTypeNode(r: BinaryReader): TypeNode {
  const name = r.fstring();
  const count = r.i32();
  if (count < 0 || count > 64) throw new SaveFormatError(`Bad type-node child count ${count}`, r.pos - 4);
  const children: TypeNode[] = [];
  for (let i = 0; i < count; i++) children.push(readTypeNode(r));
  return { name, children };
}

export function readObjectRef(r: BinaryReader): ObjectRef {
  return { levelName: r.fstring(), pathName: r.fstring() };
}

function noteRaw(ctx: PropertyContext, reason: string): void {
  ctx.stats.rawProperties++;
  ctx.stats.rawReasons.set(reason, (ctx.stats.rawReasons.get(reason) ?? 0) + 1);
}

/** Read a property list terminated by a "None" name. */
export function readPropertyList(r: BinaryReader, ctx: PropertyContext): PropertyBag {
  if (!ctx.completeTags) {
    throw new SaveFormatError('Legacy (pre-UE5.4) property tags are not supported; save is older than Update 1.1');
  }
  const bag: PropertyBag = {};
  for (;;) {
    const name = r.fstring();
    if (name === 'None') return bag;
    const typeNode = readTypeNode(r);
    const size = r.i32();
    const flags = r.u8();
    const index = flags & TAG_HAS_ARRAY_INDEX ? r.i32() : 0;
    if (flags & TAG_HAS_GUID) r.skip(16);
    if (flags & TAG_HAS_EXTENSIONS) readTagExtensions(r);
    const start = r.pos;
    let value: unknown;
    try {
      value = readTaggedValue(r, ctx, typeNode, size, flags);
      if (r.pos - start !== size) {
        throw new SaveFormatError(`read ${r.pos - start} of ${size} bytes`);
      }
    } catch (e) {
      r.seek(start);
      const reason = `${typeNode.name}${typeNode.children[0] ? `<${typeNode.children[0].name}>` : ''}: ${(e as Error).message.replace(/ \(at byte \d+\)/, '')}`;
      noteRaw(ctx, reason);
      value = { raw: r.bytesView(size), reason } satisfies RawValue;
    }
    const key = index ? `${name}#${index}` : name;
    bag[key] = { name, type: typeNode.name, typeNode, index, value };
  }
}

function readTagExtensions(r: BinaryReader): void {
  const ext = r.u8();
  // EPropertyTagExtension::OverridableInformation = 0x02
  if (ext & 0x02) { r.u8(); r.u8(); }
  if (ext & ~0x02) throw new SaveFormatError(`Unsupported property tag extension 0x${ext.toString(16)}`, r.pos - 1);
}

function readTaggedValue(
  r: BinaryReader, ctx: PropertyContext, node: TypeNode, size: number, flags: number,
): unknown {
  switch (node.name) {
    case 'BoolProperty': return (flags & TAG_BOOL_TRUE) !== 0;
    case 'ByteProperty':
      // Enum-backed bytes serialize as the enumerator name.
      return node.children.length && node.children[0]!.name !== 'None' && size !== 1 ? r.fstring() : r.u8();
    case 'StructProperty': {
      const structName = node.children[0]?.name ?? '';
      const native = (flags & TAG_BINARY_OR_NATIVE) !== 0;
      return readStruct(r, ctx, structName, size, native);
    }
    case 'ArrayProperty': return readArray(r, ctx, node, size);
    case 'SetProperty': return readSet(r, ctx, node);
    case 'MapProperty': return readMap(r, ctx, node);
    default: return readScalar(r, ctx, node);
  }
}

/** Scalars shared by top-level properties and container elements. */
function readScalar(r: BinaryReader, ctx: PropertyContext, node: TypeNode): unknown {
  switch (node.name) {
    case 'BoolProperty': return r.u8() !== 0; // only inside containers
    case 'ByteProperty': return node.children.length && node.children[0]!.name !== 'None' ? r.fstring() : r.u8();
    case 'Int8Property': return r.i8();
    case 'Int16Property': return r.i16();
    case 'IntProperty': return r.i32();
    case 'UInt16Property': return r.u16();
    case 'UInt32Property': return r.u32();
    case 'Int64Property': return r.i64();
    case 'UInt64Property': return r.u64();
    case 'FloatProperty': return r.f32();
    case 'DoubleProperty': return r.f64();
    case 'StrProperty':
    case 'NameProperty':
    case 'EnumProperty': return r.fstring();
    case 'ObjectProperty':
    case 'InterfaceProperty':
    case 'WeakObjectProperty':
    case 'LazyObjectProperty': return readObjectRef(r);
    case 'SoftObjectProperty':
    case 'SoftClassProperty': return { levelName: r.fstring(), pathName: r.fstring(), subPath: r.fstring() };
    case 'TextProperty': return readText(r);
    default: throw new SaveFormatError(`Unsupported property type ${node.name}`);
  }
}

function readArray(r: BinaryReader, ctx: PropertyContext, node: TypeNode, size: number): unknown[] {
  const inner = node.children[0];
  if (!inner) throw new SaveFormatError('ArrayProperty without inner type');
  const start = r.pos;
  const count = r.i32();
  if (count < 0) throw new SaveFormatError(`Negative array count ${count}`);
  const out: unknown[] = new Array(count);
  if (inner.name === 'StructProperty') {
    const structName = inner.children[0]?.name ?? '';
    for (let i = 0; i < count; i++) out[i] = readStruct(r, ctx, structName, -1, isNativeStruct(structName));
    return out;
  }
  if (inner.name === 'ByteProperty') {
    // Byte arrays are raw bytes unless enum-backed (then FStrings). Size disambiguates.
    if (size - 4 === count) { for (let i = 0; i < count; i++) out[i] = r.u8(); return out; }
    for (let i = 0; i < count; i++) out[i] = r.fstring();
    return out;
  }
  for (let i = 0; i < count; i++) out[i] = readScalar(r, ctx, inner);
  void start;
  return out;
}

function readSet(r: BinaryReader, ctx: PropertyContext, node: TypeNode): unknown[] {
  const inner = node.children[0];
  if (!inner) throw new SaveFormatError('SetProperty without inner type');
  const removed = r.i32();
  for (let i = 0; i < removed; i++) readContainerElement(r, ctx, inner);
  const count = r.i32();
  const out: unknown[] = [];
  for (let i = 0; i < count; i++) out.push(readContainerElement(r, ctx, inner));
  return out;
}

function readMap(r: BinaryReader, ctx: PropertyContext, node: TypeNode): MapValue {
  const [k, v] = node.children;
  if (!k || !v) throw new SaveFormatError('MapProperty without key/value types');
  const removed = r.i32();
  for (let i = 0; i < removed; i++) readContainerElement(r, ctx, k);
  const count = r.i32();
  const entries: Array<[unknown, unknown]> = [];
  for (let i = 0; i < count; i++) {
    const key = readContainerElement(r, ctx, k);
    const value = readContainerElement(r, ctx, v);
    entries.push([key, value]);
  }
  return { entries };
}

function readContainerElement(r: BinaryReader, ctx: PropertyContext, node: TypeNode): unknown {
  if (node.name === 'StructProperty') {
    const structName = node.children[0]?.name ?? '';
    return readStruct(r, ctx, structName, -1, isNativeStruct(structName));
  }
  return readScalar(r, ctx, node);
}

// ---------------------------------------------------------------------------
// Structs

const NATIVE_STRUCTS = new Set([
  'Vector', 'Rotator', 'Vector2D', 'Quat', 'Vector4', 'Vector4D', 'Box', 'LinearColor', 'Color',
  'IntPoint', 'IntVector', 'IntVector4', 'Guid', 'DateTime', 'Timespan', 'FluidBox', 'InventoryItem',
  'RailroadTrackPosition', 'TimerHandle', 'ClientIdentityInfo', 'PlayerInfoHandle', 'FrameNumber',
  'SoftClassPath', 'SoftObjectPath', 'UniqueNetIdRepl',
]);

export function isNativeStruct(name: string): boolean { return NATIVE_STRUCTS.has(name); }

function vec(r: BinaryReader, ctx: PropertyContext, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(ctx.doubleVectors ? r.f64() : r.f32());
  return out;
}

function readStruct(
  r: BinaryReader, ctx: PropertyContext, name: string, size: number, native: boolean,
): StructValue {
  if (!native) return { struct: name, value: readPropertyList(r, ctx) };
  switch (name) {
    case 'Vector':
    case 'Rotator': { const [x, y, z] = vec(r, ctx, 3); return { struct: name, value: { x, y, z } }; }
    case 'Vector2D': { const [x, y] = vec(r, ctx, 2); return { struct: name, value: { x, y } }; }
    case 'Quat':
    case 'Vector4':
    case 'Vector4D': { const [x, y, z, w] = vec(r, ctx, 4); return { struct: name, value: { x, y, z, w } }; }
    case 'Box': {
      const min = vec(r, ctx, 3); const max = vec(r, ctx, 3);
      return { struct: name, value: { min, max, isValid: r.u8() !== 0 } };
    }
    case 'LinearColor': return { struct: name, value: { r: r.f32(), g: r.f32(), b: r.f32(), a: r.f32() } };
    case 'Color': { const b = r.u8(), g = r.u8(), rr = r.u8(), a = r.u8(); return { struct: name, value: { r: rr, g, b, a } }; }
    case 'IntPoint': return { struct: name, value: { x: r.i32(), y: r.i32() } };
    case 'IntVector': return { struct: name, value: { x: r.i32(), y: r.i32(), z: r.i32() } };
    case 'IntVector4': return { struct: name, value: { x: r.i32(), y: r.i32(), z: r.i32(), w: r.i32() } };
    case 'Guid': return { struct: name, value: r.guid() };
    case 'DateTime':
    case 'Timespan': return { struct: name, value: r.i64() };
    case 'FrameNumber': return { struct: name, value: r.i32() };
    case 'FluidBox': return { struct: name, value: r.f32() };
    case 'TimerHandle': return { struct: name, value: r.fstring() };
    case 'SoftClassPath':
    case 'SoftObjectPath': return { struct: name, value: { levelName: r.fstring(), pathName: r.fstring(), subPath: r.fstring() } };
    case 'RailroadTrackPosition':
      return { struct: name, value: { ref: readObjectRef(r), offset: r.f32(), forward: r.f32() } };
    case 'InventoryItem': return { struct: name, value: readInventoryItem(r, ctx) };
    case 'PlayerInfoHandle': return { struct: name, value: { provider: r.u8(), index: r.i32() } };
    case 'ClientIdentityInfo': {
      const offlineId = r.fstring();
      const n = r.i32();
      for (let i = 0; i < n; i++) { r.u8(); r.skip(r.i32()); }
      return { struct: name, value: { offlineId } };
    }
    default:
      if (size >= 0) {
        noteRaw(ctx, `native struct ${name}`);
        return { struct: name, value: { raw: r.bytesView(size), reason: `native struct ${name}` } satisfies RawValue };
      }
      throw new SaveFormatError(`Unknown native struct ${name} inside a container`);
  }
}

export interface InventoryItemValue {
  item: ObjectRef;
  /** FGDynamicStruct item state (e.g. equipment charge), if any. */
  state?: { struct: ObjectRef; properties: PropertyBag | RawValue };
}

function readInventoryItem(r: BinaryReader, ctx: PropertyContext): InventoryItemValue {
  const item = readObjectRef(r);
  const hasState = r.i32() >= 1;
  if (!hasState) return { item };
  const struct = readObjectRef(r);
  const payloadSize = r.i32();
  const start = r.pos;
  let properties: PropertyBag | RawValue;
  try {
    properties = readPropertyList(r, ctx);
    if (r.pos - start !== payloadSize) throw new SaveFormatError('item state size mismatch');
  } catch {
    r.seek(start);
    properties = { raw: r.bytesView(payloadSize), reason: 'item state' };
  }
  return { item, state: { struct, properties } };
}

// ---------------------------------------------------------------------------
// FText

function readText(r: BinaryReader): TextValue {
  const flags = r.u32();
  const historyType = r.i8();
  switch (historyType) {
    case -1: {
      const has = r.i32() !== 0;
      return { historyType, flags, text: has ? r.fstring() : '' };
    }
    case 0: {
      const namespace = r.fstring(); const key = r.fstring(); const text = r.fstring();
      return { historyType, flags, namespace, key, text };
    }
    case 1: case 2: case 3: {
      const source = readText(r);
      const n = r.i32();
      const args: Array<{ name?: string; value: unknown }> = [];
      for (let i = 0; i < n; i++) {
        const name = historyType === 2 ? undefined : r.fstring();
        args.push({ name, value: readFormatArg(r) });
      }
      return { historyType, flags, source, args, text: source.text };
    }
    case 10: {
      const source = readText(r); const transform = r.u8();
      return { historyType, flags, source, transform, text: source.text };
    }
    case 11: {
      const tableId = r.fstring(); const key = r.fstring();
      return { historyType, flags, tableId, key, text: key };
    }
    default:
      throw new SaveFormatError(`Unsupported FText history type ${historyType}`);
  }
}

function readFormatArg(r: BinaryReader): unknown {
  const t = r.i8();
  switch (t) {
    case 0: return r.i64();
    case 1: return r.u64();
    case 2: return r.f32();
    case 3: return r.f64();
    case 4: return readText(r);
    case 5: return r.i8();
    default: throw new SaveFormatError(`Unsupported FText format argument type ${t}`);
  }
}
