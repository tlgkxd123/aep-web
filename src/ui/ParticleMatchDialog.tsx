import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { videoInfo } from "../extra/pmatch/frames.ts";
import { decodeModel, encodeModel, type ParticleWorldModel } from "../extra/pmatch/model.ts";
import { trainModel, type TrainProgress } from "../extra/pmatch/pipeline.ts";
import { ModelPreview } from "../extra/pmatch/preview.ts";
import { fileSound, type Sound } from "../extra/pmatch/soundtrack.ts";
import { devServerTrainer } from "../extra/pmatch/trainer.ts";
import { Icon } from "./icons.tsx";
import { defaultChoices, locateFile, ParticleMatchExport, type ExportChoices, type ExportReference, type ParticleMatchProject } from "./ParticleMatchExport.tsx";
import { clockText, FreeClock, loudnessOf, ParticleMatchTimeline, type Transport } from "./ParticleMatchTimeline.tsx";
import { saveFileBytes } from "./projectFiles.ts";
import { isMobileOS } from "./responsive.ts";
import "./projectOps.css";
import "./particle-match.css";

export type { ParticleMatchProject } from "./ParticleMatchExport.tsx";

/** Default and shortest training windows, seconds. */
const WINDOW = 30;
const MIN_WINDOW = 5;
/** The loop a model plays in without its reference, seconds. */
const FREE_DURATION = 30;
const VIDEO_ACCEPT = ".mp4,.m4v,.mov,video/mp4,video/quicktime";
const MODEL_EXTENSION = ".pmwm";

type View = "setup" | "training" | "result" | "export";

interface Session {
  reference?: ExportReference;
  from: string;
  to: string;
  model?: ParticleWorldModel;
  view: View;
  choices?: ExportChoices;
  /** The reference's playhead, seconds. */
  time?: number;
}

/** The window's session when it last closed: models stay until the page is left. */
let saved: Session = { from: "0", to: String(WINDOW), view: "setup" };

/** Sound tracks being read, by file, so a window reopened mid-read picks the read up again. */
const soundReads = new WeakMap<File, Promise<Sound | null>>();
function readSound(file: File): Promise<Sound | null> {
  let read = soundReads.get(file);
  if (!read) soundReads.set(file, (read = fileSound(file).catch(() => null)));
  return read;
}

/** Training stages by the share of the run they end at (pipeline.ts: analysis, PyTorch, calibration). */
const PHASES = [
  { until: 0.5, label: "Analyze the video", hint: "Finding and following the particles" },
  { until: 0.75, label: "Train the model", hint: "PyTorch on this machine's GPU" },
  { until: Infinity, label: "Calibrate", hint: "Matching the learned particles to the video" },
];

