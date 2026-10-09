import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { videoInfo } from "../extra/pmatch/frames.ts";
import { trainModel, type TrainProgress, type TrainResult } from "../extra/pmatch/pipeline.ts";
import { ModelPreview } from "../extra/pmatch/preview.ts";
import { Icon } from "./icons.tsx";
import "./particle-match.css";

interface Reference {
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
}

type Stage = { kind: "setup" } | { kind: "training"; progress: TrainProgress } | { kind: "done"; result: TrainResult };

/** Default and shortest training windows, seconds. */
const WINDOW = 30;
const MIN_WINDOW = 5;
const PREVIEW_WIDTH = 960;

const seconds = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)} s`;

/** Extra > Particle Match: learns a reference video's particles in the browser and previews the result. */
export function ParticleMatchDialog({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [reference, setReference] = useState<Reference>();
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState(String(WINDOW));
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => (reference ? () => URL.revokeObjectURL(reference.url) : undefined), [reference]);

  const pick = async (file: File) => {
    setError(undefined);
    try {
      const info = await videoInfo(file);
      const start = Math.max(0, Math.min(info.duration - WINDOW, info.duration * 0.3));
      setReference({ file, url: URL.createObjectURL(file), duration: info.duration, width: info.width, height: info.height, frameRate: info.frameRate });
      setFrom(start.toFixed(0));
      setTo(Math.min(info.duration, start + WINDOW).toFixed(0));
      setStage({ kind: "setup" });
    } catch (e) {
      setError(`Could not read "${file.name}": ${(e as Error).message}`);
    }
  };

  const a = Number(from);
  const b = Number(to);
  const windowError = !reference
    ? undefined
    : !(Number.isFinite(a) && Number.isFinite(b)) || a < 0 || b > reference.duration + 1e-6
      ? `The window must lie within 0 – ${reference.duration.toFixed(0)} s.`
      : b - a < MIN_WINDOW
        ? `Train on at least ${MIN_WINDOW} seconds.`
        : undefined;

  const train = async () => {
    if (!reference || windowError) return;
    setError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    setStage({ kind: "training", progress: { stage: "Starting", share: 0 } });
    try {
      const result = await trainModel(reference.file, reference.file.name, {
        from: a,
        to: b,
        signal: controller.signal,
        onProgress: (progress) => !controller.signal.aborted && setStage({ kind: "training", progress }),
      });
      if (!controller.signal.aborted) setStage({ kind: "done", result });
    } catch (e) {
      if (controller.signal.aborted) return;
      setStage({ kind: "setup" });
      setError((e as Error).message);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage({ kind: "setup" });
  };

  const result = stage.kind === "done" ? stage.result : undefined;
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!result || !canvas || !video) return;
    let preview: ModelPreview;
    try {
      preview = new ModelPreview(canvas, result.model, result.features);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    video.currentTime = result.model.source.train[0];
    let shown = -1;
    let frame = requestAnimationFrame(function tick() {
      if (video.currentTime !== shown) {
        shown = video.currentTime;
        preview.draw(shown);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      preview.dispose();
    };
  }, [result]);

  const close = () => {
    abortRef.current?.abort();
    onClose();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") close();
  };

  const report = result?.model.report;
  const previewHeight = reference ? Math.round((PREVIEW_WIDTH * reference.height) / reference.width) : 540;

  return (
    <div className="modal-backdrop">
      <div className={`dialog pm-dialog ${result ? "pm-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
        <h2 id={`${id}-title`}>Particle Match</h2>
        <p className="pm-intro">
          Learns the particles of a reference video (their sprites, density, outward flight and how they follow the music) and plays the
          learned model. A mirrored video is learned from its left half only.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.m4v,.mov,video/mp4,video/quicktime"
          aria-label="Reference video"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pick(file);
            e.target.value = "";
          }}
        />
        <div className="pm-row">
          <button type="button" className="ae-secondary" disabled={stage.kind === "training"} onClick={() => inputRef.current?.click()}>
            {reference ? "Choose Another Video..." : "Choose Reference Video..."}
          </button>
          {reference && (
            <span className="pm-file" title={reference.file.name}>
              {reference.file.name} · {reference.width}×{reference.height} · {reference.frameRate.toFixed(0)} fps · {seconds(reference.duration)}
            </span>
          )}
        </div>
        {reference && stage.kind !== "done" && (
          <fieldset className="pm-group" disabled={stage.kind === "training"}>
            <legend>Training window</legend>
            <div className="pm-row pm-window">
              <label className="pm-row">
                <span>From</span>
                <input className="ae-field pm-num" inputMode="decimal" aria-label="Training start (seconds)" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="dim">s</span>
              </label>
              <label className="pm-row">
                <span>To</span>
                <input className="ae-field pm-num" inputMode="decimal" aria-label="Training end (seconds)" value={to} onChange={(e) => setTo(e.target.value)} />
                <span className="dim">s</span>
              </label>
            </div>
            <p className="dim">30–60 seconds where the particles fly freely work best. Training takes about two seconds per second of video.</p>
            {windowError && <p className="pm-error">{windowError}</p>}
          </fieldset>
        )}
        {stage.kind === "training" && (
          <div className="pm-progress" role="status">
            <progress max={1} value={stage.progress.share} aria-label="Training progress" />
            <span>
              {stage.progress.stage}… {Math.round(stage.progress.share * 100)}%
            </span>
          </div>
        )}
        {result && reference && (
          <>
            <div className="pm-preview">
              <figure>
                <video ref={videoRef} src={reference.url} controls playsInline />
                <figcaption>Reference</figcaption>
              </figure>
              <figure>
                <canvas ref={canvasRef} width={PREVIEW_WIDTH} height={previewHeight} aria-label="Learned particles" />
                <figcaption>Learned particles (follow the reference's playhead and music)</figcaption>
              </figure>
            </div>
            {report && (
              <dl className="pm-report">
                <dt>Trained on</dt>
                <dd>
                  {seconds(result.model.source.train[0])} – {seconds(result.model.source.train[1])} in {seconds(report.seconds)}
                </dd>
                <dt>Particles followed</dt>
                <dd>
                  {report.tracks} tracks, {report.prototypes} learned motions, {report.sprites} sprite kinds
                </dd>
                <dt>Mirror</dt>
                <dd>{report.mirrored ? `mirrored at x = ${report.mirrorAxis.toFixed(0)}; the left half was used` : "not mirrored"}</dd>
                <dt>Music</dt>
                <dd>{report.audio ? `speed follows the sound (R² ${report.clockR2.toFixed(2)})` : "no sound track: constant speed"}</dd>
              </dl>
            )}
          </>
        )}
        {error && (
          <p className="pm-error" role="alert">
            <Icon name="warning" size={14} /> {error}
          </p>
        )}
        <div className="dialog-actions pm-actions">
          {stage.kind === "training" ? (
            <button type="button" className="ae-secondary" onClick={cancel}>
              Cancel Training
            </button>
          ) : (
            <>
              <button type="button" className="ae-secondary" onClick={close}>
                Close
              </button>
              {result ? (
                <button type="button" className="ae-primary" onClick={() => setStage({ kind: "setup" })}>
                  Train Again
                </button>
              ) : (
                <button type="button" className="ae-primary" disabled={!reference || !!windowError} onClick={() => void train()}>
                  Analyze &amp; Train
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
