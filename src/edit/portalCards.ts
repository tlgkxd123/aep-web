// App-owned effect parameters. Scalar streams use the library's Slider Control format so
// they support the same editing, expressions, keyframes and serialization as other effects.
import { decodePard, decodeTdb4 } from "../aep/decode.ts";
import type { Project, PropertyGroup } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { doubles, leaf, list, type Transaction } from "./chunks.ts";
import { clone, setName, type EffectTemplate } from "./effects.ts";
import { fixedUtf8, propertyClass, setExpressionFlags, staticTdb4 } from "./encode.ts";
import { layerTimebase, setTimebase, tdmnName } from "./layer-templates.ts";

export const PORTAL_CARDS = "AEPW Portal Cards";
/** The name Effect Controls and Effects & Presets show, as an effect's `fnam` gives it. */
export const PORTAL_CARDS_NAME = "Portal Cards";
export const PORTAL_CARD_PARAMS = [
  ["Cards", 7, 1, 16],
  ["Depth Spacing", 62, 25, 90],
  ["Speed", 18, -200, 200],
  ["Evolution", 0, -100000, 100000],
  ["Y Rotation", 60, -360, 360],
  ["X Rotation", 22, -360, 360],
  ["Twist", 12, -360, 360],
  ["Drift", 18, 0, 100],
  ["Zoom", 100, 10, 400],
  ["Center X", 50, -100, 200],
  ["Center Y", 50, -100, 200],
  ["Shadow", 45, 0, 100],
  ["Edge Light", 12, 0, 100],
  ["Background", 70, 0, 100],
  ["Pulse", 0, 0, 100],
  ["Randomness", 100, 0, 100],
  ["Random Seed", 1, 0, 100000],
] as const;

const paramName = (index: number) => `${PORTAL_CARDS}-${String(index).padStart(4, "0")}`;

function paramChunk(group: Chunk | undefined, index: number): Chunk | undefined {
  const children = group?.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === paramName(index));
  return at >= 0 ? children[at + 1] : undefined;
}

function parameter(index: number, [name, value, min, max]: readonly [string, number, number, number], originalPard: Chunk, stream: Chunk) {
  const pard = clone(originalPard);
  // PF_FloatSliderDef, as decoded by decodePard. Defaults and ranges belong to this effect.
  pard.data.set(fixedUtf8(name, 32), 16);
  const view = new DataView(pard.data.buffer, pard.data.byteOffset, pard.data.byteLength);
  view.setFloat64(56, value);
  for (const [offset, v] of [[104, min], [108, max], [112, min], [116, max], [120, value]]) view.setFloat32(offset, v);
  const tdbs = clone(stream);
  // A saved donor may be animated or have an expression; new controls start static.
  tdbs.children = tdbs.children?.filter((c) => c.type !== "Utf8" && c.listType !== "list");
  const tdb4 = findChild(tdbs, "tdb4");
  if (tdb4) {
    staticTdb4(tdb4.data, propertyClass(decodeTdb4(tdb4), { controlType: decodePard(pard).controlType }));
    setExpressionFlags(tdb4.data, false, false);
  }
  const cdat = findChild(tdbs, "cdat");
  if (cdat) cdat.data = doubles([value]);
  else tdbs.children?.push(leaf("cdat", doubles([value])));
  setName(findChild(tdbs, "tdsn")!, name);
  const lower = findChild(tdbs, "tdum");
  const upper = findChild(tdbs, "tduM");
  if (lower) lower.data = doubles([min]);
  if (upper) upper.data = doubles([max]);
  const match = paramName(index);
  return { definition: [leaf("tdmn", fixedUtf8(match, 40)), pard], stream: [leaf("tdmn", fixedUtf8(match, 40)), tdbs] };
}

