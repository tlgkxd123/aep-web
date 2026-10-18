// App-owned effect parameters. Scalar streams use the library's Slider Control format so
// they support the same editing, expressions, keyframes and serialization as other effects.
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { doubles, leaf, list } from "./chunks.ts";
import { clone, setName, type EffectTemplate } from "./effects.ts";
import { fixedUtf8 } from "./encode.ts";

export const PORTAL_CARDS = "AEPW Portal Cards";
/** The name Effect Controls and Effects & Presets show, as an effect's `fnam` gives it. */
export const PORTAL_CARDS_NAME = "Portal Cards";
export const PORTAL_CARD_PARAMS = [
  ["Cards", 7, 1, 16],
  ["Depth Spacing", 62, 25, 90],
  ["Speed", 18, -200, 200],
  ["Evolution", 0, -100000, 100000],
  ["Y Rotation", 38, -85, 85],
  ["X Rotation", 14, -85, 85],
  ["Twist", 8, -180, 180],
  ["Drift", 18, 0, 100],
  ["Zoom", 100, 10, 400],
  ["Center X", 50, -100, 200],
  ["Center Y", 50, -100, 200],
  ["Shadow", 45, 0, 100],
  ["Edge Light", 12, 0, 100],
  ["Background", 70, 0, 100],
  ["Pulse", 0, 0, 100],
] as const;

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
  PORTAL_CARD_PARAMS.forEach(([name, value, min, max], index) => {
    const match = `${PORTAL_CARDS}-${String(index + 1).padStart(4, "0")}`;
    const pard = clone(originalPard);
    // PF_FloatSliderDef, as decoded by decodePard. Defaults and ranges belong to this effect.
    pard.data.set(fixedUtf8(name, 32), 16);
    const view = new DataView(pard.data.buffer, pard.data.byteOffset, pard.data.byteLength);
    view.setFloat64(56, value);
    for (const [offset, v] of [[104, min], [108, max], [112, min], [116, max], [120, value]]) view.setFloat32(offset, v);
    defs.push(leaf("tdmn", fixedUtf8(match, 40)), pard);
    const tdbs = clone(stream);
    findChild(tdbs, "cdat")!.data = doubles([value]);
    setName(findChild(tdbs, "tdsn")!, name);
    const lower = findChild(tdbs, "tdum");
    const upper = findChild(tdbs, "tduM");
    if (lower) lower.data = doubles([min]);
    if (upper) upper.data = doubles([max]);
    streams.push(leaf("tdmn", fixedUtf8(match, 40)), tdbs);
  });
  streams.push(leaf("tdmn", fixedUtf8("ADBE Group End", 40)));
  const instance = list("sspc", [fnam, list("parT", defs), list("tdgp", streams)]);
  return { matchName: PORTAL_CARDS, instance, definition: list("EfDf", [leaf("tdmn", fixedUtf8(PORTAL_CARDS, 40)), clone(instance)]) };
}