const seconds = (v: number) => String(Math.round(v * 10) / 10);
const baseName = (name: string) => name.replace(/\.[^./\\]+$/, "");
const extensionOf = (name: string) => (/\.([^./\\]+)$/.exec(name)?.[1] ?? "").toLowerCase();
const soundOf = (state: ExportReference["sound"] | undefined) => (state && state !== "reading" ? state : null);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** About how long each training stage (PHASES) takes on this machine for a window of `windowSeconds`, seconds. */
const stageSeconds = (windowSeconds: number) => [2 + 0.25 * windowSeconds, 11, 13];
const trainingSeconds = (windowSeconds: number) => stageSeconds(windowSeconds).reduce((sum, s) => sum + s, 0);
const roughly = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.round(s / 60)} min`);

function play(video: HTMLVideoElement): void {
  try {
    void Promise.resolve(video.play()).catch(() => {});
  } catch {
    // The browser refused to play (no media yet); the play button stays available.
  }
}

/** Each sprite of the model as an image: its light, tinted, over black. */
function spriteImages(model: ParticleWorldModel): string[] {
  const { size, count, data, tint } = model.sprites;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return [];
  }
  if (!context) return [];
  const images: string[] = [];
  for (let k = 0; k < count; k++) {
    const image = context.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const light = Math.max(0, Math.min(1, data[k * size * size + i]));
      for (let c = 0; c < 3; c++) image.data[i * 4 + c] = Math.round(255 * Math.min(1, light * tint[k * 3 + c]));
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    images.push(canvas.toDataURL());
  }
  return images;
}

function TrainingSteps({ progress, started, windowSeconds }: { progress: TrainProgress; started: number; windowSeconds: number }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, (now - started) / 1000);
  const share = progress.share;
  const current = PHASES.findIndex((p) => share < p.until);
  // The stages' shares of the progress are not their shares of the time: what is left is what the stages
  // still ahead usually take, scaled by how this run has gone so far.
  const expected = stageSeconds(windowSeconds);
  const bounds = [0, ...PHASES.map((p) => Math.min(1, p.until))];
  const done = expected.reduce((sum, s, i) => sum + s * Math.max(0, Math.min(1, (share - bounds[i]) / (bounds[i + 1] - bounds[i]))), 0);
  const left = share > 0.02 && share < 1 && done > 0 ? (elapsed / done) * (trainingSeconds(windowSeconds) - done) : null;
  return (
    <div className="pm-training">
      <ol className="pm-steps">
        {PHASES.map((p, i) => (
          <li key={p.label} className={i < current ? "done" : i === current ? "active" : ""}>
            <span className="pm-step-mark" aria-hidden="true">
              {i < current && <Icon name="check" size={11} />}
            </span>
            <span className="pm-step-text">
              <span>{p.label}</span>
              <span className="dim">{i === current ? `${progress.stage}…` : p.hint}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="pm-progress" role="status">
        <progress max={1} value={share} aria-label="Training progress" />
        <span>
          {progress.stage}… {Math.round(share * 100)}%
        </span>
      </div>
      <p className="pm-hint">
        {clockText(elapsed)} elapsed{left !== null && ` · about ${roughly(left)} left`}
      </p>
    </div>
  );
}

function ModelFacts({ model }: { model: ParticleWorldModel }) {
  const sprites = useMemo(() => spriteImages(model), [model]);
  const { report, trainer, source } = model;
  const ratio = (ours?: number, theirs?: number) => (ours && theirs ? `${Math.round((100 * ours) / theirs)} %` : null);
  const density = ratio(report.countModel, report.countReference);
  const light = ratio(report.peakModel, report.peakReference);
  const size = ratio(report.spreadModel, report.spreadReference);
  return (
    <>
      {sprites.length > 0 && (
        <div className="pm-sprites" role="group" aria-label="Learned sprites">
          {sprites.map((src, k) => (
            <img key={k} src={src} alt="" width={36} height={36} />
          ))}
        </div>
      )}
      <dl className="pm-report">
        <dt>Trained on</dt>
        <dd>
          <span className="pm-file" title={source.name}>
            {source.name}
          </span>
          <span className="dim">
            {clockText(source.train[0], true)} – {clockText(source.train[1], true)}
            {report.seconds ? `, in ${clockText(report.seconds)}` : ""}
          </span>
        </dd>
        <dt>Model</dt>
        <dd>
          {trainer.framework === "pytorch" ? "PyTorch" : trainer.framework || "unknown"} {trainer.version} on {trainer.deviceName || trainer.device || "an unknown device"}
        </dd>
        {report.tracks !== undefined && (
          <>
            <dt>Particles</dt>
            <dd>
              {report.tracks.toLocaleString("en-US")} followed, {(report.prototypes ?? 0).toLocaleString("en-US")} learned motions, {report.sprites ?? model.sprites.count} sprite kinds
            </dd>
          </>
        )}
        {density && light && size && (
          <>
            <dt>Against the video</dt>
            <dd>
              {density} as many on screen, {light} as bright, {size} as large
            </dd>
          </>
        )}
        <dt>Mirror</dt>
        <dd>{source.mirrorAxis === null ? "Not mirrored" : `Mirrored at x = ${Math.round(source.mirrorAxis)}; learned from the left half`}</dd>
        <dt>Music</dt>
        <dd>{report.audio === 0 ? "No sound track: a constant speed" : `Speed follows the sound${report.clockR2 !== undefined ? ` (fit R² ${report.clockR2.toFixed(2)})` : ""}`}</dd>
      </dl>
    </>
  );
}

/**
 * Extra > Particle Match: a window that learns a reference video's particles (the browser analyses them, the
 * PyTorch trainer behind the dev server learns the world model, the browser calibrates it), plays the learned
 * particles beside the reference, saves and opens models, and exports them to Trapcode Particular. Its
 * session (reference, training window, model, export choices) is kept when it closes.
 */
export function ParticleMatchDialog({ onClose, project }: { onClose: () => void; project?: ParticleMatchProject }) {
  const id = useId();
  const trainer = useMemo(() => devServerTrainer(), []);
  const [reference, setReference] = useState(saved.reference);
  const [from, setFrom] = useState(saved.from);
  const [to, setTo] = useState(saved.to);
  const [model, setModel] = useState(saved.model);
  const [view, setView] = useState<View>(saved.view);
  const [choices, setChoices] = useState(saved.choices);
  const [progress, setProgress] = useState<TrainProgress>({ stage: "Starting", share: 0 });
  const [started, setStarted] = useState(0);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dropping, setDropping] = useState(false);
  const [url, setUrl] = useState<string>();
  const windowRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Where the reference goes once its video has loaded. */
  const pendingSeek = useRef<number | null>(saved.reference ? (saved.time ?? Number(saved.from)) : null);
  const timeRef = useRef(saved.time ?? 0);

  const latest = useRef<Session>(saved);
  latest.current = { reference, from, to, model, view: view === "training" ? "setup" : view === "export" ? "result" : view, choices };
  useEffect(() => {
    windowRef.current?.focus();
    return () => {
      abortRef.current?.abort();
      saved = { ...latest.current, time: timeRef.current };
    };
  }, []);

  useEffect(() => {
    if (!reference) return setUrl(undefined);
    const objectUrl = URL.createObjectURL(reference.file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [reference?.file]);

  useEffect(() => {
    if (reference?.sound !== "reading") return;
    const file = reference.file;
    let live = true;
    void readSound(file).then((sound) => live && setReference((r) => (r?.file === file ? { ...r, sound } : r)));
    return () => void (live = false);
  }, [reference]);

  const hasVideo = !!reference;
  const transport = useMemo<Transport>(() => {
    const free = new FreeClock(FREE_DURATION);
    const video = () => (hasVideo ? videoRef.current : null);
    return {
      time: () => (hasVideo ? (video()?.currentTime ?? 0) : free.time()),
      playing: () => (hasVideo ? !!video() && !video()!.paused && !video()!.ended : free.playing()),
      seek: (t) => {
        const v = video();
        if (v) v.currentTime = t;
        else if (!hasVideo) free.seek(t);
      },
      setPlaying: (playing) => {
        const v = video();
        if (!hasVideo) free.setPlaying(playing);
        else if (v && playing) play(v);
        else v?.pause();
      },
    };
  }, [hasVideo]);

  const sound = soundOf(reference?.sound);
  const features = sound?.features ?? null;
  const loudness = useMemo(() => (sound ? loudnessOf(sound.features) : null), [sound]);
  const showLearned = !!model && (view === "result" || view === "export");
  // The learned particles play at the reference's own resolution, as the effect renders them.
  const [previewWidth, previewHeight] = reference ? [reference.width, reference.height] : model ? [model.source.width, model.source.height] : [1920, 1080];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!showLearned || !model || !canvas) return;
    let preview: ModelPreview;
    try {
      preview = new ModelPreview(canvas, model, features);
    } catch (e) {
      setError(`The preview cannot run: ${message(e)}`);
      return;
    }
    let shown = NaN;
    let frame = requestAnimationFrame(function tick() {
      const t = transport.time();
      if (t !== shown) {
        shown = t;
        preview.draw(t);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      preview.dispose();
    };
  }, [showLearned, model, features, transport, previewWidth, previewHeight]);

  const a = Number(from);
  const b = Number(to);
  const windowError = !reference
    ? undefined
    : from.trim() === "" || to.trim() === "" || !(Number.isFinite(a) && Number.isFinite(b)) || a < 0 || b > reference.duration + 1e-6
      ? `The window must lie within 0 – ${seconds(reference.duration)} s.`
      : b - a < MIN_WINDOW
        ? `Train on at least ${MIN_WINDOW} seconds.`
        : undefined;
  const trainedHere = !!model && !!reference && model.source.name === reference.file.name;
  const range =
    view === "setup" || view === "training"
      ? reference && !windowError
        ? { from: a, to: b }
        : null
      : trainedHere
        ? { from: model.source.train[0], to: model.source.train[1] }
        : null;

  const setWindow = (start: number, end: number) => {
    setFrom(seconds(start));
    setTo(seconds(end));
  };

  const pickVideo = async (file: File) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const info = await videoInfo(file);
      void locateFile(file);
      transport.setPlaying(false);
      setReference({ file, width: info.width, height: info.height, frameRate: info.frameRate, duration: info.duration, sound: "reading" });
      const suggested = Math.max(0, Math.min(info.duration - WINDOW, info.duration * 0.3));
      const [start, end] = model && model.source.name === file.name ? model.source.train : [suggested, Math.min(info.duration, suggested + WINDOW)];
      setWindow(start, end);
      pendingSeek.current = start;
      if (!model) setView("setup");
    } catch (e) {
      setError(`Could not read “${file.name}”: ${message(e)} Choose an MP4 or MOV video.`);
    }
  };

  const openModel = async (file: File) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const opened = decodeModel(new Uint8Array(await file.arrayBuffer()));
      setModel(opened);
      setView("result");
      if (reference?.file.name === opened.source.name) {
        setWindow(opened.source.train[0], opened.source.train[1]);
        transport.seek(opened.source.train[0]);
      }
    } catch (e) {
      setError(`Could not open “${file.name}”: ${message(e)}`);
    }
  };

  const dropFile = (file: File) => {
    const extension = extensionOf(file.name);
    if (`.${extension}` === MODEL_EXTENSION) void openModel(file);
    else if (["mp4", "m4v", "mov"].includes(extension)) void pickVideo(file);
    else setError(`“${file.name}” is neither a video (MP4, MOV) nor a Particle Match model (${MODEL_EXTENSION}).`);
  };

  const train = async () => {
    if (!reference || windowError || !trainer) return;
    setError(undefined);
    setNotice(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    transport.setPlaying(false);
    setProgress({ stage: "Starting", share: 0 });
    setStarted(performance.now());
    setView("training");
    const state = reference.sound;
    try {
      const result = await trainModel(reference.file, reference.file.name, {
        from: a,
        to: b,
        trainer,
        signal: controller.signal,
        features: state === "reading" ? undefined : (state?.features ?? null),
        onProgress: (p) => !controller.signal.aborted && setProgress(p),
      });
      if (controller.signal.aborted) return;
      setModel(result.model);
      setView("result");
      transport.seek(result.model.source.train[0]);
    } catch (e) {
      if (controller.signal.aborted) return;
      setView("setup");
      setError(`Training failed: ${message(e)}`);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setView("setup");
  };

  const saveModel = async () => {
    if (!model) return;
    setError(undefined);
    try {
      const name = await saveFileBytes(encodeModel(model), baseName(model.source.name) || "Particle Match model", "Particle Match model", MODEL_EXTENSION);
      if (name) setNotice(`Saved “${name}”.`);
    } catch (e) {
      setError(`Could not save the model: ${message(e)}`);
    }
  };

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (view !== "training") close();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.matches("input:not([type=checkbox]):not([type=radio]), select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " " && !target.matches("button, input") && (reference || showLearned)) {
      e.preventDefault();
      transport.setPlaying(!transport.playing());
      return;
    }
    const letter = e.key.toLowerCase();
    if ((letter === "b" || letter === "n") && view === "setup" && reference) {
      // B and N set the window's start and end at the playhead, as they set the work area's.
      e.preventDefault();
      const t = Math.min(reference.duration, Math.max(0, transport.time()));
      const start = Number.isFinite(a) ? a : 0;
      const end = Number.isFinite(b) ? b : reference.duration;
      if (letter === "b") setWindow(t, end - t >= MIN_WINDOW ? end : Math.min(reference.duration, t + WINDOW));
      else setWindow(t - start >= MIN_WINDOW ? start : Math.max(0, t - WINDOW), t);
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dragHandlers = {
    onDragEnter: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (view !== "training") setDropping(true);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = view === "training" ? "none" : "copy";
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDropping(false);
      const file = e.dataTransfer.files?.[0];
      if (file && view !== "training") dropFile(file);
    },
  };

  const chooseVideo = () => videoInputRef.current?.click();
  const chooseModel = () => modelInputRef.current?.click();

  const trainerNote = !trainer && (
    <p className="pm-note">
      Training runs the PyTorch trainer through the app's development server: start the app with <code>npm run dev</code> (uv installs PyTorch on first use). A model
      trained earlier, or with <code>node scripts/pmatch-train.ts</code>, can still be opened.
    </p>
  );
  const alerts = (
    <>
      {error && (
        <p className="pm-error" role="alert">
          <Icon name="warning" size={14} /> {error}
        </p>
      )}
      {notice && (
        <p className="pm-done" role="status">
          <Icon name="check" size={14} /> {notice}
        </p>
      )}
    </>
  );

  let side: ReactNode;
  if (view === "export" && model) {
    side = (
      <ParticleMatchExport
        model={model}
        reference={reference}
        project={project}
        choices={choices ?? defaultChoices(model, reference, project)}
        onChoices={setChoices}
        onBack={() => setView("result")}
        onDone={close}
      />
    );
  } else if (view === "training") {
    side = (
      <>
        <div className="pm-side-body">
          <h3>Training</h3>
          <p className="pm-file dim" title={reference?.file.name}>
            {reference?.file.name}, {seconds(a)} – {seconds(b)} s
          </p>
          <TrainingSteps progress={progress} started={started} windowSeconds={b - a} />
        </div>
        <div className="pm-side-foot">
          <div className="pm-actions">
            <button type="button" className="ae-secondary" onClick={cancel}>
              Cancel Training
            </button>
          </div>
        </div>
      </>
    );
  } else if ((view === "result" || view === "export") && model) {
    side = (
      <>
        <div className="pm-side-body">
          <h3>Learned particles</h3>
          {!reference && (
            <p className="pm-hint">
              Playing without the reference, at a constant speed.{" "}
              <button type="button" className="pm-link" onClick={chooseVideo}>
                Choose the reference video…
              </button>{" "}
              to compare and to hear the particles follow its music.
            </p>
          )}
          <ModelFacts model={model} />
        </div>
        <div className="pm-side-foot">
          {alerts}
          <div className="pm-actions pm-actions-grid">
            <button type="button" className="ae-primary" onClick={() => setView("export")}>
              Export to Particular…
            </button>
            <button type="button" className="ae-secondary" onClick={() => void saveModel()}>
              Save Model…
            </button>
            <button
              type="button"
              className="ae-secondary"
              onClick={() => {
                setNotice(undefined);
                setView("setup");
              }}
            >
              {reference ? "Train Again" : "Train a New Model"}
            </button>
          </div>
        </div>
      </>
    );
  } else if (reference) {
    side = (
      <>
        <div className="pm-side-body">
          <section className="pm-section">
            <h4>Reference</h4>
            <p className="pm-file" title={reference.file.name}>
              {reference.file.name}
            </p>
            <p className="dim">
              {reference.width} × {reference.height} · {Math.round(reference.frameRate * 100) / 100} fps · {clockText(reference.duration)} ·{" "}
              {reference.sound === "reading" ? "reading the sound…" : reference.sound ? "with sound" : "no sound"}
            </p>
            {reference.sound === null && <p className="pm-hint">Without a sound track the learned particles move at a constant speed.</p>}
            <button type="button" className="pm-link" onClick={chooseVideo}>
              Choose another video…
            </button>
          </section>
          <fieldset className="pm-section">
            <legend>Training window</legend>
            <div className="pm-window-fields">
              <label>
                <span>From</span>
                <input className="ae-field pm-num" inputMode="decimal" aria-label="Training start (seconds)" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="dim">s</span>
              </label>
              <label>
                <span>To</span>
                <input className="ae-field pm-num" inputMode="decimal" aria-label="Training end (seconds)" value={to} onChange={(e) => setTo(e.target.value)} />
                <span className="dim">s</span>
              </label>
            </div>
            {windowError ? (
              <p className="pm-field-error">{windowError}</p>
            ) : (
              <p className="pm-hint">
                {seconds(b - a)} s of video; training takes about {roughly(trainingSeconds(b - a))}.
              </p>
            )}
            <p className="pm-hint">
              Drag the window's ends on the strip below the video, or press <kbd>B</kbd> and <kbd>N</kbd> at the playhead, as for the work area. 30–60 seconds where
              the particles fly freely work best; a mirrored video is learned from its left half.
            </p>
          </fieldset>
          {trainerNote}
        </div>
        <div className="pm-side-foot">
          {alerts}
          <div className="pm-actions">
            {model ? (
              <button type="button" className="ae-secondary" onClick={() => setView("result")}>
                Back to Result
              </button>
            ) : (
              <button type="button" className="ae-secondary" onClick={chooseModel}>
                Open Model…
              </button>
            )}
            <button type="button" className="ae-primary" disabled={!!windowError || !trainer} onClick={() => void train()}>
              Analyze &amp; Train
            </button>
          </div>
        </div>
      </>
    );
  } else {
    side = (
      <>
        <div className="pm-side-body">
          <h3>Recreate the particles of a video</h3>
          <p>
            Particle Match learns how a video's particles look, move and follow its music, plays them back beside the video, and rebuilds them as Trapcode Particular layers.
          </p>
          <ol className="pm-howto">
            <li>Choose a reference video, with its music.</li>
            <li>Mark 30–60 seconds where the particles fly freely.</li>
            <li>Train, compare, then export to Particular.</li>
          </ol>
          {trainerNote}
        </div>
        <div className="pm-side-foot">
          {alerts}
          <div className="pm-actions">
            <button type="button" className="ae-secondary" onClick={chooseModel}>
              Open Model…
            </button>
            <button type="button" className="ae-primary" onClick={chooseVideo}>
              Choose Video…
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="modal-backdrop" {...dragHandlers}>
      <div
        ref={windowRef}
        className={`ae-window pm-window ${dropping ? "dropping" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="ae-window-title">
          <h2 id={`${id}-title`}>Particle Match</h2>
          <button
            type="button"
            className="ae-window-close"
            aria-label="Close"
            title={view === "training" ? "Cancel the training to close" : "Close (Esc)"}
            disabled={view === "training"}
            onClick={close}
          >
            <Icon name="close" size={10} />
          </button>
        </div>
        <div className="pm-body">
          <div className="pm-viewer">
            <div className={`pm-stage ${reference && showLearned ? "split" : ""}`}>
              {reference && (
                <div className="pm-pane">
                  <figure className="pm-frame" style={{ "--ratio": reference.width / reference.height } as CSSProperties}>
                    <video
                      ref={videoRef}
                      src={url}
                      playsInline
                      preload="auto"
                      onClick={() => transport.setPlaying(!transport.playing())}
                      onLoadedMetadata={(e) => {
                        if (pendingSeek.current === null) return;
                        e.currentTarget.currentTime = pendingSeek.current;
                        pendingSeek.current = null;
                      }}
                      onTimeUpdate={(e) => void (timeRef.current = e.currentTarget.currentTime)}
                      onSeeked={(e) => void (timeRef.current = e.currentTarget.currentTime)}
                    />
                    <figcaption>Reference</figcaption>
                  </figure>
                </div>
              )}
              {showLearned && (
                <div className="pm-pane">
                  <figure className="pm-frame" style={{ "--ratio": previewWidth / previewHeight } as CSSProperties}>
                    <canvas ref={canvasRef} width={previewWidth} height={previewHeight} aria-label="Learned particles" />
                    <figcaption>Learned particles</figcaption>
                  </figure>
                </div>
              )}
              {!reference && !showLearned && (
                <div className="pm-drop">
                  <Icon name="footage" size={30} />
                  <p className="pm-drop-title">Drop a reference video here</p>
                  <p className="dim">MP4 or MOV, with its soundtrack. A trained model ({MODEL_EXTENSION}) can be dropped too.</p>
                  <button type="button" className="ae-secondary" onClick={chooseVideo}>
                    Choose Video…
                  </button>
                </div>
              )}
              {dropping && (
                <div className="pm-drop-veil" aria-hidden="true">
                  <span>Drop a video or a model</span>
                </div>
              )}
            </div>
            {(reference || showLearned) && (
              <ParticleMatchTimeline
                transport={transport}
                duration={reference?.duration ?? FREE_DURATION}
                range={range}
                onRange={view === "setup" ? setWindow : undefined}
                minRange={MIN_WINDOW}
                loudness={loudness}
                disabled={view === "training"}
              />
            )}
          </div>
          <aside className="pm-side" aria-label="Particle Match steps">
            {side}
          </aside>
        </div>
        <input
          ref={videoInputRef}
          type="file"
          accept={VIDEO_ACCEPT}
          aria-label="Reference video"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickVideo(file);
            e.target.value = "";
          }}
        />
        <input
          ref={modelInputRef}
          type="file"
          accept={isMobileOS() ? undefined : MODEL_EXTENSION}
          aria-label="Trained model"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openModel(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
