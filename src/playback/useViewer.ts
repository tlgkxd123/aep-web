import { useEffect, useRef, useState } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { frameIndex } from "./clock.ts";
import { contentGeneration, onInvalidate } from "./ramCache.ts";
import { setViewer, viewerFactors, ViewerEngine } from "./viewer.ts";

/**
 * Shows `comp` at `time` in the canvas through a ViewerEngine, one frame per animation frame however fast
 * `time` changes, at resolution divisor `factor`. Returns the engine (for pixel readback) and what the renderer
 * skipped. Playback drives the same engine directly through `getViewer`.
 */
export function useViewer(canvas: HTMLCanvasElement | null, project: Project, comp: CompItem, time: number, factor: number) {
  const engine = useRef<ViewerEngine | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    // jsdom and browsers without WebGL2 or OffscreenCanvas keep the plain comp frame.
    if (!canvas || typeof WebGL2RenderingContext === "undefined" || typeof OffscreenCanvas === "undefined") return;
    try {
      engine.current = new ViewerEngine(canvas);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    return () => {
      engine.current?.dispose();
      engine.current = null;
    };
  }, [canvas]);

  useEffect(() => {
    if (!engine.current) return;
    setViewer(comp.id, engine.current);
    viewerFactors.set(comp.id, factor);
    return () => setViewer(comp.id, undefined);
  }, [canvas, comp.id, factor]);

  useEffect(() => onInvalidate(() => setRevision(contentGeneration())), []);

  useEffect(() => {
    const viewer = engine.current;
    if (!viewer) return;
    const frame = requestAnimationFrame(() => {
      try {
        viewer.attach(project, comp, factor);
        viewer.show(frameIndex(comp, time));
        setNotes((prev) => (prev.join("\n") === viewer.warnings.join("\n") ? prev : viewer.warnings));
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [canvas, project, comp, time, factor, revision]);

  return { engine, notes, error };
}
