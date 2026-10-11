// Drags that follow one pointer across the window, for mouse, pen and touch alike.

interface Press {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
}

/** CSS pixels a finger travels before a touch press becomes a drag, so a tap does not nudge what it taps. */
export const TOUCH_SLOP = 6;

/**
 * Follows the pointer of `press` until it is released, or until the browser takes it over (`pointercancel`, as when
 * a touch turns into a scroll); other pointers (a second finger) are ignored. A touch press reports moves only once
 * it has travelled `slop` pixels. Returns a function that stops following without calling `onEnd`.
 */
export function followPointer(
  press: Press,
  onMove: (ev: PointerEvent) => void,
  onEnd?: (ev: PointerEvent, cancelled: boolean) => void,
  slop = TOUCH_SLOP,
): () => void {
  const threshold = press.pointerType === "touch" ? slop : 0;
  let dragging = threshold === 0;
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== press.pointerId) return;
    if (!dragging) {
      if (Math.hypot(ev.clientX - press.clientX, ev.clientY - press.clientY) < threshold) return;
      dragging = true;
    }
    onMove(ev);
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId !== press.pointerId) return;
    stop();
    onEnd?.(ev, ev.type === "pointercancel");
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  return stop;
}
