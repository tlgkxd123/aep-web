// Keylight's core keying model, fitted to After Effects' renders of colour
// palettes (scripts/fxextra-fit-keylight.ts). Shared by the effect shader
// (keylight.ts mirrors it in GLSL) and the fitting script.

export interface KeylightSettings {
  /** View popup: 5 = Screen Matte, 10 = Intermediate Result, 11 = Final Result. */
  view: number;
  unpremultiply: boolean;
  /** Screen colour, straight RGB 0-1. */
  screen: number[];
  /** Screen Gain / 100. */
  gain: number;
  /** Screen Balance / 100. */
  balance: number;
  /** Clip Black / Clip White, 0-1. */
  clipBlack: number;
  clipWhite: number;
  /** Source Alpha popup: 1 = Ignore, 3 = Normal. */
  sourceAlpha: number;
  /** Replace Colour (Soft Colour replace method), straight RGB 0-1. */
  replace: number[];
}

/** Index of the screen colour's strongest channel and the two others, in the order Screen Balance weights them. */
export function screenChannels(screen: number[]): [number, number, number] {
  const p = screen[1] > screen[0] && screen[1] >= screen[2] ? 1 : screen[2] > screen[0] && screen[2] > screen[1] ? 2 : 0;
  return [p, (p + 1) % 3, (p + 2) % 3];
}

/** Premultiplied RGBA in, premultiplied RGBA out (0-1). */
export function keylightPixel(pixel: number[], s: KeylightSettings): number[] {
  const a = pixel[3];
  const p = pixel.slice(0, 3);
  const straight = p.map((v) => (a > 0 ? v / a : 0));
  const [ip, ia, ib] = screenChannels(s.screen);
  const sat = (c: number[]) => c[ip] - (s.balance * c[ia] + (1 - s.balance) * c[ib]);
  const screenSat = sat(s.screen);
  // Share of the screen colour in the pixel; removing it leaves the (premultiplied) foreground,
  // and the matte is at least that foreground's strongest channel.
  const k = screenSat > 0 ? Math.max(0, sat(straight) / screenSat) : 0;
  // Screen Gain scales the screen colour's chroma by the gain and its grey level by the gain squared.
  const mean = (s.screen[0] + s.screen[1] + s.screen[2]) / 3;
  const screen = s.screen.map((v) => s.gain * v + s.gain * (s.gain - 1) * mean);
  const fg = straight.map((v, i) => v - k * screen[i]);
  let matte = Math.max(1 - s.gain * s.gain * k, ...fg);
  const raw = Math.min(1, Math.max(0, matte));
  matte = s.clipWhite > s.clipBlack ? Math.min(1, Math.max(0, (raw - s.clipBlack) / (s.clipWhite - s.clipBlack))) : raw >= s.clipBlack ? 1 : 0;
  if (s.view === 5) return [matte, matte, matte, 1];
  // Soft Colour: where clipping raised the matte, some replace colour is added, weighted by the screen share.
  const soft = Math.max(0, matte - raw) * k * raw * (s.sourceAlpha === 1 ? 1 : a);
  const alpha = s.sourceAlpha === 1 ? matte : matte * a;
  let colour: number[];
  if (s.view === 10) colour = p.map((v) => v * matte);
  else {
    // With Source Alpha = Ignore the straight colour is keyed as if opaque.
    const source = s.sourceAlpha === 1 ? straight : p;
    const kp = screenSat > 0 ? Math.max(0, sat(source) / screenSat) : 0;
    const d = source.map((v, i) => Math.max(0, v - kp * screen[i]));
    // The despilled colour is premultiplied by the matte already; Unpremultiply Result keeps it
    // as the output's premultiplied colour, and without it the output is multiplied by the alpha again.
    // Where clipping lowers the matte, the foreground fades with it.
    const fade = raw > 0 ? Math.min(1, matte / raw) : 0;
    colour = d.map((v) => v * fade * (s.unpremultiply ? 1 : alpha));
  }
  const softColour = s.view === 11 && matte > 0 ? soft / matte : 0;
  return [...colour.map((v, i) => Math.min(alpha, v + softColour * s.replace[i])), alpha];
}
