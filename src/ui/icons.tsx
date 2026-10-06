import type { ReactNode } from "react";
import { KeyframeInterpolationType } from "../aep/model.ts";

const F = { fill: "currentColor", stroke: "none" } as const;

/** Hand-drawn 16×16 glyphs; strokes inherit `currentColor` from the `Icon` wrapper. */
const PATHS = {
  eye: (
    <>
      <path d="M1.5 8C3 5.3 5.3 4 8 4s5 1.3 6.5 4C13 10.7 10.7 12 8 12S3 10.7 1.5 8Z" />
      <circle cx="8" cy="8" r="2" {...F} />
    </>
  ),
  speaker: (
    <>
      <path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5Z" {...F} />
      <path d="M10.2 6a3 3 0 0 1 0 4M12 4.4a5.3 5.3 0 0 1 0 7.2" />
    </>
  ),
  solo: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <circle cx="8" cy="8" r="2" {...F} />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1" {...F} />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
    </>
  ),
  tag: <path d="M2.5 4.5h7l4 3.5-4 3.5h-7Z" {...F} />,
  shy: (
    <>
      <path d="M2 11.5h12" />
      <circle cx="8" cy="5.4" r="2" />
      <path d="M4.6 11.5c.3-2 1.7-3.3 3.4-3.3s3.1 1.3 3.4 3.3" />
    </>
  ),
  shyOn: (
    <>
      <path d="M2 9.5h12" />
      <path d="M5.5 9.5a2.5 2.5 0 0 1 5 0" />
    </>
  ),
  collapse: (
    <>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" />
    </>
  ),
  qualityBest: <path d="M4 12.5 12 3.5" />,
  qualityDraft: <path d="M4 12.5 12 3.5" strokeDasharray="1.6 1.6" />,
  qualityWire: <path d="M4 12.5 12 3.5" strokeDasharray="0.4 1.8" />,
  fx: (
    <>
      <path d="M7.2 3.4c-1.3-.2-2.1.4-2.4 1.6l-1.4 7.6M3.2 7h3.2" />
      <path d="M8.2 7.2l3.6 5M11.8 7.2l-3.6 5" />
    </>
  ),
  frameBlend: (
    <>
      <rect x="2.5" y="5" width="7" height="7" rx="0.6" />
      <rect x="6.5" y="3" width="7" height="7" rx="0.6" fill="currentColor" fillOpacity="0.35" />
    </>
  ),
  motionBlur: (
    <>
      <circle cx="10.5" cy="8" r="3" {...F} />
      <path d="M1.5 6h4.5M2.5 8h4M1.5 10h4.5" />
    </>
  ),
  adjustment: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3a5 5 0 0 1 0 10Z" {...F} />
    </>
  ),
  cube: (
    <>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5Z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </>
  ),
  draft3d: (
    <>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5Z" strokeDasharray="1.5 1.3" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </>
  ),
  twirl: <path d="M5.5 3.5 10.5 8l-5 4.5Z" {...F} />,
  menu: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  zoom: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.1 10.1l3.6 3.6M5 7h4M7 5v4" />
    </>
  ),
  stopwatch: (
    <>
      <circle cx="8" cy="9" r="4.8" />
      <path d="M8 9V6.2M6.8 2.2h2.4M8 2.2v2M12 4.6l.9-.9" />
    </>
  ),
  pickwhip: (
    <path d="M8 8.2c0-.7.6-1 1.1-.8.8.3.9 1.5.1 2.1-1.1.8-2.8.2-3.1-1.2-.4-1.8 1.1-3.4 2.9-3.3 2.4.1 3.8 2.6 3 4.8-.9 2.5-4.2 3.4-6.3 1.8" />
  ),
  kfPrev: <path d="M10 4.5 5.5 8l4.5 3.5Z" {...F} />,
  kfNext: <path d="M6 4.5 10.5 8 6 11.5Z" {...F} />,
  kfDiamond: <path d="M8 4l4 4-4 4-4-4Z" />,
  folder: (
    <path
      d="M1.8 4.2c0-.5.4-.9.9-.9h3.2l1.4 1.5h5.9c.5 0 .9.4.9.9v6.6c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9Z"
      {...F}
    />
  ),
  comp: (
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2" />
      <circle cx="5.4" cy="6.4" r="1.6" fill="#d06464" stroke="none" />
      <path d="M8 11.2 10 7.4l2 3.8Z" fill="#6fb36f" stroke="none" />
      <rect x="3.9" y="9" width="2.8" height="2.4" fill="#6f8fe0" stroke="none" />
    </>
  ),
  footage: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M4.6 3v10M11.4 3v10M2 5.6h2.6M2 8h2.6M2 10.4h2.6M11.4 5.6H14M11.4 8H14M11.4 10.4H14" />
    </>
  ),
  still: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M3.5 11.5 6.5 8l2 2 1.5-1.5 2.5 3" />
      <circle cx="10.5" cy="6" r="1" {...F} />
    </>
  ),
  solid: <rect x="3" y="3" width="10" height="10" rx="1" {...F} />,
  audio: <path d="M2 8h1.2M4.4 5.6v4.8M6.8 3.5v9M9.2 6v4M11.6 4.4v7.2M14 8h-.4" />,
  placeholder: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M5 3v10M8 3v10M11 3v10" strokeOpacity="0.6" />
    </>
  ),
  text: <path d="M3.5 4h9M8 4v8.5M6.5 12.5h3" />,
  shape: <path d="M8 2.3l1.7 3.6 3.9.5-2.9 2.7.8 3.9L8 11l-3.5 2 .8-3.9-2.9-2.7 3.9-.5Z" />,
  camera: (
    <>
      <rect x="2" y="5" width="8.5" height="7" rx="1" />
      <path d="M10.5 7.5 14 5.5v6l-3.5-2" />
    </>
  ),
  light: (
    <>
      <path d="M8 2.5a3.8 3.8 0 0 0-2.2 6.9c.5.4.7.9.7 1.5h3c0-.6.2-1.1.7-1.5A3.8 3.8 0 0 0 8 2.5Z" />
      <path d="M6.5 12.6h3M7 14.2h2" />
    </>
  ),
  nullObject: <rect x="3" y="3" width="10" height="10" rx="0.5" />,
  home: <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" />,
  selection: <path d="M4 2.5v10.2l2.6-2.4 1.8 4 1.6-.7-1.8-3.9h3.5Z" {...F} />,
  hand: (
    <path d="M5.5 8.5V4.2a1 1 0 0 1 2 0v3.3M7.5 7.5V3.2a1 1 0 0 1 2 0v4.3M9.5 7.5V4.2a1 1 0 0 1 2 0v5.3c0 2.5-1.6 4-3.8 4-1.6 0-2.6-.7-3.4-2L3 9.4a1 1 0 0 1 1.6-1.1l.9 1.1" />
  ),
  orbit: (
    <>
      <path d="M3.4 6.4A5 5 0 0 1 12.8 6M12.6 9.6A5 5 0 0 1 3.2 10" />
      <path d="M12.8 3.6V6h-2.4M3.2 12.4V10h2.4" />
      <circle cx="8" cy="8" r="1.2" {...F} />
    </>
  ),
  pan: (
    <path d="M8 2v12M2 8h12M6.5 3.5 8 2l1.5 1.5M6.5 12.5 8 14l1.5-1.5M3.5 6.5 2 8l1.5 1.5M12.5 6.5 14 8l-1.5 1.5" />
  ),
  dolly: (
    <>
      <path d="M8 2.5v11M5.5 5 8 2.5 10.5 5M5.5 11 8 13.5l2.5-2.5" />
      <path d="M3 8h2M11 8h2" />
    </>
  ),
  anchor: (
    <>
      <circle cx="8" cy="8" r="3.2" />
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3" />
    </>
  ),
  rotation: (
    <>
      <path d="M12.6 8.6a4.7 4.7 0 1 1-1.5-4.2" />
      <path d="M11.8 1.9v2.9H8.9" />
    </>
  ),
  rect: <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />,
  pen: (
    <>
      <path d="M8 2.5 12 9l-2.5 4.5h-3L4 9Z" />
      <path d="M8 2.5V8" />
      <circle cx="8" cy="9" r="0.9" {...F} />
    </>
  ),
  type: <path d="M3 3.5h10M8 3.5V13M6 13h4M3 3.5V5M13 3.5V5" />,
  brush: (
    <>
      <path d="M13.5 2.5 7.5 9" />
      <path d="M7.4 9.1c-1.6-.4-3.1.6-3.3 2.2-.1 1-.6 1.6-1.6 2.2 2.6.6 5-.2 5.2-2.6" />
    </>
  ),
  clone: (
    <>
      <path d="M6 2.5h4V6l2 1.5V9H4V7.5L6 6Z" />
      <path d="M3 11.5h10M4.5 13.5h7" />
    </>
  ),
  eraser: (
    <>
      <path d="M9.5 2.8l4 4L7.3 13H4.5l-2-2Z" />
      <path d="M6.5 5.8l4 4M7.3 13H13" />
    </>
  ),
  roto: (
    <>
      <circle cx="5.5" cy="5" r="1.8" />
      <path d="M2.5 12c.3-2.3 1.5-3.7 3-3.7s2.6 1.2 2.9 3.2M13.5 2.5 9.5 7" />
    </>
  ),
  puppet: (
    <>
      <path d="M9.5 2.5l4 4-1.5.5-2.5 2.5.5 3-1 1-6-6 1-1 3 .5L9 4Z" />
      <path d="M5 11l-2.5 2.5" />
    </>
  ),
  magnet: <path d="M4 3v5a4 4 0 0 0 8 0V3H9.5v5a1.5 1.5 0 0 1-3 0V3Z" />,
  chevronDown: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  chevronRight: <path d="M6.5 4.5 10 8l-3.5 3.5" />,
  overflow: <path d="M4 4.5 7.5 8 4 11.5M8.5 4.5 12 8l-3.5 3.5" />,
  grid: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" />
    </>
  ),
  maskPath: (
    <>
      <path d="M3.2 11.8C2.4 7.4 4.6 3.6 8.2 3.6c3 0 4.8 2.3 4.4 5-.5 3-4.1 3.2-6 2.1" />
      <rect x="2.3" y="10.9" width="2" height="2" {...F} />
      <rect x="11.6" y="7.6" width="2" height="2" {...F} />
    </>
  ),
  snapshot: (
    <>
      <path d="M2.5 5.5h2.2l1.2-1.8h4.2l1.2 1.8h2.2v7h-11Z" />
      <circle cx="8" cy="9" r="2.2" />
    </>
  ),
  showSnapshot: (
    <>
      <circle cx="8" cy="5.2" r="2.3" />
      <path d="M3.5 13.5c.4-3 2.2-4.8 4.5-4.8s4.1 1.8 4.5 4.8" />
    </>
  ),
  channels: (
    <>
      <circle cx="6" cy="6.5" r="3" stroke="#e26b6b" />
      <circle cx="10" cy="6.5" r="3" stroke="#6fbf6f" />
      <circle cx="8" cy="10" r="3" stroke="#6f93e8" />
    </>
  ),
  roi: <rect x="2.5" y="3.5" width="11" height="9" strokeDasharray="2 1.5" />,
  transparency: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M2.5 2.5h3.7v3.7H2.5ZM9.8 2.5h3.7v3.7H9.8ZM6.2 6.2h3.6v3.6H6.2ZM2.5 9.8h3.7v3.7H2.5ZM9.8 9.8h3.7v3.7H9.8Z" {...F} />
    </>
  ),
  pixelAspect: (
    <>
      <rect x="2.5" y="4.5" width="11" height="7" />
      <path d="M5 8h6M6.5 6.5 5 8l1.5 1.5M9.5 6.5 11 8l-1.5 1.5" />
    </>
  ),
  fastPreview: <path d="M9 1.8 3.8 9h3.6l-.6 5.2L12.2 7H8.6Z" {...F} />,
  timeline: <path d="M2.5 4.5h7M4.5 8h9M3.5 11.5h6" />,
  flowchart: (
    <>
      <rect x="1.8" y="2.5" width="4.5" height="3.5" rx="0.5" />
      <rect x="9.7" y="6.2" width="4.5" height="3.5" rx="0.5" />
      <rect x="1.8" y="10" width="4.5" height="3.5" rx="0.5" />
      <path d="M6.3 4.2H8v7.6H6.3M8 8h1.7" />
    </>
  ),
  miniFlow: (
    <>
      <circle cx="3.5" cy="8" r="1.5" />
      <circle cx="12.5" cy="4.5" r="1.5" />
      <circle cx="12.5" cy="11.5" r="1.5" />
      <path d="M5 8h3.5M8.5 4.5v7M8.5 4.5H11M8.5 11.5H11" />
    </>
  ),
  exposure: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" fill="currentColor" fillOpacity="0.35" stroke="none" />
      <path d="M3.8 8h2.6M5.1 6.7v2.6M9.6 8h2.6" />
    </>
  ),
  alwaysPreview: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M6.5 6v4L10 8Z" {...F} />
    </>
  ),
  graphEditor: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M3.5 11.5c2.5 0 3-7 5-7s2.5 3 4 3" />
    </>
  ),
  first: (
    <>
      <path d="M3.5 3.5v9" />
      <path d="M8.5 4 4.5 8l4 4ZM13 4 9 8l4 4Z" {...F} />
    </>
  ),
  prevFrame: (
    <>
      <path d="M4.5 3.5v9" />
      <path d="M12 4 6.5 8l5.5 4Z" {...F} />
    </>
  ),
  play: <path d="M4.5 3 13 8l-8.5 5Z" {...F} />,
  stop: <rect x="4" y="4" width="8" height="8" rx="0.5" {...F} />,
  nextFrame: (
    <>
      <path d="M11.5 3.5v9" />
      <path d="M4 4l5.5 4L4 12Z" {...F} />
    </>
  ),
  last: (
    <>
      <path d="M12.5 3.5v9" />
      <path d="M3 4l4 4-4 4ZM7.5 4l4 4-4 4Z" {...F} />
    </>
  ),
  loop: (
    <path d="M3 7.5V7a3 3 0 0 1 3-3h6.5M11 2.5 12.5 4 11 5.5M13 8.5V9a3 3 0 0 1-3 3H3.5M5 10.5 3.5 12 5 13.5" />
  ),
  mountainSmall: <path d="M3.5 12 6.8 8.4l1.9 2 1.3-1.3L12.5 12Z" {...F} />,
  mountainLarge: <path d="M1.5 13.2 6 6.5l2.8 3.5 2-2.5 3.7 5.7Z" {...F} />,
  eyedropper: (
    <>
      <path d="M10.5 2.8a1.7 1.7 0 0 1 2.4 2.4l-1.4 1.4.7.7-1 1-3.6-3.6 1-1 .7.7Z" />
      <path d="M8.2 6.2 3.5 10.9v1.6h1.6l4.7-4.7" />
    </>
  ),
  crosshair: (
    <>
      <circle cx="8" cy="8" r="4.5" />
      <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" />
    </>
  ),
  link: (
    <>
      <path d="M6.8 9.2 9.2 6.8" />
      <path d="M7.6 4.6l1-1a2.6 2.6 0 0 1 3.8 3.8l-1 1M8.4 11.4l-1 1a2.6 2.6 0 0 1-3.8-3.8l1-1" />
    </>
  ),
  unlink: (
    <>
      <path d="M7.6 4.6l1-1a2.6 2.6 0 0 1 3.8 3.8l-1 1M8.4 11.4l-1 1a2.6 2.6 0 0 1-3.8-3.8l1-1" />
      <path d="M5.2 2.6l.6 1.6M2.6 5.2l1.6.6M10.8 13.4l-.6-1.6M13.4 10.8l-1.6-.6" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5 14 13H2Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.3" r="0.6" {...F} />
    </>
  ),
  effect: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d="M6.8 5c-1-.1-1.6.3-1.8 1.2l-.9 4.8M4 7.6h2.3M7.6 7.7l2.8 3.6M10.4 7.7l-2.8 3.6" />
    </>
  ),
  preset: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d="M4.5 10.5l2.2-3 2 2 2.6-4" />
    </>
  ),
  plus: <path d="M8 4v8M4 8h8" />,
  minus: <path d="M4 8h8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  alignLeft: (
    <>
      <path d="M2.5 2v12" />
      <rect x="4" y="4" width="8" height="3" {...F} />
      <rect x="4" y="9" width="5" height="3" {...F} />
    </>
  ),
  alignCenterH: (
    <>
      <path d="M8 2v12" />
      <rect x="3" y="4" width="10" height="3" {...F} />
      <rect x="5" y="9" width="6" height="3" {...F} />
    </>
  ),
  alignRight: (
    <>
      <path d="M13.5 2v12" />
      <rect x="4" y="4" width="8" height="3" {...F} />
      <rect x="7" y="9" width="5" height="3" {...F} />
    </>
  ),
  alignTop: (
    <>
      <path d="M2 2.5h12" />
      <rect x="4" y="4" width="3" height="8" {...F} />
      <rect x="9" y="4" width="3" height="5" {...F} />
    </>
  ),
  alignMiddle: (
    <>
      <path d="M2 8h12" />
      <rect x="4" y="3" width="3" height="10" {...F} />
      <rect x="9" y="5" width="3" height="6" {...F} />
    </>
  ),
  alignBottom: (
    <>
      <path d="M2 13.5h12" />
      <rect x="4" y="4" width="3" height="8" {...F} />
      <rect x="9" y="7" width="3" height="5" {...F} />
    </>
  ),
  textLeft: <path d="M2.5 4h11M2.5 6.7h7M2.5 9.3h11M2.5 12h7" />,
  textCenter: <path d="M2.5 4h11M4.5 6.7h7M2.5 9.3h11M4.5 12h7" />,
  textRight: <path d="M2.5 4h11M6.5 6.7h7M2.5 9.3h11M6.5 12h7" />,
  textJustify: <path d="M2.5 4h11M2.5 6.7h11M2.5 9.3h11M2.5 12h7" />,
  chunk: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M5 6h6M5 8h6M5 10h4" />
    </>
  ),
  trash: <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9M6.8 6.8v4.6M9.2 6.8v4.6" />,
  interpret: (
    <>
      <rect x="2" y="3" width="9" height="8" rx="1" />
      <path d="M4.2 3v8M8.8 3v8" />
      <circle cx="11.5" cy="11.5" r="2.5" {...F} />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[name]}
    </svg>
  );
}

const { BEZIER, HOLD } = KeyframeInterpolationType;

function half(type: number, auto: boolean, side: "in" | "out"): string {
  const left = side === "in";
  if (type === HOLD) return left ? "M1 1H6V11H1Z" : "M6 1H11V11H6Z";
  if (type === BEZIER && auto) return left ? "M6 1A5 5 0 0 0 6 11Z" : "M6 1A5 5 0 0 1 6 11Z";
  if (type === BEZIER) return left ? "M1 1H6V11H1L6 6Z" : "M11 1H6V11H11L6 6Z";
  return left ? "M6 .5 .5 6 6 11.5Z" : "M6 .5 11.5 6 6 11.5Z";
}

/**
 * AE's keyframe glyph: each half shows one side's interpolation — diamond for linear,
 * hourglass for bezier ease, circle for auto-bezier, square for hold.
 */
export function KeyframeGlyph({ inType, outType, autoBezier }: { inType: number; outType: number; autoBezier: boolean }) {
  return (
    <svg className="kf-glyph" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d={half(inType, autoBezier, "in")} />
      <path d={half(outType, autoBezier, "out")} />
    </svg>
  );
}
