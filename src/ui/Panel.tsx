import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

export interface PanelTab {
  id: string;
  title: ReactNode;
  /** Plain name for the close and menu buttons. */
  name: string;
  onClose?: () => void;
}

/** One docked frame: a strip of tabs over the front panel's body, outlined in blue while focused. */
export function PanelFrame({
  tabs,
  active,
  onSelect,
  focused,
  onFocus,
  className = "",
  children,
}: {
  tabs: PanelTab[];
  active: string;
  onSelect: (id: string) => void;
  focused: boolean;
  onFocus: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`frame ${focused ? "focused" : ""} ${className}`} onPointerDownCapture={onFocus} onFocusCapture={onFocus}>
      <div className="frame-tabs" role="tablist">
        {tabs.map((tab) => {
          const front = tab.id === active;
          return (
            <div key={tab.id} className={`frame-tab ${front ? "front" : ""}`}>
              {tab.onClose && (
                <button type="button" className="tab-close" aria-label={`Close ${tab.name}`} onClick={tab.onClose}>
                  <Icon name="close" size={10} />
                </button>
              )}
              <button type="button" role="tab" aria-selected={front} className="tab-label" onClick={() => onSelect(tab.id)}>
                {tab.title}
              </button>
              {front && (
                <span className="tab-menu" aria-hidden="true">
                  <Icon name="menu" size={12} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="frame-body" role="tabpanel">
        {children}
      </div>
    </section>
  );
}

/** A panel inside a stacked group: a header bar that collapses or reveals the panel. */
export function StackedPanel({
  name,
  open,
  onToggle,
  grow = false,
  children,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`stack-panel ${open ? "open" : ""} ${open && grow ? "grow" : ""}`} aria-label={name}>
      <button type="button" className="stack-head" aria-expanded={open} onClick={onToggle}>
        <span className="stack-name">{name}</span>
        {open && <Icon name="menu" size={12} className="stack-menu" />}
      </button>
      {open && <div className="stack-body">{children}</div>}
    </section>
  );
}
