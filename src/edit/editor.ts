// An editing session over a parsed project. Every command rewrites the chunk
// tree inside a Transaction and then re-derives the affected compositions from
// the chunks, so the model always equals what the saved file parses to. The
// history stores chunk states, so undo and redo are exact.
import { LdatKind, decodeCdta, decodeLdta, decodeLhd3, decodeTdb4 } from "../aep/decode.ts";
import { valueAtTime } from "../aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyValue } from "../aep/model.ts";
import { PropertyValueType } from "../aep/model.ts";
import {
  BLENDING_MODES,
  DANCING_DISSOLVE,
  projectFromRifx,
  propertyCodec,
  refreshCompositions,
  refreshProject,
  type PropertyCodec,
} from "../aep/parse.ts";
import { findChild, findList, readRifx, type Chunk, type RifxFile } from "../aep/riff.ts";
import { writeRifx } from "../aep/write.ts";
import { applyStates, chunkPath, readDoubles, Transaction, utf8Chunk, type ChunkChange } from "./chunks.ts";
import { syncItems } from "./layer-items.ts";
import {
  CDTA,
  DEFAULT_INFLUENCE,
  ItemLayout,
  KeyItem,
  LAYER_SWITCHES,
  LDTA,
  animateTdb4,
  doubles,
  fixedUtf8,
  insertAfter,
  joinItems,
  keyframeKindFor,
  keyframeList,
  propertyClass,
  removeChild,
  replaceChild,
  setBit,
  setExpressionFlags,
  setRatio,
  splitItems,
  stampTimeBase,
  staticCdat,
  staticTdb4,
  timebaseFor,
  writeFrameRate,
  writeLhd3Count,
  type LayerSwitch,
  type PropertyClass,
} from "./encode.ts";

export type { LayerSwitch } from "./encode.ts";

export const Interpolation = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 } as const;
export type KeyframeAssist = "linear" | "bezier" | "hold" | "toggleHold" | "easyEase" | "easyEaseIn" | "easyEaseOut";

const NUMERIC_VALUE_TYPES = new Set<number>([
  PropertyValueType.OneD,
  PropertyValueType.TwoD,
  PropertyValueType.ThreeD,
  PropertyValueType.TwoD_SPATIAL,
  PropertyValueType.ThreeD_SPATIAL,
  PropertyValueType.COLOR,
]);

/** Whether the editor can change this property's value and keyframes. */
export function isEditableProperty(prop: Property): boolean {
  return !!prop.chunk && !prop.synthesized && !!propertyCodec(prop) && NUMERIC_VALUE_TYPES.has(prop.propertyValueType);
}

/** Whether an expression can be written on this property. */
export function canSetExpression(prop: Property): boolean {
  return !!prop.chunk && !prop.synthesized && prop.propertyValueType !== PropertyValueType.NO_VALUE;
}

/** [byte, bit] of each comp switch in cdta, as decodeCdta reads them. */
const COMP_SWITCHES = {
  draft3d: [138, 7],
  frameBlending: [139, 4],
  motionBlur: [139, 3],
  hideShyLayers: [139, 0],
} as const;
export type CompSwitch = keyof typeof COMP_SWITCHES;

const LAYER_BLOCK_ENDS = new Set(["Layr", "DLay", "SLay", "CLay", "SecL", "CIFO", "CIF2", "CIF3", "Gide"]);

interface HistoryEntry {
  label: string;
  change: ChunkChange;
  comps: CompItem[];
  coalesce?: string;
  /** Changed the item tree: the whole project is re-derived after it, its undo and its redo. */
  items?: boolean;
}

export interface PerformOptions extends CommandOptions {
  /** The command adds or removes project items. */
  items?: boolean;
}

interface Target {
  prop: Property;
  codec: PropertyCodec;
  tdbs: Chunk;
  tdb4: Chunk;
  cls: PropertyClass;
  /** Orientation value container (one otda per keyframe, or the static value). */
  otky?: Chunk;
  layer: Layer;
  comp: CompItem;
}

export interface KeyframeRef {
  prop: Property;
  indices: number[];
}

export interface CompSettingsEdit {
  name?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  duration?: number;
  bgColor?: [number, number, number];
  pixelAspect?: number;
  /** Resolution downsample factors, [1, 1] for Full. */
  resolutionFactor?: [number, number];
  /** Start timecode in seconds. */
  displayStartTime?: number;
  /** Work area [start, end) in comp seconds. */
  workArea?: [number, number];
}

export interface CommandOptions {
  /**
   * Consecutive commands with the same key (a scrub or drag) collapse into one
   * history entry; each one is applied to the state before the first.
   */
  coalesce?: string;
}

export class Editor {
  readonly file: RifxFile;
  readonly project: Project;
  /** Increments on every change to the model. */
  revision = 0;
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private savedTop: HistoryEntry | null = null;
  private readonly listeners = new Set<() => void>();
  /** The command `perform` is running: commands it calls join its transaction. */
  private batch?: { tx: Transaction; comps: CompItem[]; items: boolean };

  constructor(file: RifxFile, project = projectFromRifx(file)) {
    this.file = file;
    this.project = project;
  }

  static fromBytes(bytes: Uint8Array): Editor {
    return new Editor(readRifx(bytes));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get dirty(): boolean {
    return (this.undoStack.at(-1) ?? null) !== this.savedTop;
  }

  get undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    applyStates(entry.change.before);
    this.redoStack.push(entry);
    this.changed(entry.comps, entry.items);
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    applyStates(entry.change.after);
    this.undoStack.push(entry);
    this.changed(entry.comps, entry.items);
  }

