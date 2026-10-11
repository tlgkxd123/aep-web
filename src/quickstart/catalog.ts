// The Quick Start templates the Home screen and File > New > New Project from Template
// offer: music visualizer projects built around the user's song (build.ts).

export type QuickStartId = "trap-nation-2018" | "trap-nation-2020";

/** Colours as 0xRRGGBB, shared by the built project and the previews. */
export interface QuickStartPalette {
  /** The stacked spectra, back to front. */
  spectra: number[];
  /** The gradient behind, centre then edges, when no background image is given. */
  background: [number, number];
  /** The circle's gradient, centre then edge, when no logo or background image is given. */
  logo: [number, number];
  particles: number;
}

export interface QuickStartTemplate {
  id: QuickStartId;
  name: string;
  /** One line on what the template looks like. */
  summary: string;
  palette: QuickStartPalette;
}

export const QUICK_START_TEMPLATES: readonly QuickStartTemplate[] = [
  {
    id: "trap-nation-2018",
    name: "Trap Nation 2018",
    summary: "A white, gold and orange spectrum ring around your logo that pumps with the bass, over drifting particles.",
    palette: { spectra: [0xff8000, 0xffb400, 0xffffff], background: [0x22305a, 0x05070d], logo: [0x3c4f86, 0x10162a], particles: 0xffffff },
  },
  {
    id: "trap-nation-2020",
    name: "Trap Nation 2020",
    summary: "A smooth glowing ring bent from a straight spectrum, with neon echoes, a blurred background and particles, at 60 fps.",
    palette: { spectra: [0xff2d95, 0x8c3cff, 0x00d9ff, 0xffffff], background: [0x2b0f45, 0x060309], logo: [0x5a2a8a, 0x170a26], particles: 0xbdefff },
  },
];

export const quickStartTemplate = (id: string): QuickStartTemplate | undefined => QUICK_START_TEMPLATES.find((t) => t.id === id);
