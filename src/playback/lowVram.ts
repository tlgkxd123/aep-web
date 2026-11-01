// Low VRAM mode: a GPU with 2-4 GB of memory cannot hold the renderer's desktop caches (about 2.7 GiB of targets,
// layer images, shape content and coverage), so the app keeps smaller ones and the viewer renders no finer than Half
// resolution. The desktop app reads the active adapter's memory from Windows and puts it in the page (desktop/main.ts);
// browsers expose no video memory, so there the mode is turned on from the viewer's Resolution menu.
const KEY = "aep-web.lowVram";
/** The meta tag the desktop app puts the active adapter's memory in, in MiB. */
const VRAM_META = "aep-gpu-vram";
/** GPUs with at most this much memory get the mode automatically. */
const LOW_VRAM_MAX_MIB = 4096;
/** Anything smaller is a software renderer or a virtual adapter, which the mode would not help. */
const LOW_VRAM_MIN_MIB = 1024;

const listeners = new Set<() => void>();

function stored(): boolean | undefined {
  try {
    const value = globalThis.localStorage?.getItem(KEY);
    return value === "on" ? true : value === "off" ? false : undefined;
  } catch {
    return undefined;
  }
}

/** The adapter's dedicated memory as the desktop app read it, if this page was given it. */
function injectedVramMiB(): number | undefined {
  if (typeof document === "undefined") return undefined;
  const content = document.querySelector(`meta[name="${VRAM_META}"]`)?.getAttribute("content");
  const mib = content ? Number(content) : NaN;
  return Number.isFinite(mib) && mib > 0 ? mib : undefined;
}

const vramMiB = injectedVramMiB();
let active = stored() ?? (vramMiB !== undefined && vramMiB >= LOW_VRAM_MIN_MIB && vramMiB <= LOW_VRAM_MAX_MIB);

/**
 * Low VRAM mode: the viewer starts at Half resolution (or the comp's own, if coarser) and the caches keep to
 * LOW_VRAM_BUDGETS. On by default when the active GPU has 2-4 GB, and kept on or off once the user chooses.
 */
export const lowVram = {
  get on(): boolean {
    return active;
  },
  /** The active adapter's memory in MiB, when the desktop app could read it. */
  get vramMiB(): number | undefined {
    return vramMiB;
  },
  set(on: boolean): void {
    if (on === active) return;
    active = on;
    try {
      globalThis.localStorage?.setItem(KEY, on ? "on" : "off");
    } catch {
      // Not kept between sessions where storage is unavailable.
    }
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
