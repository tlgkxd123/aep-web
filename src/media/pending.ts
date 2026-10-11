// Work a render found still in progress (footage decoding, spectra computing in workers), by key, so playback
// can render a frame again once exactly that work is done instead of whenever anything changes.

interface Source {
  /** Whether the work behind a key of this source has finished (or failed: nothing will come). */
  done(key: string): boolean;
  /** Whether any of this source's work is in flight. */
  busy(): boolean;
}

const sources = new Map<string, Source>();
let collecting: Set<string> | null = null;
/** Key standing for work no key describes: whoever waits on it waits for any change. */
const UNKNOWN = "?";

export function registerPendingSource(prefix: string, source: Source): void {
  sources.set(prefix, source);
}

/** Notes, during `collectPending`, that the render needs `key` of source `prefix`; without a key, unknown work. */
export function notePending(prefix: string, key?: string): void {
  collecting?.add(key === undefined ? UNKNOWN : `${prefix}\n${key}`);
}

/**
 * Runs `render` and returns, with its result, the work it found in progress; null when some of it has no key
 * (a movie whose decoder was opening, audio decoding).
 */
export function collectPending<T>(render: () => T): { result: T; waiting: string[] | null } {
  const outer = collecting;
  const waiting = new Set<string>();
  collecting = waiting;
  try {
    const result = render();
    return { result, waiting: waiting.has(UNKNOWN) ? null : [...waiting] };
  } finally {
    collecting = outer;
    if (outer) for (const key of waiting) outer.add(key);
  }
}

/** Whether all the work `collectPending` reported has finished. */
export function pendingDone(keys: string[]): boolean {
  return keys.every((entry) => {
    const at = entry.indexOf("\n");
    return sources.get(entry.slice(0, at))?.done(entry.slice(at + 1)) ?? true;
  });
}

/** Whether any work that renders wait for is in flight. */
export function workInFlight(): boolean {
  for (const source of sources.values()) if (source.busy()) return true;
  return false;
}
