// Layer and composition markers as expressions see them. The parser keeps a
// marker property only as its raw `mrst` list, so markers are decoded here:
// times from the list's keyframe records, data from each `Nmrd` (an `NmHd`
// header and the comment, chapter, URL, frame target, cue point name and
// cue-point parameter strings). Layouts follow py-aep's parsers/marker.py and
// binary/misc_chunks.py (MIT, https://github.com/forticheprod/py-aep).
import { Bytes, decodeCdta, decodeKeyframe, decodeLhd3, LdatKind, ldatItems, utf8Of } from "../aep/decode.ts";
import type { CompItem, Layer } from "../aep/model.ts";
import { filterLists, findChild, findList, type Chunk } from "../aep/riff.ts";

export interface Marker {
  /** Composition seconds. */
  time: number;
  duration: number;
  comment: string;
  chapter: string;
  url: string;
  frameTarget: string;
  cuePointName: string;
  eventCuePoint: boolean;
  parameters: Record<string, string>;
  protectedRegion: boolean;
  label: number;
}

function findMrst(root: Chunk | undefined): Chunk | undefined {
  if (!root?.children) return undefined;
  for (const c of root.children) {
    if (c.type === "LIST" && c.listType === "mrst") return c;
    const inner = c.type === "LIST" ? findMrst(c) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

function decodeMarkers(mrst: Chunk, toCompTime: (units: number) => number): Marker[] {
  const list = findList(findList(mrst, "tdbs"), "list");
  const lhd3Chunk = findChild(list, "lhd3");
  const ldat = findChild(list, "ldat");
  const times = lhd3Chunk && ldat ? ldatItems(ldat, decodeLhd3(lhd3Chunk)).map((item) => toCompTime(decodeKeyframe(item, LdatKind.marker).timeUnits)) : [];
  const records = filterLists(findList(mrst, "mrky"), "Nmrd");
  return records.slice(0, times.length).map((nmrd, i) => {
    const header = new Bytes(findChild(nmrd, "NmHd")?.data ?? new Uint8Array(20));
    const strings = (nmrd.children ?? []).filter((c) => c.type === "Utf8").map(utf8Of);
    const parameters: Record<string, string> = {};
    for (let k = 5; k + 1 < strings.length; k += 2) parameters[strings[k]] = strings[k + 1];
    return {
      time: times[i],
      duration: header.u32(8) / 600,
      comment: strings[0] ?? "",
      chapter: strings[1] ?? "",
      url: strings[2] ?? "",
      frameTarget: strings[3] ?? "",
      cuePointName: strings[4] ?? "",
      eventCuePoint: true,
      parameters,
      protectedRegion: header.bit(3, 1),
      label: header.u8(16),
    };
  });
}

const timebase = (comp: CompItem): number => {
  const cdta = comp.chunk && findChild(comp.chunk, "cdta");
  return (cdta && decodeCdta(cdta).internalTimebase) || 1;
};

const cache = new WeakMap<object, Marker[]>();

export function layerMarkers(layer: Layer, comp: CompItem): Marker[] {
  let markers = cache.get(layer);
  if (!markers) {
    const mrst = findMrst(layer.chunk);
    const stretch = layer.stretch ? layer.stretch / 100 : 1;
    const base = Math.floor(timebase(comp) * Math.max(1, Math.abs(stretch))) || 1;
    const offset = stretch >= 0 ? layer.startTime : layer.startTime - Math.abs(stretch) / 3000;
    markers = mrst ? decodeMarkers(mrst, (units) => (units / base) * stretch + offset) : [];
    cache.set(layer, markers);
  }
  return markers;
}

/** Composition markers live on the comp's hidden `SecL` layer, in absolute comp time. */
export function compMarkers(comp: CompItem): Marker[] {
  let markers = cache.get(comp);
  if (!markers) {
    const mrst = findMrst(comp.chunk && findList(comp.chunk, "SecL"));
    const base = timebase(comp);
    markers = mrst ? decodeMarkers(mrst, (units) => units / base) : [];
    cache.set(comp, markers);
  }
  return markers;
}
