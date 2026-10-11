// The workspace of compact screens (phones, small tablets): the Composition viewer with playback controls, and one
// panel at a time beside or under it, picked from a tab bar. The panels are the desktop ones.
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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

/** How long a drag rests on a tab before the tab opens, in milliseconds. */
const SPRING_MS = 600;

/**
 * The tab bar picking the panel shown with the viewer. A drag resting on a tab opens it, so that what it carries can
 * be dropped on a panel other than the one it came from (a project item or an effect on the Timeline).
 */
export function MobileTabs({ tab, onTab }: { tab: MobileTab; onTab: (tab: MobileTab) => void }) {
  const [opening, setOpening] = useState<MobileTab>();
  const spring = useRef<{ id: MobileTab; timer: ReturnType<typeof setTimeout> }>(undefined);
  const settle = () => {
    clearTimeout(spring.current?.timer);
    spring.current = undefined;
    setOpening(undefined);
  };
  useEffect(() => () => clearTimeout(spring.current?.timer), []);
  const dragOver = (e: DragEvent, id: MobileTab) => {
    if (spring.current?.id === id) return;
    settle();
    if (id === tab || !e.dataTransfer?.types.length) return;
    spring.current = {
      id,
      timer: setTimeout(() => {
        settle();
        onTab(id);
      }, SPRING_MS),
    };
    setOpening(id);
  };
  const dragLeave = (e: DragEvent, id: MobileTab) => {
    if (spring.current?.id === id && !e.currentTarget.contains(e.relatedTarget as Node | null)) settle();
  };
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
          className={`mtab ${tab === t.id ? "active" : ""} ${opening === t.id ? "opening" : ""}`}
          onClick={() => onTab(t.id)}
          onDragEnter={(e) => dragOver(e, t.id)}
          onDragOver={(e) => dragOver(e, t.id)}
          onDragLeave={(e) => dragLeave(e, t.id)}
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
