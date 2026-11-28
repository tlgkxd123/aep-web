// The Android app playing a project in C++ (native/android/aep_player_jni.cpp, docs/native-port.md milestone M2): the
// page hands the plugin the project's bytes once, and again after an edit, says which comp and where the playhead is,
// and lays the surface over the Preview panel. Planning, timing, rendering and presenting then run natively on the
// display's frame clock, with no plans, frames or JavaScript crossing the bridge per frame.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { toBase64 } from "./engine.ts";

/** A comp the native player can show. */
export interface NativeComp {
  id: number;
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  /** Its first frame has nothing the native engine cannot draw yet. */
  playable: boolean;
}

/** Where native playback is and what it costs. */
export interface NativePlaybackState {
  open: boolean;
  time?: number;
  frame?: number;
  frameCount?: number;
  playing?: boolean;
  /** Frames presented, frames that came due but were not shown, and frames it could not draw. */
  shown?: number;
  dropped?: number;
  unsupported?: number;
  /** Smoothed milliseconds to plan a frame and to render one. */
  planMs?: number;
  renderMs?: number;
  expressionStartupMs?: number;
}

interface NativePlayerPlugin {
  attach(options: { x: number; y: number; width: number; height: number }): Promise<void>;
  detach(): Promise<void>;
  openProject(options: { project: string; expressions?: boolean }): Promise<{ comps: NativeComp[] }>;
  closeProject(): Promise<void>;
  selectComp(options: { id: number; resolution?: number }): Promise<void>;
  setResolution(options: { resolution: number }): Promise<void>;
  setPlaying(options: { playing: boolean }): Promise<void>;
  seek(options: { time: number }): Promise<void>;
  playbackState(): Promise<NativePlaybackState>;
}

/** The native player's controls; resolution is a divisor (1 Full, 2 Half, 3 Third, 4 Quarter). */
export interface NativePlayer {
  /** Lays the player's surface over the page at a rectangle in CSS pixels; again to move it. */
  attach(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
  detach(): Promise<void>;
  /** Opens a project's .aep bytes (src/aep/write.ts after an edit), replacing the open one. */
  open(project: Uint8Array, options?: { expressions?: boolean }): Promise<NativeComp[]>;
  close(): Promise<void>;
  selectComp(id: number, resolution?: number): Promise<void>;
  setResolution(resolution: number): Promise<void>;
  setPlaying(playing: boolean): Promise<void>;
  seek(time: number): Promise<void>;
  state(): Promise<NativePlaybackState>;
}

/** The Android app's native player, or null where there is none (the web, the desktop app). */
export function nativePlayer(): NativePlayer | null {
  if (Capacitor.getPlatform() !== "android") return null;
  const plugin = registerPlugin<NativePlayerPlugin>("NativeEngine");
  return {
    attach: (rect) => plugin.attach(rect),
    detach: () => plugin.detach(),
    open: async (project, options) => (await plugin.openProject({ project: toBase64(project), expressions: options?.expressions })).comps,
    close: () => plugin.closeProject(),
    selectComp: (id, resolution = 1) => plugin.selectComp({ id, resolution }),
    setResolution: (resolution) => plugin.setResolution({ resolution }),
    setPlaying: (playing) => plugin.setPlaying({ playing }),
    seek: (time) => plugin.seek({ time }),
    state: () => plugin.playbackState(),
  };
}
