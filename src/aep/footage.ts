// Footage items: the `LIST:Pin` source record (`sspc` interpretation, `opti`
// asset info, `Als2/alas` file link, sequence prefix/extension). Conventions are
// ported from py-aep (MIT, https://github.com/forticheprod/py-aep).
import { decodeOpti, decodeSspc, utf8Of, type Sspc } from "./decode.ts";
import { AlphaMode, type FootageInterpretation, type FootageItem, type FootageSource, type ImageSequence } from "./model.ts";
import { filterLists, findChild, findList, type Chunk } from "./riff.ts";

const UNDEFINED_FRAME = 0xffffffff;
const NO_ALPHA = 3;
const ALPHA_MODES: Record<number, number> = { 0: AlphaMode.STRAIGHT, 1: AlphaMode.PREMULTIPLIED, 2: AlphaMode.IGNORE };
const FIELD_ORDERS = [5612, 5614];
const FIELDS_OFF = 5613;
const PULLDOWN_OFF = 5813;
const PULLDOWN_PHASES = [5813, 5812, 5814, 5815, 5816, 5817, 5818, 5819, 5820, 5821, 5822];

type ItemBase = Pick<FootageItem, "id" | "name" | "comment" | "label" | "parentFolderId" | "chunk">;

interface Alas {
  fullpath?: string;
  target_is_folder?: boolean;
  ascendcount_target?: number;
}

/** `rateInNativeSlot`: sequences and placeholders have no rate of their own and report their assumed rate as the conform rate. */
function interpretation(sspc: Sspc | undefined, rateInNativeSlot: boolean): FootageInterpretation {
  if (!sspc) {
    return {
      hasAlpha: false, alphaMode: AlphaMode.STRAIGHT, invertAlpha: false, premulColor: [0, 0, 0], conformFrameRate: 0,
      nativeFrameRate: 0, displayFrameRate: 0, loop: 1, fieldSeparationType: FIELDS_OFF,
      highQualityFieldSeparation: false, removePulldown: PULLDOWN_OFF, isStill: true,
    };
  }
  const hasAlpha = sspc.alphaModeRaw !== NO_ALPHA;
  return {
    hasAlpha,
    // Footage without alpha reports Straight (the mode byte holds the no-alpha marker).
    alphaMode: hasAlpha ? (ALPHA_MODES[sspc.alphaModeRaw] ?? AlphaMode.IGNORE) : AlphaMode.STRAIGHT,
    invertAlpha: sspc.invertAlpha,
    premulColor: sspc.premulColor,
    conformFrameRate: rateInNativeSlot ? sspc.nativeFrameRate : sspc.conformFrameRate,
    nativeFrameRate: sspc.nativeFrameRate,
    displayFrameRate: sspc.displayFrameRate,
    loop: sspc.loop || 1,
    fieldSeparationType: sspc.fieldSeparationTypeRaw ? (FIELD_ORDERS[sspc.fieldOrder] ?? FIELD_ORDERS[0]) : FIELDS_OFF,
    highQualityFieldSeparation: sspc.highQualityFieldSeparation,
    removePulldown: PULLDOWN_PHASES[sspc.removePulldownRaw] ?? PULLDOWN_OFF,
    isStill: sspc.duration === 0,
  };
}

/** The Utf8 chunks of a Pin before its `opti`: a sequence's file-name prefix and extension come last. */
function prefixAndExtension(pin: Chunk): [string, string] | undefined {
  const children = pin.children ?? [];
  const optiIndex = children.findIndex((c) => c.type === "opti");
  const before = children.slice(0, optiIndex < 0 ? children.length : optiIndex).filter((c) => c.type === "Utf8");
  if (before.length < 2) return undefined;
  return [utf8Of(before[before.length - 2]), utf8Of(before[before.length - 1])];
}

function frameNumberOf(name: string | undefined): number | undefined {
  const m = name ? /(\d+)\D*$/.exec(name) : null;
  return m ? Number(m[1]) : undefined;
}

