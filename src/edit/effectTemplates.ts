// Effect templates as After Effects writes them: an effect's definition (LIST:EfDf) from
// a project After Effects saved, and from it a fresh instance (LIST:sspc): every stored
// number, angle, popup, checkbox and colour back at the default its parameter definition
// (pard) gives, points at the layer centre, no keyframes, expressions or layer references,
// Particular's Size and Opacity over Life curves flat, switched on and named after its
// type. Parameters the definition leaves out (After Effects stores none at their
// defaults) are written when they are set (effects.ts).
import { containerText, decodePard, decodeTdb4, type Pard } from "../aep/decode.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { flatCurve, OVER_LIFE } from "../render/effects/particularCurves.ts";
import { doubles, leaf, readDoubles } from "./chunks.ts";
import { clone, nameData, UNNAMED } from "./effects.ts";
import { fixedUtf8, propertyClass, setExpressionFlags, staticCdat, staticTdb4 } from "./encode.ts";

export const chunkText = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0.*$/s, "");

/** The definitions (LIST:EfDf) a project's EfdG holds, by match name. */
export function projectDefinitions(root: Chunk): Map<string, Chunk> {
  const found = new Map<string, Chunk>();
  for (const efdf of findList(root, "EfdG")?.children ?? []) {
    if (efdf.type !== "LIST" || efdf.listType !== "EfDf") continue;
    const tdmn = findChild(efdf, "tdmn");
    if (tdmn) found.set(chunkText(tdmn), efdf);
  }
  return found;
}

/** The effect's display name stored in its definition (fnam), if any. */
export function definitionName(definition: Chunk): string | undefined {
  return containerText(findChild(findList(definition, "sspc"), "fnam"));
}

interface ParamDef {
  pard: Pard;
  /** A point's default: x and y as shares of the layer's size, then z. */
  point?: number[];
}

/**
 * The parameter definitions (parT) of an effect, by match name, in order. A point's default
 * follows its value in the pard: x and y in percent of the layer, as 16.16 fixed point for
 * 2D points (after a reserved word) and as doubles for 3D points (with z after them).
 */
function paramDefs(sspc: Chunk | undefined): Map<string, ParamDef> {
  const defs = new Map<string, ParamDef>();
  let current = "";
  for (const c of findList(sspc, "parT")?.children ?? []) {
    if (c.type === "tdmn") current = chunkText(c);
    if (c.type !== "pard") continue;
    const pard = decodePard(c);
    const view = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    let point: number[] | undefined;
    if (pard.controlType === 6 && c.data.length >= 76) point = [view.getInt32(68) / 6553600, view.getInt32(72) / 6553600];
    if (pard.controlType === 18 && c.data.length >= 104) point = [view.getFloat64(80) / 100, view.getFloat64(88) / 100, view.getFloat64(96)];
    defs.set(current, { pard, point });
  }
  return defs;
}

/** Turns a keyframed stream static, as the stopwatch does (editor.ts); its value is then reset. */
function unanimate(tdbs: Chunk, pard: Pard | undefined): boolean {
  const keys = findList(tdbs, "list");
  const tdb4 = findChild(tdbs, "tdb4");
  if (!keys || !tdb4) return false;
  const cls = propertyClass(decodeTdb4(tdb4), { controlType: pard?.controlType });
  tdbs.children = (tdbs.children ?? []).map((c) => (c === keys ? staticCdat([], cls) : c));
  staticTdb4(tdb4.data, cls);
  return true;
}

/** Puts a stored parameter back at its definition's default; returns what changed. */
function reset(tdbs: Chunk, def: ParamDef | undefined): string[] {
  const pard = def?.pard;
  const changes: string[] = [];
  const kids = tdbs.children ?? [];
  if (kids.some((c) => c.type === "Utf8")) {
    tdbs.children = kids.filter((c) => c.type !== "Utf8");
    changes.push("expression");
  }
  const tdb4 = findChild(tdbs, "tdb4");
  if (tdb4) setExpressionFlags(tdb4.data, false, false);
  const tdpi = findChild(tdbs, "tdpi");
  if (tdpi && new DataView(tdpi.data.buffer, tdpi.data.byteOffset).getInt32(0)) {
    tdpi.data = new Uint8Array(4);
    changes.push("layer");
  }
  const cdat = findChild(tdbs, "cdat");
  if (!cdat || !pard) return changes;
  const values = readDoubles(cdat.data);
  const before = values.join();
  const d = pard.defaultValue;
  switch (pard.controlType) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 7:
    case 10:
      if (typeof d === "number") values[0] = d;
      break;
    case 5:
      if (Array.isArray(d)) [values[0], values[1], values[2], values[3]] = [d[3] * 255, d[0] * 255, d[1] * 255, d[2] * 255];
      break;
    case 6:
    case 18: {
      const point = def.point ?? [0.5, 0.5, 0];
      values[0] = point[0];
      values[1] = point[1];
      if (pard.controlType === 18) values[2] = point[2] ?? 0;
      break;
    }
  }
  if (values.join() !== before) {
    cdat.data = doubles(values);
    changes.push("value");
  }
  return changes;
}

export interface FreshInstance {
  sspc: Chunk;
  /** One line on what was reset, for the library export's log. */
  summary: string;
}

/**
 * A fresh instance of the effect `definition` defines, at its parameters' defaults. With a
 * `pool`, the value parameters the definition leaves out are written too, so every one of
 * them can be set without another stored stream of its kind.
 */
