// What kind of device the page runs on, for choices that depend on it (file pickers, how fast the viewer renders).

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
