// What the operating system hands the app: projects opened from outside it (Android's Open with and Share; the
// installed web app's file handler) and, in the Android app, the back button, memory pressure and page restarts.
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import type { MemoryPressure } from "../playback/memory.ts";
import type { ProjectHandle } from "./projectFiles.ts";

/** A copy of a file another Android app handed over, or why it could not be made. */
interface SharedFile {
  name: string;
  path?: string;
  error?: string;
}

/** Why the Android app loaded its page again: Android stopped the page to reclaim memory, or the page crashed. */
export type PageRestart = "memory" | "crash";

interface AppShellPlugin {
  addListener(event: "file", listener: (file: SharedFile) => void): Promise<PluginListenerHandle>;
  addListener(event: "back", listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: "memory", listener: (pressure: { level: string }) => void): Promise<PluginListenerHandle>;
  exit(): Promise<void>;
  restartReason(): Promise<{ reason?: string }>;
}

const PRESSURES: readonly string[] = ["hidden", "background", "low"] satisfies MemoryPressure[];
const RESTARTS: readonly string[] = ["memory", "crash"] satisfies PageRestart[];

const AppShell = registerPlugin<AppShellPlugin>("AppShell");

interface LaunchParams {
  readonly files: readonly { readonly kind: string; readonly name: string }[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void): void;
}

/** A project the system asked the app to open; `handle` (web) lets Save write back to it. */
export type LaunchedProject = { file: File; handle?: ProjectHandle } | { name: string; error: string };

let started = false;
let deliver: ((project: LaunchedProject) => void) | undefined;
const queued: LaunchedProject[] = [];

function receive(project: LaunchedProject): void {
  if (deliver) deliver(project);
  else queued.push(project);
}

async function readShared(shared: SharedFile): Promise<LaunchedProject> {
  if (!shared.path) return { name: shared.name, error: shared.error ?? "Android did not hand over the file" };
  const response = await fetch(Capacitor.convertFileSrc(`file://${shared.path}`));
  if (!response.ok) return { name: shared.name, error: `the copy of the file could not be read (${response.status})` };
  return { file: new File([await response.blob()], shared.name) };
}

function start(): void {
  if (started) return;
  started = true;
  if (Capacitor.isNativePlatform()) {
    void AppShell.addListener("file", (shared) => {
      readShared(shared).then(receive, (e: Error) => receive({ name: shared.name, error: e.message }));
    }).catch(() => {});
    return;
  }
  const launchQueue = typeof window === "undefined" ? undefined : (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  launchQueue?.setConsumer((params) => {
    const handle = (params.files.find((f) => f.kind === "file" && /\.aep$/i.test(f.name)) ?? params.files.find((f) => f.kind === "file")) as
      | ProjectHandle
      | undefined;
    if (handle) handle.getFile().then((file) => receive({ file, handle }), (e: Error) => receive({ name: handle.name, error: e.message }));
  });
}

/**
 * Hands `open` the projects the system asks the app to open, those that arrived before it was called first. Returns
 * a function that stops the delivery; projects arriving after it wait for the next `open`.
 */
export function onLaunchedProjects(open: (project: LaunchedProject) => void): () => void {
  start();
  deliver = open;
  for (const project of queued.splice(0)) open(project);
  return () => {
    if (deliver === open) deliver = undefined;
  };
}

/** Calls `onBack` for the Android back button, instead of Android closing the app. A no-op elsewhere. */
export function onBackButton(onBack: () => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  const listening = AppShell.addListener("back", onBack);
  return () => void listening.then((l) => l.remove(), () => {});
}

/** Closes the Android app. */
export function exitApp(): void {
  if (Capacitor.isNativePlatform()) void AppShell.exit().catch(() => {});
}

/** Calls `onPressure` when Android asks the app to use less memory (see MemoryPressure). A no-op elsewhere. */
export function onMemoryPressure(onPressure: (pressure: MemoryPressure) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  const listening = AppShell.addListener("memory", ({ level }) => {
    if (PRESSURES.includes(level)) onPressure(level as MemoryPressure);
  });
  return () => void listening.then((l) => l.remove(), () => {});
}

let restart: Promise<PageRestart | undefined> | undefined;

/**
 * Why the Android app loaded this page again after its last one stopped (see PageRestart); undefined after a normal
 * start and outside the app. Android tells it once per page, so every caller gets the same answer.
 */
export function pageRestart(): Promise<PageRestart | undefined> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(undefined);
  restart ??= Promise.resolve()
    .then(() => AppShell.restartReason())
    .then(
      ({ reason }) => (reason && RESTARTS.includes(reason) ? (reason as PageRestart) : undefined),
      () => undefined,
    );
  return restart;
}

/**
 * What the back button does inside the page: goes up a level of the open menu sheet, or closes the topmost sheet or
 * dialog as Escape does. False when none is open.
 */
export function dismissTopmost(root: ParentNode = document): boolean {
  const modals = root.querySelectorAll<HTMLElement>('[aria-modal="true"]');
  const top = modals[modals.length - 1];
  if (!top) return false;
  const up = top.querySelector<HTMLElement>(".sheet-back");
  if (up) up.click();
  else top.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return true;
}
