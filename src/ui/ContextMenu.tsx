// Right-click menus. Any component opens one with `openContextMenu(event, entries)`;
// `ContextMenuHost` (mounted once by the app) draws it at the pointer, kept inside
// the window, with submenus, keyboard navigation and AE's menu styling.
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
}

let current: OpenMenu | null = null;
const listeners = new Set<() => void>();
const set = (menu: OpenMenu | null) => {
  current = menu;
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

export function closeContextMenu(): void {
  set(null);
}

// Submenus open even when all their entries are disabled, as in AE.
const enabled = (entry: MenuEntry): boolean => !entry.disabled && (!!entry.onSelect || !!entry.submenu);

function MenuList({ entries, x, y, depth, onDone }: { entries: MenuEntries; x: number; y: number; depth: number; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className="menu-pop context-menu" role="menu" style={{ position: "fixed", left: pos.left, top: pos.top }} onKeyDown={onKeyDown}>
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
            onClick={() => {
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

/** Draws the open context menu; mount once near the root. */
export function ContextMenuHost() {
  const menu = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
  );
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
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
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={host} className="context-host">
      <MenuList entries={menu.entries} x={menu.x} y={menu.y} depth={0} onDone={closeContextMenu} />
    </div>
  );
}
