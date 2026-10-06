/**
 * A WebM muxer for one video track, written in memory: EBML header, SeekHead, Info (with Duration),
 * Tracks, Cues, then one Cluster per keyframe. Alpha travels the way Chrome and Firefox read it: a second
 * VP8/VP9 stream whose luma is the alpha channel, stored as BlockAdditional (BlockAddID 1) of each block,
 * with AlphaMode 1 on the track.
 */

export interface WebmOptions {
  codec: "V_VP8" | "V_VP9";
  width: number;
  height: number;
  /** Microseconds per frame. */
  frameDuration: number;
  alpha: boolean;
  /** Colour signalling for the YUV data; omitted when unknown. */
  colour?: { matrix: number; transfer: number; primaries: number; fullRange: boolean };
  writingApp?: string;
  /** An Opus track (track 2) next to the video. */
  audio?: WebmAudioOptions;
}

export interface WebmAudioOptions {
  sampleRate: number;
  channels: number;
  /** The OpusHead the encoder reported. */
  codecPrivate: Uint8Array;
  /** Samples the decoder drops at the start (OpusHead pre-skip). */
  preSkip: number;
  /** Where the track ends in microseconds; the last block's samples past it are discarded. */
  endUs: number;
}

export interface WebmAudioFrame {
  data: Uint8Array;
  /** Microseconds, on the encoder's timeline (pre-skip included). */
  timestamp: number;
  duration: number;
}

export interface WebmFrame {
  data: Uint8Array;
  alpha?: Uint8Array;
  key: boolean;
  /** Presentation time in microseconds. */
  timestamp: number;
}

type Bytes = Uint8Array;

const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  MaxBlockAdditionID: 0x55ee,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AlphaMode: 0x53c0,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  BlockAdditional: 0xa5,
  DiscardPadding: 0x75a2,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
} as const;

const TRACK = 1;
const AUDIO_TRACK = 2;
/** Opus needs 80 ms of decoded audio before a seek point to converge. */
const OPUS_SEEK_PRE_ROLL_NS = 80_000_000;
/** Timestamps in milliseconds. */
const TIMECODE_SCALE = 1_000_000;