export function portalCardsTemplate(slider: EffectTemplate): EffectTemplate {
  const source = findList(slider.instance, "tdgp")!;
  const children = source.children!;
  const at = children.findIndex((c) => c.type === "tdmn" && new TextDecoder().decode(c.data).startsWith("ADBE Slider Control-0001"));
  const stream = children[at + 1];
  const part = findList(slider.instance, "parT")!.children!;
  const pi = part.findIndex((c) => c.type === "tdmn" && new TextDecoder().decode(c.data).startsWith("ADBE Slider Control-0001"));
  const originalPard = part[pi + 1];
  if (stream?.listType !== "tdbs" || originalPard?.type !== "pard") throw new Error("Slider Control template is missing its scalar stream");
  // Parameter zero is the input layer; the parser skips it like every AE effect does.
  const defs: Chunk[] = [leaf("tdmn", fixedUtf8(`${PORTAL_CARDS}-0000`, 40)), clone(part[1])];
  // fnam and the group's tdsn are container chunks: their text lives in a Utf8 child, which
  // is what containerText reads (a bare data payload reads as no name at all).
  const fnam = leaf("fnam", new Uint8Array(0));
  setName(fnam, PORTAL_CARDS_NAME);
  const groupName = leaf("tdsn", new Uint8Array(0));
  setName(groupName, PORTAL_CARDS_NAME);
  const streams: Chunk[] = [leaf("tdsb", new Uint8Array([0, 0, 0, 1])), groupName];
  PORTAL_CARD_PARAMS.forEach((def, index) => {
    const param = parameter(index + 1, def, originalPard, stream);
    defs.push(...param.definition);
    streams.push(...param.stream);
  });
  streams.push(leaf("tdmn", fixedUtf8("ADBE Group End", 40)));
  const instance = list("sspc", [fnam, list("parT", defs), list("tdgp", streams)]);
  return { matchName: PORTAL_CARDS, instance, definition: list("EfDf", [leaf("tdmn", fixedUtf8(PORTAL_CARDS, 40)), clone(instance)]) };
}

/** Adds current controls to saved app-owned effects before the editor establishes its undo baseline. */
export function upgradePortalCards(project: Project, tx: Transaction): void {
  const instances: { instance: Chunk; timebase?: number }[] = [];
  const definition = findList(project.file.root, "EfdG")?.children?.find((c) => {
    const match = c.listType === "EfDf" && findChild(c, "tdmn");
    return match && tdmnName(match) === PORTAL_CARDS;
  });
  const defined = findList(definition, "sspc");
  if (defined) instances.push({ instance: defined });
  for (const comp of project.items.values()) {
    if (comp.kind !== "comp") continue;
    for (const layer of comp.layers) {
      const parade = layer.properties.find((p): p is PropertyGroup => p.kind === "group" && p.matchName === "ADBE Effect Parade");
      for (const effect of parade?.children ?? []) if (effect.kind === "group" && effect.matchName === PORTAL_CARDS && effect.chunk) {
        instances.push({ instance: effect.chunk, timebase: layerTimebase(comp, layer) });
      }
    }
  }
  if (!instances.length) return;
  const basePart = instances.map(({ instance }) => findList(instance, "parT")).find((p) => paramChunk(p, 1)?.type === "pard");
  const originalPard = paramChunk(basePart, 1);
  const baseStream = instances.map(({ instance }) => paramChunk(findList(instance, "tdgp"), 1)).find((p) => p?.listType === "tdbs");
  if (!basePart || !originalPard || !baseStream) return;
  for (const { instance, timebase } of instances) {
    const part = findList(instance, "parT");
    const tdgp = findList(instance, "tdgp");
    if (!tdgp?.children) continue;
    const sourcePart = part ?? basePart;
    const defs = sourcePart.children?.slice() ?? [];
    let changed = !part;
    // Expand rotation ranges without changing the saved defaults or values.
    for (const index of [5, 6, 7]) {
      const old = paramChunk(sourcePart, index);
      if (old?.type !== "pard") continue;
      const range = decodePard(old);
      if (range.min === -360 && range.max === 360 && range.sliderMin === -360 && range.sliderMax === 360) continue;
      const next = clone(old);
      const view = new DataView(next.data.buffer, next.data.byteOffset, next.data.byteLength);
      for (const [offset, value] of [[104, -360], [108, 360], [112, -360], [116, 360]]) view.setFloat32(offset, value);
      defs[defs.indexOf(old)] = next;
      changed = true;
    }
    const stream = paramChunk(tdgp, 1) ?? baseStream;
    for (const index of [16, 17]) {
      const old = paramChunk(sourcePart, index);
      const [name, fallback, min, max] = PORTAL_CARD_PARAMS[index - 1];
      // Older layouts start with zero Randomness to preserve their appearance.
      const value = old?.type === "pard" ? Number(decodePard(old).defaultValue ?? fallback) : index === 16 ? 0 : fallback;
      const param = parameter(index, [name, value, min, max], originalPard, stream);
      if (!old) { defs.push(...param.definition); changed = true; }
      if (!paramChunk(tdgp, index)) {
        if (timebase !== undefined) setTimebase(param.stream[1], timebase);
        const children = tdgp.children;
        const end = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === "ADBE Group End");
        const at = end < 0 ? children.length : end;
        tx.setChildren(tdgp, [...children.slice(0, at), ...param.stream, ...children.slice(at)]);
      }
    }
    if (changed) {
      if (part) tx.setChildren(part, defs);
      else {
        const children = instance.children ?? [];
        const at = children.indexOf(tdgp);
        tx.setChildren(instance, [...children.slice(0, at), list("parT", defs.map(clone)), ...children.slice(at)]);
      }
    }
  }
}