  /** Serializes the project; unedited chunks are written back byte for byte. */
  save(): Uint8Array {
    return writeRifx(this.file);
  }

  markSaved(): void {
    this.savedTop = this.undoStack.at(-1) ?? null;
    this.notify();
  }

  /** Ends coalescing: the next command starts a new history entry. */
  commit(): void {
    const top = this.undoStack.at(-1);
    if (top) delete top.coalesce;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private changed(comps: CompItem[], items = false): void {
    // Renames, moves, re-sourced footage and removed layers in any comp all
    // need the full re-derivation, not just the item tree.
    if (items) refreshProject(this.project);
    else refreshCompositions(this.project, comps);
    this.revision++;
    this.notify();
  }

  /** Re-reads the item tree after its chunks changed (new solids, folders). */
  syncItems(): void {
    syncItems(this.project);
  }

  /**
   * Runs `body` as one undoable command named `label`. Editor commands called
   * from `body` join it, and the comps they touch are refreshed after each of
   * them, so `body` can read the model between steps.
   */
  perform(label: string, comps: CompItem[], body: (tx: Transaction) => void, options: PerformOptions = {}): void {
    if (this.batch) {
      const batch = this.batch;
      body(batch.tx);
      for (const comp of comps) if (!batch.comps.includes(comp)) batch.comps.push(comp);
      if (options.items) batch.items = true;
      this.refreshBatch(batch);
      return;
    }
    const all = [...comps];
    let items = !!options.items;
    try {
      this.run(label, all, options, (tx) => {
        const batch = { tx, comps: all, items };
        this.batch = batch;
        try {
          body(tx);
        } finally {
          items = batch.items;
          this.batch = undefined;
        }
      }, () => items);
    } catch (error) {
      this.refreshBatch({ comps: all, items: true });
      throw error;
    }
  }

  private refreshBatch(batch: { comps: CompItem[]; items?: boolean }): void {
    if (batch.items) this.syncItems();
    refreshCompositions(this.project, batch.comps);
  }

  /**
   * Runs a project-level command (src/edit/project.ts): `body` rewrites the
   * item chunks through `tx`, and the item tree and every composition are
   * re-derived after it and after its undo and redo.
   */
  runProjectCommand(label: string, body: (tx: Transaction) => void): void {
    this.perform(label, [], body, { items: true });
  }

  private allComps(): CompItem[] {
    return [...this.project.items.values()].filter((i): i is CompItem => i.kind === "comp");
  }

  private run(label: string, comps: CompItem[], options: CommandOptions, body: (tx: Transaction) => void, items = () => false): void {
    if (this.batch) {
      this.perform(label, comps, body);
      return;
    }
    const top = this.undoStack.at(-1);
    const merge = !!options.coalesce && top?.coalesce === options.coalesce && top !== this.savedTop && !this.redoStack.length;
    if (merge) {
      applyStates(top.change.before);
      this.refreshBatch(top);
    }
    const tx = new Transaction();
    try {
      body(tx);
    } catch (error) {
      applyStates(tx.commit().before);
      if (merge) applyStates(top.change.after);
      throw error;
    }
    const change = tx.commit();
    if (merge) {
      for (const [chunk, state] of change.before) if (!top.change.before.has(chunk)) top.change.before.set(chunk, state);
      for (const [chunk, state] of change.after) top.change.after.set(chunk, state);
      for (const chunk of top.change.before.keys()) {
        if (!change.after.has(chunk)) top.change.after.set(chunk, top.change.before.get(chunk)!);
      }
      for (const comp of comps) if (!top.comps.includes(comp)) top.comps.push(comp);
      top.items ||= items();
      this.changed(top.comps, top.items);
      return;
    }
    if (tx.empty) return;
    this.undoStack.push({ label, change, comps, coalesce: options.coalesce, items: items() });
    this.redoStack.length = 0;
    this.changed(comps, items());
  }

  // ---------------------------------------------------------------- properties

  private target(comp: CompItem, layer: Layer, prop: Property): Target {
    const codec = propertyCodec(prop);
    const tdbs = prop.chunk;
    const tdb4 = findChild(tdbs, "tdb4");
    if (!codec || !tdbs || !tdb4 || prop.synthesized) throw new Error(`"${prop.name}" is not stored in the project and cannot be edited`);
    const path = chunkPath(layer.chunk, tdbs);
    const wrapper = path?.at(-2);
    const parallel = wrapper?.listType === "otst";
    const cls = propertyClass(decodeTdb4(tdb4), { parallel, controlType: prop.controlType });
    return { prop, codec, tdbs, tdb4, cls, otky: parallel ? findList(wrapper, "otky") : undefined, layer, comp };
  }

  private layout(t: Target): ItemLayout {
    return new ItemLayout(t.codec.kind ?? keyframeKindFor(t.cls));
  }

  private unitsAt(t: Target, compTime: number): number {
    return Math.round(((compTime - t.codec.offset) / t.codec.stretch) * t.codec.timeBase);
  }

  /** Stored doubles for a model value, laid over `template`. */
  private rawValue(t: Target, value: PropertyValue, template: number[]): number[] {
    if (t.cls.parallel) return Array.isArray(value) ? value.slice(0, 3) : template;
    return t.codec.resolver.raw(value, template);
  }

  private keyItems(t: Target): { items: KeyItem[]; list: Chunk; lhd3: Chunk; ldat: Chunk } | undefined {
    const list = findList(t.tdbs, "list");
    const lhd3 = findChild(list, "lhd3");
    const ldat = findChild(list, "ldat");
    if (!list || !lhd3 || !ldat) return undefined;
    const layout = this.layout(t);
    if (!layout.size) throw new Error(`"${t.prop.name}" has keyframes of a kind the editor cannot write`);
    return { items: splitItems(ldat.data, decodeLhd3(lhd3).count, layout), list, lhd3, ldat };
  }

  private writeItems(tx: Transaction, keys: { items: KeyItem[]; lhd3: Chunk; ldat: Chunk }): void {
    tx.setData(keys.ldat, joinItems(keys.items));
    tx.patch(keys.lhd3, (_, bytes) => writeLhd3Count(bytes, keys.items.length));
  }

  private otdas(t: Target): Chunk[] {
    return (t.otky?.children ?? []).filter((c) => c.type === "otda");
  }

  private writeStatic(tx: Transaction, t: Target, value: PropertyValue): void {
    const cdat = findChild(t.tdbs, "cdat");
    if (!cdat) throw new Error(`"${t.prop.name}" has no stored value`);
    const template = readDoubles(cdat.data, t.cls.parallel);
    tx.setData(cdat, doubles(this.rawValue(t, value, template), t.cls.parallel));
    const otda = this.otdas(t)[0];
    if (t.cls.parallel && otda) tx.setData(otda, doubles(this.rawValue(t, value, readDoubles(otda.data))));
  }

  private writeKeyValue(tx: Transaction, t: Target, item: KeyItem, index: number, value: PropertyValue): void {
    if (t.cls.parallel) {
      const otda = this.otdas(t)[index];
      const raw = this.rawValue(t, value, otda ? readDoubles(otda.data) : [0, 0, 0]);
      if (otda) tx.setData(otda, doubles(raw));
      item.orientation = raw;
      return;
    }
    item.value = this.rawValue(t, value, item.value ?? []);
  }

  /**
   * Sets a property's value at comp time `time` the way the Timeline does: the
   * static value, the keyframe at `time`, or a new keyframe when animated.
   */
  setValue(comp: CompItem, layer: Layer, prop: Property, value: PropertyValue, time: number, options: CommandOptions = {}): void {
    assertNotSeparated(prop);
    this.run(`Change ${prop.name}`, [comp], options, (tx) => {
      const t = this.target(comp, layer, prop);
      const keys = this.keyItems(t);
      if (!keys) return this.writeStatic(tx, t, value);
      const units = this.unitsAt(t, time);
      const index = keys.items.findIndex((item) => item.timeUnits === units);
      if (index >= 0) {
        this.writeKeyValue(tx, t, keys.items[index], index, value);
        this.writeItems(tx, keys);
        return;
      }
      this.insertKey(tx, t, keys, units, value, false);
    });
  }

  /** Adds a keyframe at `time` holding the current value (the keyframe navigator / stopwatch). */
  addKeyframe(comp: CompItem, layer: Layer, prop: Property, time: number): void {
    assertNotSeparated(prop);
    const value = this.currentValue(prop, time, layer);
    this.run(`Add keyframe to ${prop.name}`, [comp], {}, (tx) => {
      const t = this.target(comp, layer, prop);
      const keys = this.keyItems(t);
      const units = this.unitsAt(t, time);
      if (keys?.items.some((item) => item.timeUnits === units)) return;
      if (keys) this.insertKey(tx, t, keys, units, value, true);
      else this.animate(tx, t, units, value);
    });
  }

  private currentValue(prop: Property, time: number, layer: Layer): PropertyValue {
    try {
      return valueAtTime(prop, time, layer);
    } catch {
      return prop.value;
    }
  }

  /** Static to animated: the cdat becomes a keyframe list holding one key. */
  private animate(tx: Transaction, t: Target, units: number, value: PropertyValue): void {
    if (!t.prop.canVaryOverTime) throw new Error(`"${t.prop.name}" cannot be animated`);
    const cdat = findChild(t.tdbs, "cdat");
    const kind = keyframeKindFor(t.cls);
    const layout = new ItemLayout(kind);
    if (!layout.size) throw new Error(`"${t.prop.name}" cannot be animated by the editor`);
    const item = KeyItem.create(layout, units);
    const template = cdat ? readDoubles(cdat.data, t.cls.parallel).slice(0, layout.dims || 3) : [];
    const raw = this.rawValue(t, value, template);
    if (t.cls.parallel) {
      item.orientation = raw;
      const otda = this.otdas(t)[0];
      if (otda) tx.setData(otda, doubles(raw));
    } else item.value = raw.slice(0, layout.dims);
    const list = keyframeList(kind, [item]);
    if (cdat) replaceChild(tx, t.tdbs, cdat, [list]);
    else insertAfter(tx, t.tdbs, t.tdb4, list);
    tx.patch(t.tdb4, (_, bytes) => animateTdb4(bytes, t.cls, t.codec.timeBase, t.comp.pixelAspect));
  }

  /** Animated to static: the keyframe list becomes a cdat holding `raw`. */
  private deanimate(tx: Transaction, t: Target, list: Chunk, raw: number[]): void {
    replaceChild(tx, t.tdbs, list, [staticCdat(raw, t.cls)]);
    tx.patch(t.tdb4, (_, bytes) => staticTdb4(bytes, t.cls));
  }

  private insertKey(
    tx: Transaction,
    t: Target,
    keys: { items: KeyItem[]; list: Chunk; lhd3: Chunk; ldat: Chunk },
    units: number,
    value: PropertyValue,
    preserveCurve: boolean,
  ): void {
    const layout = this.layout(t);
    const item = KeyItem.create(layout, units);
    let index = keys.items.findIndex((other) => other.timeUnits > units);
    if (index < 0) index = keys.items.length;
    const neighbour = keys.items[Math.min(index, keys.items.length - 1)];
    if (t.cls.parallel) {
      const otdas = this.otdas(t);
      const raw = this.rawValue(t, value, otdas[0] ? readDoubles(otdas[0].data) : [0, 0, 0]);
      item.orientation = raw;
      if (t.otky) {
        const children = t.otky.children ?? [];
        const at = otdas[index] ? children.indexOf(otdas[index]) : children.length;
        tx.setChildren(t.otky, [...children.slice(0, at), { type: "otda", offset: -1, data: doubles(raw) }, ...children.slice(at)]);
      }
    } else item.value = this.rawValue(t, value, neighbour?.value ?? []);
    const prev = keys.items[index - 1];
    const next = keys.items[index];
    if (preserveCurve && prev && next) this.splitSegment(t, prev, item, next);
    keys.items.splice(index, 0, item);
    this.writeItems(tx, keys);
  }

  /**
   * Gives a key inserted inside a segment the interpolation that keeps the
   * animation unchanged: hold stays hold, a linear segment keeps its slope.
   * Inside a Bezier segment the key takes the curve's slope with the default
   * influence, which only approximates the original curve.
   */
  private splitSegment(t: Target, prev: KeyItem, item: KeyItem, next: KeyItem): void {
    let outType = prev.outInterpolation;
    let inType = next.inInterpolation;
    if (outType === 3 || inType === 3) outType = inType = 3;
    item.inInterpolation = outType;
    item.outInterpolation = inType;
    const base = t.codec.timeBase;
    const [t0, t1, tm] = [prev.timeUnits / base, next.timeUnits / base, item.timeUnits / base];
    if (!(t0 < tm && tm < t1)) return;
    const layout = item.layout;
    const v0 = prev.value;
    const v1 = next.value;
    for (let i = 0; i < layout.easeCount; i++) {
      if (outType === 3) {
        item.setEase("in", i, 0, DEFAULT_INFLUENCE);
        item.setEase("out", i, 0, DEFAULT_INFLUENCE);
        continue;
      }
      let slope = 0;
      if (v0 && v1) {
        if (layout.sharedEase) {
          const a = t.codec.resolver.value(v0);
          const b = t.codec.resolver.value(v1);
          const pa = Array.isArray(a) ? a : [a ?? 0];
          const pb = Array.isArray(b) ? b : [b ?? 0];
          const chord = Math.hypot(...pa.map((x, d) => (pb[d] as number) - (x as number)));
          slope = t.codec.resolver.rawSpeed(chord / (t1 - t0));
        } else slope = (v1[i] - v0[i]) / (t1 - t0);
      }
      item.setEase("in", i, slope, DEFAULT_INFLUENCE);
      item.setEase("out", i, slope, DEFAULT_INFLUENCE);
      if (outType === 1) {
        prev.setEase("out", i, slope, DEFAULT_INFLUENCE);
        next.setEase("in", i, slope, DEFAULT_INFLUENCE);
      }
    }
  }

  /** Removes keyframes; removing the last one makes the property static with `staticValue` (default: the removed key's value). */
  removeKeyframes(comp: CompItem, layer: Layer, prop: Property, indices: number[], staticValue?: PropertyValue): void {
    if (!indices.length) return;
    this.run(indices.length > 1 ? `Delete keyframes` : `Delete keyframe`, [comp], {}, (tx) => {
      const t = this.target(comp, layer, prop);
      const keys = this.keyItems(t);
      if (!keys) return;
      const drop = new Set(indices);
      const first = Math.min(...indices);
      const kept = keys.items.filter((_, i) => !drop.has(i));
      const otdas = this.otdas(t);
      if (kept.length) {
        if (t.otky && otdas.length) tx.setChildren(t.otky, (t.otky.children ?? []).filter((c) => !drop.has(otdas.indexOf(c))));
        keys.items = kept;
        this.writeItems(tx, keys);
        return;
      }
      let raw: number[];
      if (t.cls.parallel) {
        const keep = otdas[first];
        raw = staticValue !== undefined ? this.rawValue(t, staticValue, [0, 0, 0]) : keep ? readDoubles(keep.data) : [0, 0, 0];
        if (t.otky) {
          const value = keep ? { ...keep, data: doubles(raw) } : { type: "otda", offset: -1, data: doubles(raw) };
          tx.setChildren(t.otky, [...(t.otky.children ?? []).filter((c) => c.type !== "otda"), value]);
        }
      } else {
        const template = keys.items[first].value ?? [];
        raw = staticValue !== undefined ? this.rawValue(t, staticValue, template) : template;
      }
      this.deanimate(tx, t, keys.list, raw);
    });
  }

  /** The stopwatch: animate at `time`, or drop every keyframe keeping the value at `time`. */
  toggleStopwatch(comp: CompItem, layer: Layer, prop: Property, time: number): void {
    if (prop.keyframes.length) {
      const value = this.currentValue(prop, time, layer);
      this.removeKeyframes(comp, layer, prop, prop.keyframes.map((_, i) => i), value);
    } else this.addKeyframe(comp, layer, prop, time);
  }

  /**
   * Shifts keyframes by `delta` seconds. A moved key landing on an unmoved one
   * replaces it, as in the Timeline.
   */
  moveKeyframes(comp: CompItem, layer: Layer, refs: KeyframeRef[], delta: number, options: CommandOptions = {}): void {
    this.run("Move keyframes", [comp], options, (tx) => {
      for (const ref of refs) {
        const t = this.target(comp, layer, ref.prop);
        const keys = this.keyItems(t);
        if (!keys) continue;
        const shift = Math.round((delta / t.codec.stretch) * t.codec.timeBase);
        if (!shift) continue;
        const moved = new Set(ref.indices);
        const otdas = this.otdas(t);
        const entries = keys.items.map((item, i) => ({ item, otda: otdas[i], moved: moved.has(i) }));
        for (const e of entries) if (e.moved) e.item.timeUnits += shift;
        const landed = new Set(entries.filter((e) => e.moved).map((e) => e.item.timeUnits));
        const kept = entries.filter((e) => e.moved || !landed.has(e.item.timeUnits));
        kept.sort((a, b) => a.item.timeUnits - b.item.timeUnits);
        keys.items = kept.map((e) => e.item);
        this.writeItems(tx, keys);
        if (t.otky && otdas.length) {
          const others = (t.otky.children ?? []).filter((c) => c.type !== "otda");
          tx.setChildren(t.otky, [...others, ...kept.map((e) => e.otda).filter((c): c is Chunk => !!c)]);
        }
      }
    });
  }

  setKeyframeValue(comp: CompItem, layer: Layer, prop: Property, index: number, value: PropertyValue, options: CommandOptions = {}): void {
    this.run(`Change ${prop.name}`, [comp], options, (tx) => {
      const t = this.target(comp, layer, prop);
      const keys = this.keyItems(t);
      const item = keys?.items[index];
      if (!keys || !item) return;
      this.writeKeyValue(tx, t, item, index, value);
      this.writeItems(tx, keys);
    });
  }

  /** Keyframe interpolation and keyframe assistants (Easy Ease: speed 0, influence 33.33 %). */
  setKeyframeInterpolation(comp: CompItem, layer: Layer, refs: KeyframeRef[], assist: KeyframeAssist): void {
    const labels: Record<KeyframeAssist, string> = {
      linear: "Linear",
      bezier: "Bezier",
      hold: "Hold",
      toggleHold: "Toggle Hold Keyframe",
      easyEase: "Easy Ease",
      easyEaseIn: "Easy Ease In",
      easyEaseOut: "Easy Ease Out",
    };
    this.run(labels[assist], [comp], {}, (tx) => {
      for (const ref of refs) {
        const t = this.target(comp, layer, ref.prop);
        const keys = this.keyItems(t);
        if (!keys) continue;
        for (const index of ref.indices) {
          const item = keys.items[index];
          if (!item) continue;
          applyAssist(item, assist);
        }
        this.writeItems(tx, keys);
      }
    });
  }

  setExpression(comp: CompItem, layer: Layer, prop: Property, text: string, options: CommandOptions = {}): void {
    this.run(text ? "Change expression" : "Remove expression", [comp], options, (tx) => {
      const t = this.target(comp, layer, prop);
      const existing = findChild(t.tdbs, "Utf8");
      if (!text) {
        if (existing) removeChild(tx, t.tdbs, existing);
        tx.patch(t.tdb4, (_, bytes) => setExpressionFlags(bytes, false, false));
        return;
      }
      const data = new TextEncoder().encode(text);
      if (existing) tx.setData(existing, data);
      else {
        const anchor = findChild(t.tdbs, "cdat") ?? findList(t.tdbs, "list") ?? t.tdb4;
        insertAfter(tx, t.tdbs, anchor, utf8Chunk(text));
      }
      tx.patch(t.tdb4, (_, bytes) => setExpressionFlags(bytes, true, true));
    });
  }

  setExpressionEnabled(comp: CompItem, layer: Layer, prop: Property, enabled: boolean): void {
    if (!prop.expression) return;
    this.run(enabled ? "Enable expression" : "Disable expression", [comp], {}, (tx) => {
      const t = this.target(comp, layer, prop);
      tx.patch(t.tdb4, (_, bytes) => setExpressionFlags(bytes, true, enabled));
    });
  }

  // ---------------------------------------------------------------- layers

  private ldta(layer: Layer): Chunk {
    const ldta = findChild(layer.chunk, "ldta");
    if (!ldta) throw new Error(`layer "${layer.name}" has no ldta chunk`);
    return ldta;
  }

  setLayerSwitch(comp: CompItem, layer: Layer, name: LayerSwitch, on: boolean): void {
    if (AV_SWITCHES.has(name)) assertAVLayer(layer, name);
    this.run(`${on ? "Enable" : "Disable"} ${name}`, [comp], {}, (tx) => {
      const ldta = this.ldta(layer);
      const was3D = decodeLdta(ldta).threeDLayer;
      tx.patch(ldta, (_, bytes) => {
        const [byte, bit] = LAYER_SWITCHES[name];
        setBit(bytes, byte, bit, on);
        if (name === "threeDLayer" && on) setBit(bytes, ...LAYER_SWITCHES.environmentLayer, false);
        if (name === "environmentLayer" && on) setBit(bytes, ...LAYER_SWITCHES.threeDLayer, true);
      });
      if (decodeLdta(ldta).threeDLayer !== was3D) this.flattenScaleZ(tx, layer);
    });
  }

  /** AE normalizes a layer's Scale Z to 100 % in the file whenever its 3D switch changes. */
  private flattenScaleZ(tx: Transaction, layer: Layer): void {
    const transform = layer.properties.find((n) => n.matchName === "ADBE Transform Group");
    const scale = transform?.kind === "group" ? transform.children.find((n) => n.matchName === "ADBE Scale") : undefined;
    const tdbs = scale?.kind === "property" ? scale.chunk : undefined;
    if (!tdbs) return;
    const cdat = findChild(tdbs, "cdat");
    if (cdat && cdat.data.length >= 24) {
      tx.patch(cdat, (view) => view.setFloat64(16, 1));
    }
    const list = findList(tdbs, "list");
    const lhd3 = findChild(list, "lhd3");
    const ldat = findChild(list, "ldat");
    if (!lhd3 || !ldat) return;
    const layout = new ItemLayout(LdatKind.threeD);
    if (decodeLhd3(lhd3).itemSize !== layout.size) return;
    const items = splitItems(ldat.data, decodeLhd3(lhd3).count, layout);
    for (const item of items) {
      const value = item.value;
      if (value) item.value = [value[0], value[1], 1];
    }
    tx.setData(ldat, joinItems(items));
  }

  setLayerQuality(comp: CompItem, layer: Layer, quality: number): void {
    assertAVLayer(layer, "Quality");
    this.run("Change quality", [comp], {}, (tx) => {
      tx.patch(this.ldta(layer), (view) => view.setUint16(LDTA.quality, Math.max(0, Math.min(2, quality - 4612))));
    });
  }

  setBlendingMode(comp: CompItem, layer: Layer, mode: number): void {
    const raw =
      mode === DANCING_DISSOLVE
        ? 3
        : mode === 5212
          ? 2
          : Number(Object.entries(BLENDING_MODES).find(([, value]) => value === mode)?.[0] ?? 2);
    assertAVLayer(layer, "Blending mode");
    this.run("Change blending mode", [comp], {}, (tx) => {
      tx.patch(this.ldta(layer), (_, bytes) => {
        bytes[LDTA.blendingMode] = raw;
        setBit(bytes, LDTA.transferFlags, 1, mode === DANCING_DISSOLVE);
      });
    });
  }

  /**
   * Sets the track matte. `matteLayerId` 0 removes it. Files from AE 23 and
   * later name the matte layer explicitly and AE turns its video off; older
   * files always use the layer above.
   */
  setTrackMatte(comp: CompItem, layer: Layer, type: number, matteLayerId?: number): void {
    assertAVLayer(layer, "Track matte");
    const matte = comp.layers.find((l) => l.id === matteLayerId);
    if (matte) assertAVLayer(matte, "A track matte layer");
    this.run("Change track matte", [comp], {}, (tx) => {
      const ldta = this.ldta(layer);
      const explicit = ldta.data.length >= LDTA.matteLayerId + 4;
      const oldId = explicit ? decodeLdta(ldta).matteLayerId ?? 0 : 0;
      const none = type === 5012 || (explicit && matteLayerId === 0);
      const newId = none ? 0 : (matteLayerId ?? oldId);
      tx.patch(ldta, (view, bytes) => {
        bytes[LDTA.trackMatteType] = none ? 0 : Math.max(0, Math.min(4, type - 5012));
        if (explicit) view.setUint32(LDTA.matteLayerId, newId);
      });
      if (!explicit) return;
      if (oldId && oldId !== newId) {
        const users = comp.layers.filter((l) => l !== layer && l.trackMatteLayerId === oldId);
        const old = comp.layers.find((l) => l.id === oldId);
        if (old && !users.length) tx.patch(this.ldta(old), (_, bytes) => setBit(bytes, ...LAYER_SWITCHES.enabled, true));
      }
      const matte = comp.layers.find((l) => l.id === newId);
      if (matte && newId !== oldId) tx.patch(this.ldta(matte), (_, bytes) => setBit(bytes, ...LAYER_SWITCHES.enabled, false));
    });
  }

  renameLayer(comp: CompItem, layer: Layer, name: string): void {
    const source = layer.sourceId ? this.project.items.get(layer.sourceId) : undefined;
    if (!name && !source) return;
    this.run("Rename layer", [comp], {}, (tx) => {
      const ldta = this.ldta(layer);
      const stored = source && name === source.name ? "" : name;
      const utf8 = findChild(layer.chunk, "Utf8");
      const data = new TextEncoder().encode(stored);
      if (utf8) tx.setData(utf8, data);
      else insertAfter(tx, layer.chunk, ldta, utf8Chunk(stored));
      const fallback = stored || source?.name || "";
      tx.patch(ldta, (_, bytes) => {
        bytes.set(fixedUtf8(stored ? name : fallback, 32), LDTA.name);
        setBit(bytes, LDTA.flags0, 0, !!stored && !!layer.sourceId);
      });
    });
  }

  /** Moves layers in time (dragging layer bars); keyframes travel with them. */
  shiftLayers(comp: CompItem, layers: Layer[], delta: number, options: CommandOptions = {}): void {
    this.run("Move layers in time", [comp], options, (tx) => {
      for (const layer of layers) {
        const ldta = this.ldta(layer);
        const start = decodeLdta(ldta).startTime;
        tx.patch(ldta, (view) => setRatio(view, LDTA.startTime, start + delta));
      }
    });
  }

  /** Sets layer timing in comp seconds; in/out points are stored relative to the start time and stretch. */
  setLayerTiming(
    comp: CompItem,
    layer: Layer,
    timing: { startTime?: number; inPoint?: number; outPoint?: number },
    options: CommandOptions = {},
  ): void {
    this.run("Change layer timing", [comp], options, (tx) => {
      const ldta = this.ldta(layer);
      const current = decodeLdta(ldta);
      const stretch = current.stretch !== 0 ? current.stretch / 100 : 1;
      const start = timing.startTime ?? current.startTime;
      tx.patch(ldta, (view) => {
        if (timing.startTime !== undefined) setRatio(view, LDTA.startTime, start);
        if (timing.inPoint !== undefined) setRatio(view, LDTA.inPoint, (timing.inPoint - start) / stretch);
        if (timing.outPoint !== undefined) setRatio(view, LDTA.outPoint, (timing.outPoint - start) / stretch);
      });
    });
  }

  /** Moves `layer` to 1-based position `index` in the layer stack. */
  moveLayer(comp: CompItem, layer: Layer, index: number): void {
    this.run("Reorder layers", [comp], {}, (tx) => {
      const list = comp.chunk;
      if (!list?.children) return;
      const children = list.children;
      const blocks: Chunk[][] = [];
      const head: Chunk[] = [];
      const tail: Chunk[] = [];
      for (const c of children) {
        const boundary = c.type === "LIST" && LAYER_BLOCK_ENDS.has(c.listType ?? "");
        if (c.type === "LIST" && c.listType === "Layr" && !tail.length) blocks.push([c]);
        else if (boundary || tail.length) tail.push(c);
        else if (blocks.length) blocks.at(-1)!.push(c);
        else head.push(c);
      }
      const from = blocks.findIndex((b) => b[0] === layer.chunk);
      const to = Math.max(0, Math.min(blocks.length - 1, index - 1));
      if (from < 0 || from === to) return;
      const [block] = blocks.splice(from, 1);
      blocks.splice(to, 0, block);
      tx.setChildren(list, [...head, ...blocks.flat(), ...tail]);
    });
  }

  /** Sets the parent without compensating the child's transform (AE's parent "jump"). */
  setParent(comp: CompItem, layer: Layer, parentId: number): void {
    for (let id = parentId; id; ) {
      if (id === layer.id) throw new Error("A layer cannot be parented to itself or one of its children");
      id = comp.layers.find((l) => l.id === id)?.parentId ?? 0;
    }
    this.run("Change parent", [comp], {}, (tx) => {
      tx.patch(this.ldta(layer), (view) => view.setUint32(LDTA.parentId, parentId));
    });
  }

  // ---------------------------------------------------------------- compositions

  /** Composition Settings. A frame-rate change keeps keyframes at the same times in seconds. */
  /** The Timeline's comp switches (Draft 3D, Frame Blending, Motion Blur, Hide Shy Layers), bits of the cdta chunk. */
  setCompSwitch(comp: CompItem, name: CompSwitch, on: boolean): void {
    this.run(`${on ? "Enable" : "Disable"} ${name}`, [comp], {}, (tx) => {
      const cdta = findChild(comp.chunk, "cdta");
      if (!cdta) throw new Error(`composition "${comp.name}" has no cdta chunk`);
      const [byte, bit] = COMP_SWITCHES[name];
      tx.patch(cdta, (_, bytes) => setBit(bytes, byte, bit, on));
    });
  }

  setCompSettings(comp: CompItem, edit: CompSettingsEdit): void {
    this.run("Composition settings", this.allComps(), {}, (tx) => {
      const list = comp.chunk;
      const cdta = findChild(list, "cdta");
      if (!list || !cdta) throw new Error(`composition "${comp.name}" has no cdta chunk`);
      const before = decodeCdta(cdta);
      if (edit.name !== undefined) {
        const utf8 = findChild(list, "Utf8");
        if (utf8) tx.setData(utf8, new TextEncoder().encode(edit.name));
      }
      tx.patch(cdta, (view, bytes) => {
        if (edit.width !== undefined) view.setUint16(CDTA.width, edit.width);
        if (edit.height !== undefined) view.setUint16(CDTA.height, edit.height);
        if (edit.bgColor) edit.bgColor.forEach((c, i) => (bytes[CDTA.bgColor + i] = Math.round(c * 255)));
        if (edit.pixelAspect !== undefined) setRatio(view, CDTA.pixelAspect, edit.pixelAspect, false);
        if (edit.resolutionFactor) edit.resolutionFactor.forEach((f, i) => view.setUint16(CDTA.resolutionFactor + i * 2, f));
        if (edit.displayStartTime !== undefined) setRatio(view, CDTA.displayStartTime, edit.displayStartTime);
        if (edit.workArea) {
          setRatio(view, CDTA.workAreaStart, edit.workArea[0], false);
          setRatio(view, CDTA.workAreaEnd, edit.workArea[1], false);
        }
        const fps = edit.frameRate !== undefined && edit.frameRate !== before.frameRate ? edit.frameRate : undefined;
        if (fps !== undefined) {
          writeFrameRate(view, fps);
          const onGrid = (s: number) => Math.round(s * fps) / fps;
          setRatio(view, CDTA.duration, onGrid(before.duration), false);
          setRatio(view, CDTA.workAreaStart, onGrid(before.workAreaStart), false);
          if (view.getUint32(CDTA.workAreaEnd) !== 0xffffffff) {
            setRatio(view, CDTA.workAreaEnd, onGrid(before.workAreaStart + before.workAreaDuration), false);
          }
        }
        if (edit.duration !== undefined) {
          setRatio(view, CDTA.duration, edit.duration, false);
          const workStart = view.getUint32(CDTA.workAreaStart) / (view.getUint32(CDTA.workAreaStart + 4) || 1);
          if (workStart >= edit.duration) setRatio(view, CDTA.workAreaStart, 0, false);
          if (view.getUint32(CDTA.workAreaEnd) !== 0xffffffff) {
            const end = view.getUint32(CDTA.workAreaEnd) / (view.getUint32(CDTA.workAreaEnd + 4) || 1);
            if (end > edit.duration) view.setUint32(CDTA.workAreaEnd, 0xffffffff), view.setUint32(CDTA.workAreaEnd + 4, 1);
          }
        }
      });
      const pixelAspect = edit.pixelAspect ?? before.pixelAspect;
      if (edit.frameRate !== undefined && edit.frameRate !== before.frameRate) {
        retime(tx, list, before.internalTimebase, timebaseFor(edit.frameRate).internalTimebase, pixelAspect);
      } else if (pixelAspect !== before.pixelAspect) {
        retime(tx, list, before.internalTimebase, before.internalTimebase, pixelAspect);
      }
    });
  }
}

/** Switches AE shows only for AV, text and shape layers. */
const AV_SWITCHES = new Set<LayerSwitch>([
  "audioEnabled",
  "effectsActive",
  "motionBlur",
  "collapseTransformation",
  "adjustmentLayer",
  "threeDLayer",
  "environmentLayer",
  "preserveTransparency",
]);

function assertAVLayer(layer: Layer, what: string): void {
  if (layer.layerType === "CameraLayer" || layer.layerType === "LightLayer") {
    throw new Error(`${what} is not available on camera and light layers`);
  }
}

function assertNotSeparated(prop: Property): void {
  if (prop.matchName === "ADBE Position" && prop.dimensionsSeparated) {
    throw new Error("Position has separated dimensions; edit X, Y and Z Position instead");
  }
}

function applyAssist(item: KeyItem, assist: KeyframeAssist): void {
  const easy = (direction: "in" | "out") => {
    for (let i = 0; i < item.layout.easeCount; i++) item.setEase(direction, i, 0, 1 / 3);
  };
  switch (assist) {
    case "linear":
      item.inInterpolation = item.outInterpolation = 1;
      break;
    case "bezier":
      item.inInterpolation = item.outInterpolation = 2;
      break;
    case "hold":
      item.inInterpolation = item.outInterpolation = 3;
      break;
    case "toggleHold":
      item.outInterpolation = item.outInterpolation === 3 ? 1 : 3;
      break;
    case "easyEase":
      item.inInterpolation = item.outInterpolation = 2;
      easy("in");
      easy("out");
      break;
    case "easyEaseIn":
      item.inInterpolation = 2;
      easy("in");
      break;
    case "easyEaseOut":
      item.outInterpolation = 2;
      easy("out");
      break;
  }
  if (assist !== "bezier") item.temporalAutoBezier = false;
}

/**
 * Restamps a composition's keyframe times and tdb4 timebases after its
 * internal timebase changed: keyframes keep their time in seconds.
 */
function retime(tx: Transaction, compList: Chunk, oldBase: number, newBase: number, pixelAspect: number): void {
  const visit = (chunk: Chunk, layerStretch: number) => {
    for (const c of chunk.children ?? []) {
      if (c.type !== "LIST") continue;
      if (c.listType === "Layr") {
        const ldta = findChild(c, "ldta");
        const stretch = ldta ? Math.abs(decodeLdta(ldta).stretch || 100) / 100 : 1;
        visit(c, stretch);
        continue;
      }
      if (c.listType === "tdbs") retimeProperty(tx, c, oldBase, newBase, layerStretch, pixelAspect);
      visit(c, layerStretch);
    }
  };
  visit(compList, 1);
}

function retimeProperty(tx: Transaction, tdbs: Chunk, oldBase: number, newBase: number, stretch: number, pixelAspect: number): void {
  const before = Math.floor(oldBase * Math.max(1, stretch)) || 1;
  const after = Math.floor(newBase * Math.max(1, stretch)) || 1;
  const tdb4 = findChild(tdbs, "tdb4");
  if (tdb4 && new DataView(tdb4.data.buffer, tdb4.data.byteOffset, tdb4.data.byteLength).getUint32(12)) {
    tx.patch(tdb4, (_, bytes) => stampTimeBase(bytes, after, pixelAspect));
  }
  const list = findList(tdbs, "list");
  const lhd3 = findChild(list, "lhd3");
  const ldat = findChild(list, "ldat");
  if (!lhd3 || !ldat || before === after) return;
  const { count, itemSize } = decodeLhd3(lhd3);
  if (itemSize < 8) return;
  tx.patch(ldat, (view) => {
    for (let i = 0; i < count && (i + 1) * itemSize <= ldat.data.length; i++) {
      view.setInt32(i * itemSize, Math.round((view.getInt32(i * itemSize) * after) / before));
    }
  });
}