// Touch input where the app was built for a mouse: a long press stands for a right-click, and on what can be dragged
// it picks the thing up for an HTML drag, which mobile browsers rarely start from a finger themselves.
import { useEffect } from "react";

/** How long a finger rests before its press opens a context menu or picks up what it holds, in milliseconds. */
const HOLD_MS = 550;
/** How far a finger may drift during a press, in CSS pixels, before it counts as a drag. */
const SLOP = 10;

/** The drag data of a drag started by touch, read and written by the same handlers as the browser's own. */
export class TouchDataTransfer {
  dropEffect = "none";
  effectAllowed = "all";
  readonly files: File[] = [];
  readonly items: DataTransferItem[] = [];
  private readonly data = new Map<string, string>();
  get types(): string[] {
    return [...this.data.keys()];
  }
  setData(type: string, value: string): void {
    this.data.set(type.toLowerCase(), value);
  }
  getData(type: string): string {
    return this.data.get(type.toLowerCase()) ?? "";
  }
  clearData(type?: string): void {
    if (type === undefined) this.data.clear();
    else this.data.delete(type.toLowerCase());
  }
  setDragImage(): void {}
}

function dragEvent(type: string, dataTransfer: TouchDataTransfer, x: number, y: number, relatedTarget: Element | null = null): MouseEvent {
  const cancelable = type !== "dragleave" && type !== "dragend";
  const event = new MouseEvent(type, { bubbles: true, cancelable, clientX: x, clientY: y, relatedTarget });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

/**
 * The draggable element a press on `target` would drag, unless the press lands on a field or on something that
 * follows the finger itself (any `touch-action` other than auto or manipulation, as layer bars and scrubbable values).
 */
function dragSource(target: Element): HTMLElement | undefined {
  const source = target.closest<HTMLElement>('[draggable="true"]');
  if (!source) return undefined;
  for (let el: Element | null = target; el && el !== source; el = el.parentElement) {
    if (el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return undefined;
    const action = getComputedStyle(el).touchAction;
    if (action && action !== "auto" && action !== "manipulation") return undefined;
  }
  return source;
}

function ghostOf(source: HTMLElement): HTMLElement {
  const ghost = document.createElement("div");
  ghost.className = "touch-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  const label = source.getAttribute("aria-label") ?? source.querySelector(".cell-text")?.textContent ?? source.textContent ?? "";
  ghost.textContent = label.trim();
  document.body.appendChild(ghost);
  return ghost;
}

interface Press {
  id: number;
  x: number;
  y: number;
  target: Element;
  /** What the press would drag once held. */
  source: HTMLElement | undefined;
  /** The browser sent its own context menu event for this press. */
  native: boolean;
  /** Held long enough: moving drags `source`, lifting opens the context menu. */
  held: boolean;
}

interface Drag {
  id: number;
  source: HTMLElement;
  data: TouchDataTransfer;
  ghost: HTMLElement;
  over: Element | null;
  /** The element under the finger took the last `dragover`, so lifting drops there. */
  accepted: boolean;
  x: number;
  y: number;
}

/**
 * While `enabled`:
 * - a long touch press sends the element under it a `contextmenu` event at the finger, so the app's context menus
 *   open on touch screens. Browsers that already send one for a long press (Chrome on Android) keep theirs: a
 *   synthetic event goes out only when none came, and a late native one after it is dropped;
 * - a long press on a `draggable` element picks it up instead: moving the finger sends it `dragstart` and the
 *   elements under the finger `dragenter`, `dragover`, `dragleave` and `drop`, as a mouse drag would, while lifting
 *   it without moving opens the context menu. A drag the browser starts itself takes over.
 */
export function useLongPressGestures(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let press: Press | undefined;
    let drag: Drag | undefined;
    let synthesizedAt = -Infinity;
    const menuAt = (target: Element, x: number, y: number) => {
      if (!target.isConnected) return;
      synthesizedAt = performance.now();
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 }));
    };
    const cancel = () => {
      clearTimeout(timer);
      if (press?.held && !drag) press.source?.classList.remove("touch-drag-armed");
      press = undefined;
    };
    const update = (d: Drag, x: number, y: number) => {
      d.x = x;
      d.y = y;
      d.ghost.style.left = `${x}px`;
      d.ghost.style.top = `${y}px`;
      const under = document.elementFromPoint?.(x, y) ?? null;
      if (under !== d.over) {
        const left = d.over;
        under?.dispatchEvent(dragEvent("dragenter", d.data, x, y, left));
        left?.dispatchEvent(dragEvent("dragleave", d.data, x, y, under));
        d.over = under;
      }
      d.data.dropEffect = "none";
      d.accepted = false;
      if (under) {
        const over = dragEvent("dragover", d.data, x, y);
        under.dispatchEvent(over);
        d.accepted = over.defaultPrevented;
      }
      d.ghost.classList.toggle("refused", !d.accepted);
    };
    const startDrag = (held: Press, x: number, y: number) => {
      const source = held.source!;
      press = undefined;
      const data = new TouchDataTransfer();
      const start = dragEvent("dragstart", data, held.x, held.y);
      source.dispatchEvent(start);
      if (start.defaultPrevented || !data.types.length) {
        source.classList.remove("touch-drag-armed");
        return;
      }
      drag = { id: held.id, source, data, ghost: ghostOf(source), over: null, accepted: false, x, y };
      update(drag, x, y);
    };
    const finishDrag = (dropped: boolean) => {
      const d = drag;
      if (!d) return;
      drag = undefined;
      d.ghost.remove();
      d.source.classList.remove("touch-drag-armed");
      if (dropped && d.over?.isConnected && d.accepted) d.over.dispatchEvent(dragEvent("drop", d.data, d.x, d.y));
      else d.over?.dispatchEvent(dragEvent("dragleave", d.data, d.x, d.y));
      if (d.source.isConnected) d.source.dispatchEvent(dragEvent("dragend", d.data, d.x, d.y));
    };
    const arm = (current: Press, source: HTMLElement) => {
      clearTimeout(timer);
      current.held = true;
      source.classList.add("touch-drag-armed");
      navigator.vibrate?.(10);
    };
    const down = (e: PointerEvent) => {
      cancel();
      finishDrag(false);
      if (e.pointerType !== "touch" || !e.isPrimary || !(e.target instanceof Element)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target, source: dragSource(e.target), native: false, held: false };
      timer = setTimeout(() => {
        const current = press;
        if (!current || !current.target.isConnected) return cancel();
        if (current.source?.isConnected) return arm(current, current.source);
        press = undefined;
        if (!current.native) menuAt(current.target, current.x, current.y);
      }, HOLD_MS);
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        if (e.pointerId === drag.id) update(drag, e.clientX, e.clientY);
        return;
      }
      if (!press || e.pointerId !== press.id || Math.hypot(e.clientX - press.x, e.clientY - press.y) <= SLOP) return;
      if (press.held) startDrag(press, e.clientX, e.clientY);
      else cancel();
    };
    const end = (e: PointerEvent) => {
      if (drag) {
        if (e.pointerId === drag.id) finishDrag(e.type === "pointerup");
        return;
      }
      if (!press || e.pointerId !== press.id) return;
      const lifted = press;
      cancel();
      if (lifted.held && e.type === "pointerup") menuAt(lifted.target, lifted.x, lifted.y);
    };
    const native = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      if (drag || press?.source) {
        // The menu of a draggable press waits for the finger to lift without moving.
        e.preventDefault();
        e.stopPropagation();
        if (press?.source && !press.held) arm(press, press.source);
      } else if (press) press.native = true;
      else if (performance.now() - synthesizedAt < 1000) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const nativeDrag = (e: DragEvent) => {
      if (!e.isTrusted) return;
      cancel();
      finishDrag(false);
    };
    /** Keeps the page from scrolling under a held or dragging finger; window listeners are passive unless told otherwise. */
    const holdStill = (e: TouchEvent) => {
      if ((drag || press?.held) && e.cancelable) e.preventDefault();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("contextmenu", native, true);
    window.addEventListener("dragstart", nativeDrag, true);
    window.addEventListener("touchmove", holdStill, { capture: true, passive: false });
    return () => {
      cancel();
      finishDrag(false);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("contextmenu", native, true);
      window.removeEventListener("dragstart", nativeDrag, true);
      window.removeEventListener("touchmove", holdStill, true);
    };
  }, [enabled]);
}
