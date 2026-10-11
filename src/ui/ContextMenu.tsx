// Right-click menus. Any component opens one with `openContextMenu(event, entries)`;
// `ContextMenuHost` (mounted once by the app) draws it at the pointer, kept inside
// the window, with submenus, keyboard navigation and AE's menu styling. On compact
// screens it draws every menu as a bottom sheet whose submenus open in its place.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Icon } from "./icons.tsx";
import { useCompact } from "./responsive.ts";

export interface MenuEntry {
  label: string;
  shortcut?: string;
  /** Leaving it out disables the entry (a command this app cannot carry out yet). */
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  submenu?: MenuEntries;
}
export type MenuEntries = (MenuEntry | "-")[];

interface OpenMenu {
  x: number;
  y: number;
  entries: MenuEntries;
  /** The sheet's heading on compact screens. */
  title?: string;
}

let current: (OpenMenu & { id: number }) | null = null;
let opened = 0;
const listeners = new Set<() => void>();
const set = (menu: OpenMenu | null) => {
  current = menu && { ...menu, id: ++opened };
  for (const listener of listeners) listener();
};

export function openContextMenu(event: ReactMouseEvent | MouseEvent, entries: MenuEntries): void {
  event.preventDefault();
  event.stopPropagation();
  set({ x: event.clientX, y: event.clientY, entries });
}

/** Opens a menu under a control (popups, toolbar menus). */
export function openMenuBelow(anchor: Element, entries: MenuEntries): void {
  const r = anchor.getBoundingClientRect();
  set({ x: r.left, y: r.bottom + 2, entries });
}

/** Opens a menu as a sheet (on desktop screens, at the top left of the window), headed `title`. */
export function openMenuSheet(title: string, entries: MenuEntries): void {
  set({ x: 4, y: 28, entries, title });
}

export function closeContextMenu(): void {
  set(null);
}

// Submenus open even when all their entries are disabled, as in AE.
const enabled = (entry: MenuEntry): boolean => !entry.disabled && (!!entry.onSelect || !!entry.submenu);

