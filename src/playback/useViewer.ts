import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import { frameIndex } from "./clock.ts";
import { usePlaying } from "./playhead.ts";
import { contentGeneration, onInvalidate } from "./ramCache.ts";
import { setViewer, viewerFactors, ViewerEngine } from "./viewer.ts";

const subscribeFootage = (listener: () => void) => footageStore.subscribe(listener);
const footageVersion = () => footageStore.version;
const ignore = () => () => {};
const noVersion = () => -1;

/** Why this browser cannot render frames, or undefined when it can. */
export function missingRenderSupport(scope: { WebGL2RenderingContext?: unknown; OffscreenCanvas?: unknown }): string | undefined {
  const lacks = [!scope.WebGL2RenderingContext && "WebGL2", !scope.OffscreenCanvas && "OffscreenCanvas"].filter(Boolean);
  if (!lacks.length) return undefined;
  return `this browser has no ${lacks.join(" or ")}, so frames cannot render. Use a current Chrome, Edge, Firefox or Safari 17 or later`;
}

/**
 * Shows `comp` at `time` in the canvas through a ViewerEngine, one frame per animation frame however fast
 * `time` changes, at resolution divisor `factor`. Returns the engine (for pixel readback) and what the renderer
 * skipped. While the comp plays, playback drives the same engine directly through `getViewer`.
 */
export function useViewer(canvas: HTMLCanvasElement | null, project: Project, comp: CompItem, time: number, factor: number) {
  const engine = useRef<ViewerEngine | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const playing = usePlaying(comp.id);
  // Footage decodes asynchronously: a frame still waiting for it is shown once it arrives. Playback follows the
  // footage store itself, so the panel does not re-render for every frame decoded while playing.
  const footage = useSyncExternalStore(playing ? ignore : subscribeFootage, playing ? noVersion : footageVersion);

  /** Counts the renderers lost with their GPU context (mobile browsers drop it in the background) and recreated. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!canvas) return;
    // Browsers without WebGL2 or OffscreenCanvas keep the plain comp frame; jsdom lacks both and says nothing.
    const missing = missingRenderSupport(globalThis);
    if (missing) {
      if (!/jsdom/.test(globalThis.navigator?.userAgent ?? "")) setError(missing);
      return;
    }
    let created: ViewerEngine;
    try {
      created = new ViewerEngine(canvas);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    engine.current = created;
    const surface = created.renderer.gl.canvas;
    const lost = (e: Event) => {
      e.preventDefault();
      setError("the GPU context was lost; frames render again once the browser restores it");
    };
    const restored = () => setGeneration((g) => g + 1);
    surface.addEventListener("webglcontextlost", lost);
    surface.addEventListener("webglcontextrestored", restored);
    return () => {
      surface.removeEventListener("webglcontextlost", lost);
      surface.removeEventListener("webglcontextrestored", restored);
      created.dispose();
      if (engine.current === created) engine.current = null;
    };
  }, [canvas, generation]);

  useEffect(() => {
    if (!engine.current) return;
    setViewer(comp.id, engine.current);
    viewerFactors.set(comp.id, factor);
    return () => setViewer(comp.id, undefined);
  }, [canvas, comp.id, factor, generation]);

  useEffect(() => onInvalidate(() => setRevision(contentGeneration())), []);

  useEffect(() => {
    const viewer = engine.current;
    if (!viewer || playing) return;
    const frame = requestAnimationFrame(() => {
      try {
        viewer.attach(project, comp, factor);
        const index = frameIndex(comp, time);
        // Nothing left decoding means nothing will complete the frame: show it as it is.
        if (viewer.show(index) === "waiting" && !footageStore.busy) viewer.show(index, true);
        setNotes((prev) => (prev.join("\n") === viewer.warnings.join("\n") ? prev : viewer.warnings));
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [canvas, project, comp, time, factor, revision, footage, playing, generation]);

  return { engine, notes, error };
}