function concat(parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function idBytes(id: number): Bytes {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Uint8Array.from(out);
}

function sizeBytes(size: number): Bytes {
  let length = 1;
  while (length < 8 && size >= 2 ** (7 * length) - 1) length++;
  const out = new Uint8Array(length);
  let v = size;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function uintBytes(value: number, width = 0): Bytes {
  const out: number[] = [];
  for (let v = value; v > 0 || out.length === 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  while (out.length < width) out.unshift(0);
  return Uint8Array.from(out);
}

function el(id: number, ...children: Bytes[]): Bytes {
  const body = concat(children);
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

const uint = (id: number, value: number, width = 0) => el(id, uintBytes(value, width));
const str = (id: number, value: string) => el(id, new TextEncoder().encode(value));
function float(id: number, value: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return el(id, b);
}

function sint(id: number, value: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(value));
  return el(id, b);
}

function blockHeader(relative: number, flags: number, track = TRACK): Bytes {
  const b = new Uint8Array(4);
  b[0] = 0x80 | track;
  new DataView(b.buffer).setInt16(1, relative);
  b[3] = flags;
  return b;
}

export class WebmMuxer {
  private readonly frames: WebmFrame[] = [];
  private readonly audioFrames: WebmAudioFrame[] = [];
  private readonly options: WebmOptions;

  constructor(options: WebmOptions) {
    this.options = options;
  }

  add(frame: WebmFrame): void {
    if (this.frames.length === 0 && !frame.key) throw new Error("the first WebM frame must be a keyframe");
    if (this.options.alpha && !frame.alpha) throw new Error("alpha track frames need alpha data");
    this.frames.push(frame);
  }

  addAudio(frame: WebmAudioFrame): void {
    if (!this.options.audio) throw new Error("the muxer has no audio track");
    this.audioFrames.push(frame);
  }

  finish(): Uint8Array {
    const o = this.options;
    const ms = (us: number) => Math.round(us / 1000);
    const header = el(
      ID.EBML,
      uint(ID.EBMLVersion, 1),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
      str(ID.DocType, "webm"),
      uint(ID.DocTypeVersion, 4),
      uint(ID.DocTypeReadVersion, 2),
    );
    const last = this.frames[this.frames.length - 1];
    const durationMs = last ? (last.timestamp + o.frameDuration) / 1000 : 0;
    const info = el(
      ID.Info,
      uint(ID.TimecodeScale, TIMECODE_SCALE),
      float(ID.Duration, durationMs),
      str(ID.MuxingApp, "aep-web"),
      str(ID.WritingApp, o.writingApp ?? "aep-web"),
    );
    const video: Bytes[] = [uint(ID.PixelWidth, o.width), uint(ID.PixelHeight, o.height)];
    if (o.alpha) video.push(uint(ID.AlphaMode, 1));
    if (o.colour) {
      video.push(
        el(
          ID.Colour,
          uint(ID.MatrixCoefficients, o.colour.matrix),
          uint(ID.Range, o.colour.fullRange ? 2 : 1),
          uint(ID.TransferCharacteristics, o.colour.transfer),
          uint(ID.Primaries, o.colour.primaries),
        ),
      );
    }
    const entry: Bytes[] = [
      uint(ID.TrackNumber, TRACK),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 1),
      uint(ID.FlagLacing, 0),
      str(ID.CodecID, o.codec),
      uint(ID.DefaultDuration, Math.round(o.frameDuration * 1000)),
    ];
    if (o.alpha) entry.push(uint(ID.MaxBlockAdditionID, 1));
    entry.push(el(ID.Video, ...video));
    const trackEntries = [el(ID.TrackEntry, ...entry)];
    const a = o.audio;
    if (a) {
      trackEntries.push(
        el(
          ID.TrackEntry,
          uint(ID.TrackNumber, AUDIO_TRACK),
          uint(ID.TrackUID, 2),
          uint(ID.TrackType, 2),
          uint(ID.FlagLacing, 0),
          str(ID.CodecID, "A_OPUS"),
          el(ID.CodecPrivate, a.codecPrivate),
          uint(ID.CodecDelay, Math.round((a.preSkip / a.sampleRate) * 1e9)),
          uint(ID.SeekPreRoll, OPUS_SEEK_PRE_ROLL_NS),
          el(ID.Audio, float(ID.SamplingFrequency, a.sampleRate), uint(ID.Channels, a.channels)),
        ),
      );
    }
    const tracks = el(ID.Tracks, ...trackEntries);

    // Block times are on the encoder's timeline; the decoder drops CodecDelay, so input sample n plays at n / rate.
    const preSkipUs = a ? (a.preSkip / a.sampleRate) * 1e6 : 0;
    type Event = { video: WebmFrame; audio?: undefined; t: number } | { audio: WebmAudioFrame; video?: undefined; t: number; discardNs: number };
    const events: Event[] = this.frames.map((video) => ({ video, t: ms(video.timestamp) }));
    if (a) {
      const endUs = a.endUs + preSkipUs;
      for (const audio of this.audioFrames) {
        if (audio.timestamp >= endUs) continue;
        const over = audio.timestamp + audio.duration - endUs;
        events.push({ audio, t: ms(audio.timestamp), discardNs: over > 0 ? Math.round(over * 1000) : 0 });
      }
    }
    // Stable: at equal times a video keyframe opens the cluster before audio joins it.
    events.sort((x, y) => x.t - y.t || (x.video ? 0 : 1) - (y.video ? 0 : 1));

    const clusters: { time: number; key: boolean; bytes: Bytes }[] = [];
    let current: { time: number; key: boolean; blocks: Bytes[] } | null = null;
    let previousMs = 0;
    const flush = () => {
      if (current) clusters.push({ time: current.time, key: current.key, bytes: el(ID.Cluster, uint(ID.Timecode, current.time), ...current.blocks) });
    };
    for (const event of events) {
      const t = event.t;
      if (!current || (event.video?.key ?? false) || t - current.time > 32000) {
        flush();
        current = { time: t, key: event.video?.key ?? false, blocks: [] };
      }
      const relative = t - current.time;
      if (event.audio) {
        const block = event.discardNs
          ? el(ID.BlockGroup, el(ID.Block, blockHeader(relative, 0, AUDIO_TRACK), event.audio.data), sint(ID.DiscardPadding, event.discardNs))
          : el(ID.SimpleBlock, blockHeader(relative, 0x80, AUDIO_TRACK), event.audio.data);
        current.blocks.push(block);
        continue;
      }
      const frame = event.video;
      if (frame.alpha) {
        const group: Bytes[] = [el(ID.Block, blockHeader(relative, 0), frame.data)];
        if (!frame.key) group.push(el(ID.ReferenceBlock, uintBytes((previousMs - t) & 0xffff, 2)));
        group.push(el(ID.BlockAdditions, el(ID.BlockMore, uint(ID.BlockAddID, 1), el(ID.BlockAdditional, frame.alpha))));
        current.blocks.push(el(ID.BlockGroup, ...group));
      } else {
        current.blocks.push(el(ID.SimpleBlock, blockHeader(relative, frame.key ? 0x80 : 0), frame.data));
      }
      previousMs = t;
    }
    flush();

    const cues = (positions: number[]) =>
      el(
        ID.Cues,
        ...clusters.flatMap((c, i) =>
          c.key ? [el(ID.CuePoint, uint(ID.CueTime, c.time), el(ID.CueTrackPositions, uint(ID.CueTrack, TRACK), uint(ID.CueClusterPosition, positions[i], 8)))] : [],
        ),
      );
    const seekHead = (infoAt: number, tracksAt: number, cuesAt: number) =>
      el(
        ID.SeekHead,
        el(ID.Seek, el(ID.SeekID, idBytes(ID.Info)), uint(ID.SeekPosition, infoAt, 8)),
        el(ID.Seek, el(ID.SeekID, idBytes(ID.Tracks)), uint(ID.SeekPosition, tracksAt, 8)),
        el(ID.Seek, el(ID.SeekID, idBytes(ID.Cues)), uint(ID.SeekPosition, cuesAt, 8)),
      );
    // Positions are fixed-width, so sizes measured with zeros hold for the real values.
    const seekSize = seekHead(0, 0, 0).length;
    const cuesSize = cues(clusters.map(() => 0)).length;
    const infoAt = seekSize;
    const tracksAt = infoAt + info.length;
    const cuesAt = tracksAt + tracks.length;
    const positions: number[] = [];
    let at = cuesAt + cuesSize;
    for (const c of clusters) {
      positions.push(at);
      at += c.bytes.length;
    }
    const body = [seekHead(infoAt, tracksAt, cuesAt), info, tracks, cues(positions), ...clusters.map((c) => c.bytes)];
    const bodySize = body.reduce((n, b) => n + b.length, 0);
    return concat([header, idBytes(ID.Segment), sizeBytes(bodySize), ...body]);
  }
}
