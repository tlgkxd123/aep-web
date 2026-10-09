// Minimal ISO base media (MP4 / QuickTime MOV) demuxer for the first video
// track of a progressive (non-fragmented) file: codec configuration for
// WebCodecs and the sample table, read lazily from a Blob.

export interface VideoSample {
  /** Byte range in the file. */
  offset: number;
  size: number;
  /** Presentation time in seconds, after the edit list. */
  time: number;
  isSync: boolean;
}

export interface VideoTrack {
  /** WebCodecs codec string, e.g. `avc1.64001f`. */
  codec: string;
  /** Decoder configuration record (avcC / hvcC / av1C payload). */
  description?: Uint8Array;
  width: number;
  height: number;
  /** Samples in decode order. */
  samples: VideoSample[];
}

interface Box {
  type: string;
  /** Payload range (after the header) within `data`. */
  start: number;
  end: number;
}

function* boxes(data: DataView, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = data.getUint32(at);
    const type = String.fromCharCode(data.getUint8(at + 4), data.getUint8(at + 5), data.getUint8(at + 6), data.getUint8(at + 7));
    let header = 8;
    if (size === 1) {
      size = Number(data.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

function child(data: DataView, box: Box | undefined, type: string): Box | undefined {
  if (!box) return undefined;
  for (const b of boxes(data, box.start, box.end)) if (b.type === type) return b;
  return undefined;
}

function children(data: DataView, box: Box, type: string): Box[] {
  return [...boxes(data, box.start, box.end)].filter((b) => b.type === type);
}

function hex(n: number, width = 2): string {
  return n.toString(16).padStart(width, "0");
}

/** Codec string and description of a visual sample entry (ISO/IEC 14496-15, VP9 and AV1 ISOBMFF bindings). */
function codecOf(data: DataView, entry: Box): { codec: string; description?: Uint8Array; width: number; height: number } | undefined {
  const width = data.getUint16(entry.start + 24);
  const height = data.getUint16(entry.start + 26);
  const configs = { start: entry.start + 78, end: entry.end, type: entry.type };
  const bytes = (b: Box) => new Uint8Array(data.buffer, data.byteOffset + b.start, b.end - b.start).slice();
  const fourcc = entry.type;
  if (fourcc === "avc1" || fourcc === "avc3") {
    const avcC = child(data, configs, "avcC");
    if (!avcC) return undefined;
    const codec = `${fourcc}.${hex(data.getUint8(avcC.start + 1))}${hex(data.getUint8(avcC.start + 2))}${hex(data.getUint8(avcC.start + 3))}`;
    return { codec, description: bytes(avcC), width, height };
  }
  if (fourcc === "hvc1" || fourcc === "hev1") {
    const hvcC = child(data, configs, "hvcC");
    if (!hvcC) return undefined;
    const p = hvcC.start;
    const b1 = data.getUint8(p + 1);
    const space = ["", "A", "B", "C"][b1 >> 6];
    const tier = (b1 >> 5) & 1 ? "H" : "L";
    const profile = b1 & 0x1f;
    let compat = data.getUint32(p + 2);
    let reversed = 0;
    for (let i = 0; i < 32; i++) {
      reversed = (reversed << 1) | (compat & 1);
      compat >>>= 1;
    }
    const level = data.getUint8(p + 12);
    const constraints: string[] = [];
    for (let i = 0; i < 6; i++) constraints.push(hex(data.getUint8(p + 6 + i)).toUpperCase());
    while (constraints.length && constraints[constraints.length - 1] === "00") constraints.pop();
    const codec = [`${fourcc}`, `${space}${profile}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier}${level}`, ...constraints].join(".");
    return { codec, description: bytes(hvcC), width, height };
  }
  if (fourcc === "vp09") {
    const vpcC = child(data, configs, "vpcC");
    if (!vpcC) return undefined;
    const p = vpcC.start + 4;
    const codec = `vp09.${String(data.getUint8(p)).padStart(2, "0")}.${String(data.getUint8(p + 1)).padStart(2, "0")}.${String(data.getUint8(p + 2) >> 4).padStart(2, "0")}`;
    return { codec, width, height };
  }
  if (fourcc === "av01") {
    const av1C = child(data, configs, "av1C");
    if (!av1C) return undefined;
    const b1 = data.getUint8(av1C.start + 1);
    const b2 = data.getUint8(av1C.start + 2);
    const bitDepth = (b2 >> 6) & 1 ? ((b2 >> 5) & 1 ? 12 : 10) : 8;
    const codec = `av01.${b1 >> 5}.${String(b1 & 0x1f).padStart(2, "0")}${(b2 >> 7) & 1 ? "H" : "M"}.${String(bitDepth).padStart(2, "0")}`;
    return { codec, description: bytes(av1C), width, height };
  }
  return undefined;
}

function sampleTable(data: DataView, stbl: Box, timescale: number, mediaStart: number) {
  const u32 = (o: number) => data.getUint32(o);
  const stsz = child(data, stbl, "stsz");
  const stz2 = child(data, stbl, "stz2");
  const sizes: number[] = [];
  if (stsz) {
    const fixed = u32(stsz.start + 4);
    const count = u32(stsz.start + 8);
    for (let i = 0; i < count; i++) sizes.push(fixed || u32(stsz.start + 12 + i * 4));
  } else if (stz2) {
    const field = data.getUint8(stz2.start + 7);
    const count = u32(stz2.start + 8);
    for (let i = 0; i < count; i++) {
      const at = stz2.start + 12;
      if (field === 16) sizes.push(data.getUint16(at + i * 2));
      else if (field === 8) sizes.push(data.getUint8(at + i));
      else sizes.push((data.getUint8(at + (i >> 1)) >> (i & 1 ? 0 : 4)) & 0xf);
    }
  }
  const count = sizes.length;
  const chunkOffsets: number[] = [];
  const stco = child(data, stbl, "stco");
  const co64 = child(data, stbl, "co64");
  if (stco) for (let i = 0, n = u32(stco.start + 4); i < n; i++) chunkOffsets.push(u32(stco.start + 8 + i * 4));
  else if (co64) for (let i = 0, n = u32(co64.start + 4); i < n; i++) chunkOffsets.push(Number(data.getBigUint64(co64.start + 8 + i * 8)));
  const stsc = child(data, stbl, "stsc");
  const runs: { first: number; perChunk: number }[] = [];
  if (stsc) for (let i = 0, n = u32(stsc.start + 4); i < n; i++) runs.push({ first: u32(stsc.start + 8 + i * 12) - 1, perChunk: u32(stsc.start + 12 + i * 12) });
  const offsets = new Array<number>(count);
  let sample = 0;
  for (let r = 0; r < runs.length && sample < count; r++) {
    const lastChunk = r + 1 < runs.length ? runs[r + 1].first : chunkOffsets.length;
    for (let c = runs[r].first; c < lastChunk && sample < count; c++) {
      let at = chunkOffsets[c];
      for (let k = 0; k < runs[r].perChunk && sample < count; k++) {
        offsets[sample] = at;
        at += sizes[sample++];
      }
    }
  }
  const decodeTimes = new Array<number>(count);
  const stts = child(data, stbl, "stts");
  let t = 0;
  sample = 0;
  if (stts) {
    for (let i = 0, n = u32(stts.start + 4); i < n; i++) {
      const runCount = u32(stts.start + 8 + i * 8);
      const delta = u32(stts.start + 12 + i * 8);
      for (let k = 0; k < runCount && sample < count; k++, t += delta) decodeTimes[sample++] = t;
    }
  }
  for (; sample < count; sample++) decodeTimes[sample] = t;
  const offsetsCt = new Array<number>(count).fill(0);
  const ctts = child(data, stbl, "ctts");
  if (ctts) {
    const version = data.getUint8(ctts.start);
    sample = 0;
    for (let i = 0, n = u32(ctts.start + 4); i < n; i++) {
      const runCount = u32(ctts.start + 8 + i * 8);
      const delta = version ? data.getInt32(ctts.start + 12 + i * 8) : u32(ctts.start + 12 + i * 8);
      for (let k = 0; k < runCount && sample < count; k++) offsetsCt[sample++] = delta;
    }
  }
  const stss = child(data, stbl, "stss");
  const sync = stss ? new Set(Array.from({ length: u32(stss.start + 4) }, (_, i) => u32(stss.start + 8 + i * 4) - 1)) : undefined;
  const samples: VideoSample[] = [];
  for (let i = 0; i < count; i++) {
    samples.push({
      offset: offsets[i],
      size: sizes[i],
      time: (decodeTimes[i] + offsetsCt[i] - mediaStart) / timescale,
      isSync: sync ? sync.has(i) : true,
    });
  }
  return samples;
}

/**
 * Samples of track `trackId` in a fragmented file: the moof boxes' track runs, with the movie's trex defaults.
 * Each run's data offset is relative to its tfhd base (the moof by default).
 */
async function fragmentSamples(blob: Blob, data: DataView, moov: Box, trackId: number, timescale: number, mediaStart: number): Promise<VideoSample[]> {
  let defaults = { duration: 0, size: 0, flags: 0 };
  for (const trex of children(data, child(data, moov, "mvex") ?? moov, "trex")) {
    if (data.getUint32(trex.start + 4) === trackId) defaults = { duration: data.getUint32(trex.start + 12), size: data.getUint32(trex.start + 16), flags: data.getUint32(trex.start + 20) };
  }
  const samples: VideoSample[] = [];
  let decodeTime = 0;
  let at = 0;
  while (at + 8 <= blob.size) {
    const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = blob.size - at;
    if (size < 8) break;
    if (type === "moof") {
      const moofData = new DataView(await blob.slice(at, at + size).arrayBuffer());
      const moof: Box = { type, start: 8, end: size };
      for (const traf of children(moofData, moof, "traf")) {
        const tfhd = child(moofData, traf, "tfhd");
        if (!tfhd || moofData.getUint32(tfhd.start + 4) !== trackId) continue;
        const tfFlags = moofData.getUint32(tfhd.start) & 0xffffff;
        let p = tfhd.start + 8;
        let base = at;
        if (tfFlags & 0x01) {
          base = Number(moofData.getBigUint64(p));
          p += 8;
        }
        if (tfFlags & 0x02) p += 4;
        const duration = tfFlags & 0x08 ? moofData.getUint32((p += 4) - 4) : defaults.duration;
        const sampleSize = tfFlags & 0x10 ? moofData.getUint32((p += 4) - 4) : defaults.size;
        const sampleFlags = tfFlags & 0x20 ? moofData.getUint32((p += 4) - 4) : defaults.flags;
        const tfdt = child(moofData, traf, "tfdt");
        if (tfdt) decodeTime = moofData.getUint8(tfdt.start) === 1 ? Number(moofData.getBigUint64(tfdt.start + 4)) : moofData.getUint32(tfdt.start + 4);
        let offset = base;
        for (const trun of children(moofData, traf, "trun")) {
          const version = moofData.getUint8(trun.start);
          const flags = moofData.getUint32(trun.start) & 0xffffff;
          const count = moofData.getUint32(trun.start + 4);
          let q = trun.start + 8;
          if (flags & 0x01) offset = base + moofData.getInt32((q += 4) - 4);
          const firstFlags = flags & 0x04 ? moofData.getUint32((q += 4) - 4) : undefined;
          for (let i = 0; i < count; i++) {
            const d = flags & 0x100 ? moofData.getUint32((q += 4) - 4) : duration;
            const s = flags & 0x200 ? moofData.getUint32((q += 4) - 4) : sampleSize;
            const f = flags & 0x400 ? moofData.getUint32((q += 4) - 4) : i === 0 && firstFlags !== undefined ? firstFlags : sampleFlags;
            const cto = flags & 0x800 ? (version ? moofData.getInt32((q += 4) - 4) : moofData.getUint32((q += 4) - 4)) : 0;
            // sample_is_non_sync_sample is bit 16 of the sample flags.
            samples.push({ offset, size: s, time: (decodeTime + cto - mediaStart) / timescale, isSync: (f & 0x10000) === 0 });
            offset += s;
            decodeTime += d;
          }
        }
      }
    }
    at += size;
  }
  return samples;
}

/** Reads the top-level boxes of `blob` and returns the payload of `moov`. */
async function readMoov(blob: Blob): Promise<DataView> {
  let at = 0;
  while (at + 8 <= blob.size) {
    const head = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = blob.size - at;
    if (size < 8) break;
    if (type === "moov") return new DataView(await blob.slice(at, at + size).arrayBuffer());
    at += size;
  }
  throw new Error("no movie header (moov) found");
}

const handlerOf = (data: DataView, trak: Box): string | undefined => {
  const hdlr = child(data, child(data, trak, "mdia"), "hdlr");
  return hdlr ? String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset + hdlr.start + 8, 4)) : undefined;
};

/** The sample rate (media timescale) of the first sound track of an MP4 / MOV file; 0 without one. */
export async function audioTrackRate(blob: Blob): Promise<number> {
  const data = await readMoov(blob);
  const moov: Box = { type: "moov", start: 8, end: data.byteLength };
  for (const trak of children(data, moov, "trak")) {
    if (handlerOf(data, trak) !== "soun") continue;
    const mdhd = child(data, child(data, trak, "mdia"), "mdhd");
    if (!mdhd) continue;
    return data.getUint8(mdhd.start) === 1 ? data.getUint32(mdhd.start + 20) : data.getUint32(mdhd.start + 12);
  }
  return 0;
}

/** Parses the first video track of an MP4 / MOV file. */
export async function demuxVideo(blob: Blob): Promise<VideoTrack> {
  const data = await readMoov(blob);
  const moov: Box = { type: "moov", start: 8, end: data.byteLength };
  const fragmented = !!child(data, moov, "mvex");
  for (const trak of children(data, moov, "trak")) {
    const mdia = child(data, trak, "mdia");
    if (!mdia || handlerOf(data, trak) !== "vide") continue;
    const mdhd = child(data, mdia, "mdhd")!;
    const timescale = data.getUint8(mdhd.start) === 1 ? data.getUint32(mdhd.start + 20) : data.getUint32(mdhd.start + 12);
    const stbl = child(data, child(data, mdia, "minf"), "stbl");
    const stsd = child(data, stbl, "stsd");
    if (!stbl || !stsd) continue;
    const entry = [...boxes(data, stsd.start + 8, stsd.end)][0];
    if (!entry) continue;
    const codec = codecOf(data, entry);
    if (!codec) throw new Error(`video codec "${entry.type}" is not supported`);
    // The first edit's media time is where presentation starts (B-frame delay, trimmed head).
    let mediaStart = 0;
    const elst = child(data, child(data, trak, "edts"), "elst");
    if (elst) {
      const version = data.getUint8(elst.start);
      const entries = data.getUint32(elst.start + 4);
      for (let i = 0; i < entries; i++) {
        const at = elst.start + 8 + i * (version ? 20 : 12);
        const mediaTime = version ? Number(data.getBigInt64(at + 8)) : data.getInt32(at + 4);
        if (mediaTime >= 0) {
          mediaStart = mediaTime;
          break;
        }
      }
    }
    if (!fragmented) return { ...codec, samples: sampleTable(data, stbl, timescale, mediaStart) };
    const tkhd = child(data, trak, "tkhd");
    const trackId = tkhd ? data.getUint32(tkhd.start + (data.getUint8(tkhd.start) === 1 ? 20 : 12)) : 1;
    // A fragmented file may also keep samples in the moov's own table.
    const samples = [...sampleTable(data, stbl, timescale, mediaStart), ...(await fragmentSamples(blob, data, moov, trackId, timescale, mediaStart))];
    if (!samples.length) throw new Error("the video track has no samples");
    return { ...codec, samples };
  }
  throw new Error("no video track");
}