function joinPath(folder: string, name: string): string {
  const separator = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]$/, "")}${separator}${name}`;
}

/** The last `count` components of `path`, "/"-separated. */
function tail(path: string, count: number): string {
  if (count <= 0) return "";
  return path.split(/[\\/]/).filter(Boolean).slice(-count).join("/");
}

/** The name of frame `frame` of a sequence. */
export function sequenceFrameName(sequence: ImageSequence, frame: number): string {
  const index = frame - sequence.startFrame;
  if (sequence.fileNames.length === sequence.endFrame - sequence.startFrame + 1 && sequence.fileNames[index]) {
    return sequence.fileNames[index];
  }
  return `${sequence.prefix}${String(frame).padStart(sequence.framePadding, "0")}${sequence.extension}`;
}

function fileSource(pin: Chunk, sspc: Sspc | undefined, assetType: string, layerName: string, warn: (m: string) => void) {
  let alas: Alas = {};
  const alasChunk = findChild(findList(pin, "Als2"), "alas");
  if (alasChunk) {
    try {
      alas = JSON.parse(utf8Of(alasChunk)) as Alas;
    } catch {
      warn("has an unreadable file path record");
    }
  }
  const folder = alas.fullpath ?? "";
  const targetIsFolder = alas.target_is_folder ?? false;
  const fileNames = (findList(pin, "StVc")?.children ?? []).filter((c) => c.type === "Utf8").map(utf8Of);
  let sequence: ImageSequence | undefined;
  const affixes = prefixAndExtension(pin);
  if (targetIsFolder && sspc && (affixes || fileNames.length)) {
    const stored = (value: number, fallback: number | undefined) => (value !== UNDEFINED_FRAME ? value : (fallback ?? value));
    sequence = {
      prefix: affixes?.[0] ?? "",
      extension: affixes?.[1] ?? "",
      startFrame: stored(sspc.startFrame, frameNumberOf(fileNames[0])),
      endFrame: stored(sspc.endFrame, frameNumberOf(fileNames[fileNames.length - 1])),
      framePadding: sspc.framePadding,
      fileNames,
    };
  }
  let file = folder;
  if (fileNames.length) file = joinPath(folder, fileNames[0]);
  else if (sequence && sequence.framePadding > 0 && sequence.startFrame !== UNDEFINED_FRAME && (sequence.prefix || sequence.extension)) {
    file = joinPath(folder, sequenceFrameName(sequence, sequence.startFrame));
  }
  const fileName = file.split(/[\\/]/).pop() ?? "";
  // ascendcount_target counts the components below the folder the project and the target share (a folder target counts its frame).
  const depth = alas.ascendcount_target ?? 0;
  const relativePath = targetIsFolder ? (depth > 0 ? [tail(folder, depth - 1), fileName].filter(Boolean).join("/") : "") : tail(folder, depth);
  const source: FootageSource = {
    sourceType: "FileSource",
    file,
    fileName,
    relativePath,
    targetIsFolder,
    sequence,
    missingFootagePath: sspc?.footageMissingAtSave ? file : "",
    assetType,
    layerName,
    ...interpretation(sspc, targetIsFolder),
  };
  return source;
}

/** Image-sequence display name, e.g. `render.[0001-0700].exr`. */
function sequenceName(sequence: ImageSequence): string {
  if (sequence.startFrame === UNDEFINED_FRAME || sequence.endFrame === UNDEFINED_FRAME) return "";
  if (!sequence.prefix && !sequence.extension) return "";
  const pad = (n: number) => String(n).padStart(sequence.framePadding, "0");
  return `${sequence.prefix}[${pad(sequence.startFrame)}-${pad(sequence.endFrame)}]${sequence.extension}`;
}

export function parseFootageItem(list: Chunk, base: ItemBase, warnings: string[]): FootageItem {
  const pins = filterLists(list, "Pin ");
  const pin = pins[0];
  const sspcChunk = findChild(pin, "sspc");
  const optiChunk = findChild(pin, "opti");
  const sspc = sspcChunk ? decodeSspc(sspcChunk) : undefined;
  const opti = optiChunk ? decodeOpti(optiChunk) : undefined;
  const conformFactor = sspc && sspc.conformFrameRate ? sspc.nativeFrameRate / sspc.conformFrameRate : 1;
  const duration = sspc ? sspc.duration * conformFactor * (sspc.loop || 1) : 0;
  const warn = (message: string) => warnings.push(`footage "${base.name}" ${message}`);
  let name = base.name;
  let mainSource: FootageSource;
  if (opti?.kind === "solid") {
    mainSource = { sourceType: "SolidSource", color: opti.color, ...interpretation(sspc, false) };
    name ||= opti.name;
  } else if (opti?.kind === "placeholder") {
    mainSource = { sourceType: "PlaceholderSource", ...interpretation(sspc, true) };
    name ||= opti.name;
  } else {
    const source = fileSource(pin!, sspc, opti?.kind === "file" ? opti.assetType : "", opti?.kind === "file" ? opti.layerName : "", warn);
    if (!name && source.sequence && duration !== 0) name = sequenceName(source.sequence);
    if (!name) name = source.layerName ? `${source.layerName}/${source.fileName}` : source.fileName;
    mainSource = source;
  }
  const frameRate = sspc?.displayFrameRate ?? 0;
  // With "use proxy" on (idta byte 22, bit 0), AE reports the proxy's audio.
  const useProxy = ((findChild(list, "idta")?.data[22] ?? 0) & 1) !== 0;
  const proxySspc = useProxy && pins[1] ? findChild(pins[1], "sspc") : undefined;
  const audioSource = proxySspc ? decodeSspc(proxySspc) : sspc;
  return {
    ...base,
    name,
    kind: "footage",
    typeName: "Footage",
    width: sspc?.width ?? 0,
    height: sspc?.height ?? 0,
    duration,
    frameRate,
    // ExtendScript reports one second for footage without a rate (stills, solids).
    frameDuration: frameRate ? 1 / frameRate : 1,
    pixelAspect: sspc?.pixelAspect ?? 1,
    footageMissing: mainSource.sourceType === "PlaceholderSource" || (sspc?.footageMissingAtSave ?? false),
    hasVideo: (sspc?.width ?? 0) > 0,
    hasAudio: (audioSource?.audioSampleRate ?? 0) > 0,
    mainSource,
  };
}
