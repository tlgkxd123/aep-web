// Reads the first video track of an ISO BMFF (MP4) file: movie and media
// headers, the sample entry (avcC, colr), and the sample table resolved into
// per-sample file offsets, sizes, timestamps and sync flags.

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Decode and presentation time in track timescale units. */
  dts: number;
  cts: number;
  duration: number;
  key: boolean;
}

export interface Mp4Video {
  brand: string;
  movieTimescale: number;
  movieDuration: number;
  timescale: number;
  duration: number;
  sampleEntry: string;
  width: number;
  height: number;
  avcC?: Uint8Array;
  colr?: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
  samples: Mp4Sample[];
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function boxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
    let body = at + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      body += 8;
    } else if (size === 0) size = end - at;
    if (size < 8 || at + size > end) throw new Error(`box ${type} at ${at} overruns its parent`);
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

function child(view: DataView, parent: Box, type: string): Box {
  const found = boxes(view, parent.body, parent.end).find((b) => b.type === type);
  if (!found) throw new Error(`no ${type} in ${parent.type}`);
  return found;
}

function maybe(view: DataView, parent: Box, type: string): Box | undefined {
  return boxes(view, parent.body, parent.end).find((b) => b.type === type);
}

/** Version-aware timescale and duration of mvhd/mdhd. */
function header(view: DataView, box: Box): { timescale: number; duration: number } {
  const version = view.getUint8(box.body);
  return version === 1
    ? { timescale: view.getUint32(box.body + 20), duration: Number(view.getBigUint64(box.body + 24)) }
    : { timescale: view.getUint32(box.body + 12), duration: view.getUint32(box.body + 16) };
}

export function demuxMp4(bytes: Uint8Array): Mp4Video {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = boxes(view, 0, bytes.length);
  const ftyp = top.find((b) => b.type === "ftyp");
  if (!ftyp) throw new Error("no ftyp");
  const brand = new TextDecoder().decode(bytes.subarray(ftyp.body, ftyp.body + 4));
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Error("no moov");
  const movie = header(view, child(view, moov, "mvhd"));
  const trak = boxes(view, moov.body, moov.end)
    .filter((b) => b.type === "trak")
    .find((t) => {
      const hdlr = child(view, child(view, t, "mdia"), "hdlr");
      return new TextDecoder().decode(bytes.subarray(hdlr.body + 8, hdlr.body + 12)) === "vide";
    });
  if (!trak) throw new Error("no video track");
  const mdia = child(view, trak, "mdia");
  const media = header(view, child(view, mdia, "mdhd"));
  const stbl = child(view, child(view, mdia, "minf"), "stbl");

  const stsd = child(view, stbl, "stsd");
  const entry = boxes(view, stsd.body + 8, stsd.end)[0];
  if (!entry) throw new Error("empty stsd");
  const width = view.getUint16(entry.body + 24);
  const height = view.getUint16(entry.body + 26);
  const entryChildren = boxes(view, entry.body + 78, entry.end);
  const avcC = entryChildren.find((b) => b.type === "avcC");
  const colrBox = entryChildren.find((b) => b.type === "colr");
  let colr: Mp4Video["colr"];
  if (colrBox && new TextDecoder().decode(bytes.subarray(colrBox.body, colrBox.body + 4)) === "nclx") {
    colr = {
      primaries: view.getUint16(colrBox.body + 4),
      transfer: view.getUint16(colrBox.body + 6),
      matrix: view.getUint16(colrBox.body + 8),
      fullRange: (view.getUint8(colrBox.body + 10) & 0x80) !== 0,
    };
  }

  const stts = child(view, stbl, "stts");
  const durations: number[] = [];
  for (let i = 0, n = view.getUint32(stts.body + 4); i < n; i++) {
    const count = view.getUint32(stts.body + 8 + i * 8);
    const delta = view.getUint32(stts.body + 12 + i * 8);
    for (let k = 0; k < count; k++) durations.push(delta);
  }
  const ctts = maybe(view, stbl, "ctts");
  const offsets: number[] = [];
  if (ctts) {
    const version = view.getUint8(ctts.body);
    for (let i = 0, n = view.getUint32(ctts.body + 4); i < n; i++) {
      const count = view.getUint32(ctts.body + 8 + i * 8);
      const off = version === 1 ? view.getInt32(ctts.body + 12 + i * 8) : view.getUint32(ctts.body + 12 + i * 8);
      for (let k = 0; k < count; k++) offsets.push(off);
    }
  }
  const stsz = child(view, stbl, "stsz");
  const fixedSize = view.getUint32(stsz.body + 4);
  const sampleCount = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: sampleCount }, (_, i) => (fixedSize || view.getUint32(stsz.body + 12 + i * 4)));
  const stss = maybe(view, stbl, "stss");
  const sync = stss ? new Set(Array.from({ length: view.getUint32(stss.body + 4) }, (_, i) => view.getUint32(stss.body + 8 + i * 4) - 1)) : null;
  const stco = maybe(view, stbl, "stco");
  const co64 = maybe(view, stbl, "co64");
  const chunkOffsets: number[] = [];
  if (stco) for (let i = 0, n = view.getUint32(stco.body + 4); i < n; i++) chunkOffsets.push(view.getUint32(stco.body + 8 + i * 4));
  else if (co64) for (let i = 0, n = view.getUint32(co64.body + 4); i < n; i++) chunkOffsets.push(Number(view.getBigUint64(co64.body + 8 + i * 8)));
  else throw new Error("no chunk offsets");
  const stsc = child(view, stbl, "stsc");
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({
    firstChunk: view.getUint32(stsc.body + 8 + i * 12) - 1,
    perChunk: view.getUint32(stsc.body + 12 + i * 12),
  }));

  if (durations.length !== sampleCount) throw new Error(`stts covers ${durations.length} samples, stsz ${sampleCount}`);
  const samples: Mp4Sample[] = [];
  let index = 0;
  let dts = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && index < sampleCount; chunk++) {
    const run = [...runs].reverse().find((r) => r.firstChunk <= chunk);
    if (!run) throw new Error(`chunk ${chunk} has no stsc run`);
    let offset = chunkOffsets[chunk];
    for (let k = 0; k < run.perChunk && index < sampleCount; k++, index++) {
      const size = sizes[index];
      if (offset + size > bytes.length) throw new Error(`sample ${index} lies outside the file`);
      samples.push({ offset, size, dts, cts: dts + (offsets[index] ?? 0), duration: durations[index], key: sync ? sync.has(index) : true });
      offset += size;
      dts += durations[index];
    }
  }
  if (samples.length !== sampleCount) throw new Error(`chunks hold ${samples.length} of ${sampleCount} samples`);
  return {
    brand,
    movieTimescale: movie.timescale,
    movieDuration: movie.duration,
    timescale: media.timescale,
    duration: media.duration,
    sampleEntry: entry.type,
    width,
    height,
    avcC: avcC ? bytes.slice(avcC.body, avcC.end) : undefined,
    colr,
    samples,
  };
}
