// How much the app keeps in memory to go faster, and giving it back when the system runs short of it. The viewers'
// pooled targets and layer caches, the RAM preview and decoded footage are all rebuilt on demand; a phone that runs
// out of memory instead stops the page, and the session with it.
import { deviceBudgets, type MemoryBudgets } from "../device.ts";
import { footageStore } from "../media/store.ts";
import { ramCache, viewerRenderers } from "./ramCache.ts";

/**
 * How short of memory the system is:
 * - "hidden": the app is out of sight; what it was using to go faster can go;
 * - "background": its page is among those the system stops first; the RAM preview goes too;
 * - "low": the system is running out of memory; the caches also keep to the constrained budgets from then on.
 */
export type MemoryPressure = "hidden" | "background" | "low";

let constrained = false;

/** The budgets the caches keep to: the device's, or its constrained ones once memory ran low (see constrainMemory). */
export function appBudgets(): MemoryBudgets {
  return deviceBudgets(constrained);
}

/** Whether the caches keep to the constrained budgets. */
export function memoryConstrained(): boolean {
  return constrained;
}

/** Keeps the caches to the device's constrained budgets for the rest of the session, shrinking them now. */
export function constrainMemory(): void {
  if (constrained) return;
  constrained = true;
  const budgets = appBudgets();
  ramCache.setBudget(budgets.ramPreview);
  footageStore.setBudget(budgets.footage);
  for (const renderer of viewerRenderers()) renderer.setBudgets(budgets);
}

/**
 * Gives back what the caches hold for `pressure`: the viewers' pooled targets, reused layer images and uploaded
 * footage, and decoded frames no render waits for, always; the open video decoders while the page is out of sight
 * (Android reclaims them from background pages anyway); the RAM preview unless the app is merely hidden.
 */
export function releaseMemory(pressure: MemoryPressure): void {
  if (pressure === "low") constrainMemory();
  for (const renderer of viewerRenderers()) renderer.releaseMemory();
  const away = pressure !== "low" || (typeof document !== "undefined" && document.visibilityState === "hidden");
  footageStore.releaseMemory(away);
  if (pressure !== "hidden") ramCache.invalidate();
}
