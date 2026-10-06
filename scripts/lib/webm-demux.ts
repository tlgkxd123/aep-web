// Reads a Matroska/WebM file with one video track: EBML header, Info, Tracks
// (including AlphaMode and Colour), Cues, and every SimpleBlock/BlockGroup
// with its BlockAdditional (alpha) payload.

export interface WebmBlock {
  offset: number;
  size: number;
  /** Absolute time in TimecodeScale units. */
  time: number;
  key: boolean;
  alpha?: { offset: number; size: number; id: number };
}

export interface WebmFile {
  docType: string;
  timecodeScale: number;
  /** Info Duration in TimecodeScale units, if present. */
  duration?: number;
  codec: string;
  trackNumber: number;
  defaultDuration?: number;
  width: number;
  height: number;
  alphaMode: number;
  colour?: { matrix?: number; range?: number; transfer?: number; primaries?: number };
  blocks: WebmBlock[];
  cues: { time: number; clusterPosition: number }[];
  /** Cluster offsets relative to the start of the Segment's data, as Cues and SeekHead store them. */
  clusterPositions: number[];
  /** Positions of top-level Segment children by ID, relative to the Segment's data. */
  segmentChildren: Map<number, number[]>;
  seekHead: Map<number, number>;
}

function readVint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = bytes[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error(`invalid EBML number at ${at}`);
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const uint = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);
function float(b: Uint8Array): number {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

interface Element {
  id: number;
  start: number;
  body: number;
  end: number;
}

function elements(bytes: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = [];
  let at = start;
  while (at < end) {
    const id = readVint(bytes, at, true);
    const size = readVint(bytes, at + id.length, false);
    const body = at + id.length + size.length;
    if (size.unknown) throw new Error(`element ${id.value.toString(16)} has an unknown size`);
    const elEnd = body + size.value;
    if (elEnd > end) throw new Error(`element ${id.value.toString(16)} at ${at} overruns its parent`);
    out.push({ id: id.value, start: at, body, end: elEnd });
    at = elEnd;
  }
  return out;
}

export function demuxWebm(bytes: Uint8Array): WebmFile {
  const top = elements(bytes, 0, bytes.length);
  const ebml = top.find((e) => e.id === 0x1a45dfa3);
  const segment = top.find((e) => e.id === 0x18538067);
  if (!ebml || !segment) throw new Error("missing EBML header or Segment");
  const data = (e: Element) => bytes.subarray(e.body, e.end);
  const docTypeEl = elements(bytes, ebml.body, ebml.end).find((e) => e.id === 0x4282);
  const file: WebmFile = {
    docType: docTypeEl ? new TextDecoder().decode(data(docTypeEl)) : "",
    timecodeScale: 1_000_000,
    codec: "",
    trackNumber: 0,
    width: 0,
    height: 0,
    alphaMode: 0,
    blocks: [],
    cues: [],
    clusterPositions: [],
    segmentChildren: new Map(),
    seekHead: new Map(),
  };
  const parseBlock = (payload: Element, kind: "simple" | "group", references: boolean, alpha?: WebmBlock["alpha"], clusterTime = 0) => {
    const track = readVint(bytes, payload.body, false);
    const view = new DataView(bytes.buffer, bytes.byteOffset + payload.body + track.length, 3);
    const relative = view.getInt16(0);
    const flags = view.getUint8(2);
    if (flags & 0x06) throw new Error("laced blocks are not expected");
    const headerSize = track.length + 3;
    file.blocks.push({
      offset: payload.body + headerSize,
      size: payload.end - payload.body - headerSize,
      time: clusterTime + relative,
      key: kind === "simple" ? (flags & 0x80) !== 0 : !references,
      alpha,
    });
  };
  for (const el of elements(bytes, segment.body, segment.end)) {
    const position = el.start - segment.body;
    file.segmentChildren.set(el.id, [...(file.segmentChildren.get(el.id) ?? []), position]);
    const children = () => elements(bytes, el.body, el.end);
    if (el.id === 0x114d9b74) {
      for (const seek of children().filter((c) => c.id === 0x4dbb)) {
        const parts = elements(bytes, seek.body, seek.end);
        const id = parts.find((p) => p.id === 0x53ab);
        const pos = parts.find((p) => p.id === 0x53ac);
        if (id && pos) file.seekHead.set(uint(data(id)), uint(data(pos)));
      }
    } else if (el.id === 0x1549a966) {
      for (const c of children()) {
        if (c.id === 0x2ad7b1) file.timecodeScale = uint(data(c));
        else if (c.id === 0x4489) file.duration = float(data(c));
      }
    } else if (el.id === 0x1654ae6b) {
      const entries = children().filter((c) => c.id === 0xae);
      if (entries.length !== 1) throw new Error(`${entries.length} tracks`);
      for (const c of elements(bytes, entries[0].body, entries[0].end)) {
        if (c.id === 0xd7) file.trackNumber = uint(data(c));
        else if (c.id === 0x86) file.codec = new TextDecoder().decode(data(c));
        else if (c.id === 0x23e383) file.defaultDuration = uint(data(c));
        else if (c.id === 0xe0) {
          for (const v of elements(bytes, c.body, c.end)) {
            if (v.id === 0xb0) file.width = uint(data(v));
            else if (v.id === 0xba) file.height = uint(data(v));
            else if (v.id === 0x53c0) file.alphaMode = uint(data(v));
            else if (v.id === 0x55b0) {
              const colour: NonNullable<WebmFile["colour"]> = {};
              for (const k of elements(bytes, v.body, v.end)) {
                if (k.id === 0x55b1) colour.matrix = uint(data(k));
                else if (k.id === 0x55b9) colour.range = uint(data(k));
                else if (k.id === 0x55ba) colour.transfer = uint(data(k));
                else if (k.id === 0x55bb) colour.primaries = uint(data(k));
              }
              file.colour = colour;
            }
          }
        }
      }
    } else if (el.id === 0x1c53bb6b) {
      for (const point of children().filter((c) => c.id === 0xbb)) {
        const parts = elements(bytes, point.body, point.end);
        const time = parts.find((p) => p.id === 0xb3);
        const positions = parts.find((p) => p.id === 0xb7);
        const cluster = positions && elements(bytes, positions.body, positions.end).find((p) => p.id === 0xf1);
        if (time && cluster) file.cues.push({ time: uint(data(time)), clusterPosition: uint(data(cluster)) });
      }
    } else if (el.id === 0x1f43b675) {
      file.clusterPositions.push(position);
      let clusterTime = 0;
      for (const c of children()) {
        if (c.id === 0xe7) clusterTime = uint(data(c));
        else if (c.id === 0xa3) parseBlock(c, "simple", false, undefined, clusterTime);
        else if (c.id === 0xa0) {
          const parts = elements(bytes, c.body, c.end);
          const block = parts.find((p) => p.id === 0xa1);
          if (!block) throw new Error("BlockGroup without Block");
          let alpha: WebmBlock["alpha"];
          const additions = parts.find((p) => p.id === 0x75a1);
          if (additions) {
            const more = elements(bytes, additions.body, additions.end).find((p) => p.id === 0xa6);
            const moreParts = more ? elements(bytes, more.body, more.end) : [];
            const id = moreParts.find((p) => p.id === 0xee);
            const payload = moreParts.find((p) => p.id === 0xa5);
            if (payload) alpha = { offset: payload.body, size: payload.end - payload.body, id: id ? uint(data(id)) : 1 };
          }
          parseBlock(block, "group", parts.some((p) => p.id === 0xfb), alpha, clusterTime);
        }
      }
    }
  }
  return file;
}