function MenuList({ entries, x, y, depth, onDone }: { entries: MenuEntries; x: number; y: number; depth: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  /** A press in the menu; the click ending the long press that opened it lands under the finger and chooses nothing. */
  const pressed = useRef(false);
  const [pos, setPos] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState<number>();
  const [subAnchor, setSubAnchor] = useState({ x: 0, y: 0 });

  // Keep the menu inside the window: flip left/up when it would overflow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth ? Math.max(0, (depth ? x - width - el.parentElement!.getBoundingClientRect().width + 4 : x - width)) : x;
    const top = y + height > window.innerHeight ? Math.max(0, window.innerHeight - height - 4) : y;
    setPos({ left, top });
  }, [x, y, depth]);

  useEffect(() => {
    if (depth === 0) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [depth]);

  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? [])];
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      list[(index + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
    } else if (e.key === "ArrowLeft" && depth > 0) {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    }
  };

  return (
    <div
      ref={ref}
      className="menu-pop context-menu"
      role="menu"
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      onPointerDownCapture={() => (pressed.current = true)}
    >
      {entries.map((entry, i) =>
        entry === "-" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${openSub === i ? "sub-open" : ""}`}
            disabled={!enabled(entry)}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? openSub === i : undefined}
            aria-checked={entry.checked}
            onPointerEnter={(e) => {
              if (entry.submenu && enabled(entry)) {
                const r = e.currentTarget.getBoundingClientRect();
                setSubAnchor({ x: r.right - 2, y: r.top - 5 });
                setOpenSub(i);
              } else setOpenSub(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" && entry.submenu) {
                e.preventDefault();
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setSubAnchor({ x: r.right - 2, y: r.top - 5 });
                setOpenSub(i);
              }
            }}
            onClick={(e) => {
              if (e.detail > 0 && !pressed.current) return;
              if (entry.submenu) {
                const r = (document.activeElement as HTMLElement).getBoundingClientRect();
                setSubAnchor({ x: r.right - 2, y: r.top - 5 });
                setOpenSub(i);
                return;
              }
              closeContextMenu();
              entry.onSelect?.();
            }}
          >
            <span className="menu-check">{entry.checked && <Icon name="check" size={10} />}</span>
            <span className="menu-label">{entry.label}</span>
            <span className="menu-shortcut">{entry.shortcut}</span>
            <span className="menu-sub">{entry.submenu && <Icon name="chevronRight" size={10} />}</span>
          </button>
        ),
      )}
      {openSub !== undefined && entries[openSub] !== "-" && (entries[openSub] as MenuEntry).submenu && (
        <MenuList entries={(entries[openSub] as MenuEntry).submenu!} x={subAnchor.x} y={subAnchor.y} depth={depth + 1} onDone={() => setOpenSub(undefined)} />
      )}
    </div>
  );
}

/** A menu as a bottom sheet: one level at a time, a submenu replacing its parent until Back. */
function MenuSheet({ menu }: { menu: OpenMenu }) {
  const [levels, setLevels] = useState<{ title: string; entries: MenuEntries }[]>(() => [{ title: menu.title ?? "", entries: menu.entries }]);
  const level = levels[levels.length - 1];
  const list = useRef<HTMLDivElement>(null);
  /**
   * Set by presses that start on the backdrop or in the sheet: the click ending the long press that opened the sheet
   * lands on whatever the sheet put under the finger, and must neither close it nor choose an item.
   */
  const armed = useRef(false);
  const pressed = useRef(false);
  useEffect(() => {
    list.current?.scrollTo?.({ top: 0 });
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [levels]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeContextMenu();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="sheet-host">
      <div className="sheet-backdrop" aria-hidden="true" onPointerDown={() => (armed.current = true)} onClick={() => armed.current && closeContextMenu()} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={level.title || "Menu"} onPointerDownCapture={() => (pressed.current = true)}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          {levels.length > 1 ? (
            <button type="button" className="sheet-back" onClick={(e) => (e.detail === 0 || pressed.current) && setLevels(levels.slice(0, -1))}>
              <Icon name="chevronRight" size={12} />
              <span className="cell-text">{levels[levels.length - 2].title || "Back"}</span>
            </button>
          ) : (
            <span />
          )}
          <span className="sheet-title cell-text">{level.title}</span>
          <button type="button" className="sheet-close" aria-label="Close menu" onClick={(e) => (e.detail === 0 || pressed.current) && closeContextMenu()}>
            <Icon name="close" size={12} />
          </button>
        </div>
        <div ref={list} className="sheet-items" role="menu" aria-label={level.title || "Menu"}>
          {level.entries.map((entry, i) =>
            entry === "-" ? (
              <div key={i} className="sheet-sep" role="separator" />
            ) : (
              <button
                key={i}
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                className="sheet-item"
                disabled={!enabled(entry)}
                aria-haspopup={entry.submenu ? "menu" : undefined}
                aria-checked={entry.checked}
                onClick={(e) => {
                  // A pointer click (detail > 0) counts only from a press in the sheet; keys always do.
                  if (e.detail > 0 && !pressed.current) return;
                  if (entry.submenu) {
                    setLevels([...levels, { title: entry.label, entries: entry.submenu }]);
                    return;
                  }
                  closeContextMenu();
                  entry.onSelect?.();
                }}
              >
                <span className="sheet-check">{entry.checked && <Icon name="check" size={12} />}</span>
                <span className="sheet-label">{entry.label}</span>
                {entry.submenu ? <Icon name="chevronRight" size={12} className="sheet-more" /> : <span className="sheet-shortcut">{entry.shortcut}</span>}
              </button>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** Draws the open context menu; mount once near the root. */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
  const compact = useCompact();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu || compact) return;
    const outside = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) closeContextMenu();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && closeContextMenu();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [menu, compact]);
  if (!menu) return null;
  // Keyed by the menu, so a menu opened over another starts at its own top level.
  if (compact) return <MenuSheet key={menu.id} menu={menu} />;
  return (
    <div ref={host} className="context-host">
      <MenuList entries={menu.entries} x={menu.x} y={menu.y} depth={0} onDone={closeContextMenu} />
    </div>
  );
}