export function freshInstance(matchName: string, definition: Chunk, pool?: StreamPool): FreshInstance {
  const original = findList(definition, "sspc");
  if (!original) throw new Error(`the definition of ${matchName} has no parameters`);
  const sspc = clone(original);
  const defs = paramDefs(sspc);
  if (!defs.size) throw new Error(`the definition of ${matchName} has no parameter list`);
  const tdgp = findList(sspc, "tdgp");
  if (!tdgp) throw new Error(`the definition of ${matchName} has no parameter group`);
  // The effect is switched on (bit 0 of the tdsb's last byte) and named after its type.
  const tdsb = findChild(tdgp, "tdsb");
  if (tdsb) tdsb.data[3] |= 1;
  const tdsn = findChild(tdgp, "tdsn");
  if (tdsn) tdsn.data = nameData(UNNAMED);
  const counts = new Map<string, number>();
  const count = (change: string) => counts.set(change, (counts.get(change) ?? 0) + 1);
  // A parameter's lists follow its name: its stream (tdbs), then for arbitrary data (curves) an aRbs.
  const listsAfter = (kids: Chunk[], i: number) => {
    let j = i + 1;
    while (j < kids.length && kids[j].type === "LIST") j++;
    return j;
  };
  const kids = tdgp.children ?? [];
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].type !== "tdmn") continue;
    const name = chunkText(kids[i]);
    for (let j = i + 1; j < listsAfter(kids, i); j++) {
      const list = kids[j];
      if (list.listType === "tdbs") {
        if (unanimate(list, defs.get(name)?.pard)) count("keyframed");
        for (const change of reset(list, defs.get(name))) count(change);
      } else if (list.listType === "aRbs") {
        const aRbp = findChild(list, "aRbp");
        if (matchName === "tc Particular" && aRbp && OVER_LIFE.has(Number(name.slice(matchName.length + 1)))) {
          aRbp.data = flatCurve(aRbp.data);
          count("curve");
        } else {
          count("arbitrary data kept from the donor");
        }
      }
    }
  }
  const stored = kids.filter((c, i) => c.type === "tdmn" && kids[i + 1]?.type === "LIST").length;
  if (pool) {
    for (const [name, def] of defs) {
      const type = def.pard.controlType;
      if (!VALUE_TYPES.has(type) || kids.some((c) => c.type === "tdmn" && chunkText(c) === name)) continue;
      if (writeStream(tdgp, name, defs, pool.get(matchName)?.get(type) ?? pool.get("")?.get(type))) count("written at its default");
      else count("left out, no stream of its kind to copy");
    }
  }
  const changes = [...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "nothing";
  return { sspc, summary: `${defs.size} parameters, ${stored} stored; ${changes}` };
}

/** Control types of parameters with a value stream (tdbs): numbers, angles, checkboxes, colours, points, popups. */
const VALUE_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 10, 18]);

/** Stored, unanimated streams by control type: per effect match name, and under "" from any effect. */
export type StreamPool = Map<string, Map<number, Chunk>>;

/** The streams the given definitions store, for writing the parameters other instances leave out. */
export function streamPool(definitions: Iterable<[string, Chunk]>): StreamPool {
  const pool: StreamPool = new Map([["", new Map()]]);
  for (const [matchName, definition] of definitions) {
    const sspc = findList(definition, "sspc");
    const defs = paramDefs(sspc);
    const own = pool.get(matchName) ?? new Map<number, Chunk>();
    pool.set(matchName, own);
    const kids = findList(sspc, "tdgp")?.children ?? [];
    kids.forEach((c, i) => {
      const tdbs = kids[i + 1];
      const type = c.type === "tdmn" ? defs.get(chunkText(c))?.pard.controlType : undefined;
      if (type === undefined || !VALUE_TYPES.has(type) || tdbs?.listType !== "tdbs" || findList(tdbs, "list") || !findChild(tdbs, "tdb4")) return;
      if (!own.has(type)) own.set(type, tdbs);
      if (!pool.get("")!.has(type)) pool.get("")!.set(type, tdbs);
    });
  }
  return pool;
}

/**
 * Writes parameter `name`, which the instance leaves out, as a copy of `donor` (a stream of
 * its control type) named and ranged as its definition says, at its default, after the
 * stored parameter defined last before it (as effects.ts writes a set one).
 */
function writeStream(tdgp: Chunk, name: string, defs: Map<string, ParamDef>, donor: Chunk | undefined): boolean {
  const def = defs.get(name);
  if (!donor || !def) return false;
  const { pard } = def;
  const tdbs = clone(donor);
  tdbs.children = (tdbs.children ?? []).filter((c) => c.type !== "Utf8");
  for (const c of tdbs.children) {
    if (c.type === "tdsn") c.data = nameData(pard.name);
    else if (c.type === "tdb4") setExpressionFlags(c.data, false, false);
    else if (c.type === "tdum" && pard.sliderMin !== undefined) c.data = doubles([pard.sliderMin]);
    else if (c.type === "tduM" && pard.sliderMax !== undefined) c.data = doubles([pard.sliderMax]);
    else if (c.type === "tdpi") c.data = new Uint8Array(c.data.length);
  }
  reset(tdbs, def);
  const order = [...defs.keys()];
  const target = order.indexOf(name);
  const children = tdgp.children ?? [];
  let at = children.findIndex((c) => c.type === "tdmn");
  let before = -1;
  children.forEach((c, i) => {
    const k = c.type === "tdmn" ? order.indexOf(chunkText(c)) : -1;
    if (k >= 0 && k < target && k > before) {
      before = k;
      at = i + 1;
      while (at < children.length && children[at].type === "LIST") at++;
    }
  });
  children.splice(at < 0 ? children.length : at, 0, leaf("tdmn", fixedUtf8(name, 40)), tdbs);
  tdgp.children = children;
  return true;
}
