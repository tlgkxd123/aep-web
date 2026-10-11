// What kind of device the page runs on, for choices that depend on it (file pickers, how fast the viewer renders,
// how much it keeps in memory).

const matches = (query: string): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/**
 * Android, iOS and iPadOS. Their system file pickers show only files of the types a page asks for, and grey out
 * extensions they have no type for, as .aep and .pmwm are.
 */
export const isMobileOS = (): boolean =>
  typeof navigator !== "undefined" &&
  (/Android|iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Phones and tablets: a mobile OS, or a touch screen with no mouse or trackpad. Their GPUs are the slow ones. */
export const isMobileDevice = (): boolean => isMobileOS() || (matches("(pointer: coarse)") && !matches("(any-pointer: fine)"));

/** The device's memory in GiB as the browser reports it (Chrome rounds it down to a power of two, at most 8), if it does. */
export function deviceMemoryGiB(): number | undefined {
  const gib = (globalThis.navigator as { deviceMemory?: unknown } | undefined)?.deviceMemory;
  return typeof gib === "number" && gib > 0 ? gib : undefined;
}

/** The most bytes each of the app's caches may hold; everything in them is rebuilt on demand. */
export interface MemoryBudgets {
  /** Unused 8-bit render targets a renderer keeps pooled between frames. */
  targets: number;
  /** Unused float render targets a renderer keeps pooled between frames. */
  floatTargets: number;
  /** Layer images a renderer reuses between frames. */
  layers: number;
  /** Shape layers' drawn content a renderer keeps, for layers whose image has to be made again. */
  shapes: number;
  /** Adjustment layers' coverage a renderer reuses between frames. */
  coverage: number;
  /** Rendered frames of the RAM preview. */
  ramPreview: number;
  /** Decoded footage frames. */
  footage: number;
}

const MIB = 1024 * 1024;

/**
 * The cache budgets for a device. Desktops keep the sizes the renderer was tuned with, and an eighth of their memory
 * (at most 1 GiB) for the RAM preview. A phone or tablet shares its memory with the GPU and the system, and Android
 * stops a page that holds too much: there the budgets follow the device's memory, about an eighth of it in all.
 * `constrained` (after Android stopped the page, or reported memory running low) halves that, on any device.
 */
export function memoryBudgets(device: { memoryGiB?: number; mobile: boolean; constrained?: boolean }): MemoryBudgets {
  const gib = Math.min(8, Math.max(0.25, device.memoryGiB ?? (device.mobile ? 4 : 8)));
  if (!device.mobile && !device.constrained) {
    return {
      targets: 1024 * MIB,
      floatTargets: 1024 * MIB,
      layers: 320 * MIB,
      shapes: 320 * MIB,
      coverage: 64 * MIB,
      ramPreview: Math.min(1024, gib * 128) * MIB,
      footage: 384 * MIB,
    };
  }
  const perGib = (device.constrained ? 0.5 : 1) * gib * MIB;
  return {
    targets: 20 * perGib,
    floatTargets: 20 * perGib,
    layers: 20 * perGib,
    shapes: 16 * perGib,
    coverage: 4 * perGib,
    ramPreview: 28 * perGib,
    footage: 20 * perGib,
  };
}

/** This device's budgets (see memoryBudgets). */
export function deviceBudgets(constrained = false): MemoryBudgets {
  return memoryBudgets({ memoryGiB: deviceMemoryGiB(), mobile: isMobileDevice(), constrained });
}
