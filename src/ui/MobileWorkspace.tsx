// The workspace of compact screens (phones, small tablets): the Composition viewer with playback controls, and one
// panel at a time beside or under it, picked from a tab bar. The panels are the desktop ones.
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { CompItem } from "../aep/model.ts";
import { Icon, type IconName } from "./icons.tsx";
import { followPointer } from "./pointer.ts";
import { TimeDisplay } from "./TimelinePanel.tsx";

export type MobileTab = "project" | "timeline" | "controls" | "effects" | "render" | "more";

const MOBILE_TABS: { id: MobileTab; label: string; title: string; icon: IconName }[] = [
  { id: "project", label: "Project", title: "Project", icon: "folder" },
  { id: "timeline", label: "Timeline", title: "Timeline", icon: "timeline" },
  { id: "controls", label: "Controls", title: "Effect Controls", icon: "fx" },
  { id: "effects", label: "Effects", title: "Effects & Presets", icon: "effect" },
  { id: "render", label: "Render", title: "Render Queue", icon: "render" },
  { id: "more", label: "More", title: "More panels", icon: "more" },
];

/** The tab bar picking the panel shown with the viewer. */
export function MobileTabs({ tab, onTab }: { tab: MobileTab; onTab: (tab: MobileTab) => void }) {
  return (
    <nav className="mtabs" role="tablist" aria-label="Panels">
      {MOBILE_TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`mtab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls="mpanel"
          aria-label={t.title}
          className={`mtab ${tab === t.id ? "active" : ""}`}
          onClick={() => onTab(t.id)}
        >
          <Icon name={t.icon} size={20} />
          <span className="mtab-label" aria-hidden="true">
            {t.label}
          </span>
        </button>
      ))}
    </nav>
  );
}

/** Playback under the viewer: the current time, first, previous, play, next and last frame. */
export function Transport({
  comp,
  time,
  playing,
  onPlay,
  onStep,
  onEdge,
  onTime,
}: {
  comp: CompItem;
  time: number;
  playing: boolean;
  onPlay: () => void;
  onStep: (frames: number) => void;
  onEdge: (end: boolean) => void;
  onTime: (t: number) => void;
}) {
  const button = (icon: IconName, label: string, onClick: () => void, className = "") => (
    <button type="button" className={`mtransport-btn ${className}`} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={className === "mtransport-play" ? 22 : 18} />
    </button>
  );
  return (
    <div className="mtransport" role="toolbar" aria-label="Playback">
      <span className="mtransport-time">
        <TimeDisplay comp={comp} time={time} onTime={onTime} title="Current time (tap to edit)" />
      </span>
      <span className="mtransport-buttons">
        {button("first", "First Frame", () => onEdge(false), "mtransport-edge")}
        {button("prevFrame", "Previous Frame", () => onStep(-1))}
        {button(playing ? "pause" : "play", playing ? "Stop" : "Play", onPlay, "mtransport-play")}
        {button("nextFrame", "Next Frame", () => onStep(1))}
        {button("last", "Last Frame", () => onEdge(true), "mtransport-edge")}
      </span>
    </div>
  );
}

const MIN_SHARE = 0.2;
const MAX_SHARE = 0.8;
const clampShare = (share: number) => Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));

/**
 * The viewer and the active tab's panel, under it or (`landscape`) beside it, split by a handle that moves the
 * viewer's `share` of the space.
 */
export function MobileWorkspace({
  viewer,
  panel,
  tab,
  landscape,
  share,
  onShare,
}: {
  viewer: ReactNode;
  panel: ReactNode;
  tab: MobileTab;
  landscape: boolean;
  share: number;
  onShare: (share: number) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const onGrip = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    followPointer(e, (ev) => onShare(clampShare(landscape ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height)), undefined, 0);
  };
  const onGripKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowUp: -0.05, ArrowLeft: -0.05, ArrowDown: 0.05, ArrowRight: 0.05 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    onShare(clampShare(share + step));
  };
  return (
    <main ref={root} className={`mws ${landscape ? "landscape" : ""}`} style={{ "--viewer": `${share * 100}%` } as CSSProperties}>
      <section className="mws-viewer" aria-label="Composition viewer">
        {viewer}
      </section>
      <div
        className="mws-grip"
        role="separator"
        tabIndex={0}
        aria-orientation={landscape ? "vertical" : "horizontal"}
        aria-label="Resize viewer"
        aria-valuemin={MIN_SHARE * 100}
        aria-valuemax={MAX_SHARE * 100}
        aria-valuenow={Math.round(share * 100)}
        onPointerDown={onGrip}
        onKeyDown={onGripKey}
      />
      <section className="mws-panel" id="mpanel" role="tabpanel" aria-labelledby={`mtab-${tab}`}>
        {panel}
      </section>
    </main>
  );
}
