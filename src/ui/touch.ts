// Touch input where the app was built for a mouse: a long press stands for a right-click.
import { useEffect } from "react";

/** How long a finger rests before its press opens a context menu, in milliseconds. */
const HOLD_MS = 550;
/** How far a finger may drift during a press, in CSS pixels, before it counts as a drag. */
const SLOP = 10;

/**
 * While `enabled`, a long touch press sends the element under it a `contextmenu` event at the finger, so the app's
 * context menus open on touch screens. Browsers that already send one for a long press (Chrome on Android) keep
 * theirs: a synthetic event goes out only when none came, and a late native one after it is dropped.
 */
export function useLongPressMenus(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let press: { id: number; x: number; y: number; target: Element; native: boolean } | undefined;
    let synthesizedAt = -Infinity;
    const cancel = () => {
      clearTimeout(timer);
      press = undefined;
    };
    const down = (e: PointerEvent) => {
      cancel();
      if (e.pointerType !== "touch" || !e.isPrimary || !(e.target instanceof Element)) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, target: e.target, native: false };
      timer = setTimeout(() => {
        const held = press;
        press = undefined;
        if (!held || held.native || !held.target.isConnected) return;
        synthesizedAt = performance.now();
        held.target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: held.x, clientY: held.y, button: 2, buttons: 2 }));
      }, HOLD_MS);
    };
    const move = (e: PointerEvent) => {
      if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) cancel();
    };
    const end = (e: PointerEvent) => {
      if (press && e.pointerId === press.id) cancel();
    };
    const native = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      if (press) press.native = true;
      else if (performance.now() - synthesizedAt < 1000) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("contextmenu", native, true);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("contextmenu", native, true);
    };
  }, [enabled]);
}
