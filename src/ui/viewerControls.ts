// The View menu's link to the Composition viewer, whose zoom and overlays are its own state: the menu sends
// commands, and the viewer publishes the settings the menu shows checked.

export type ViewerCommand = "zoom-in" | "zoom-out" | "toggle-grid" | "toggle-layer-controls";

export interface ViewerStatus {
  grid: boolean;
  layerControls: boolean;
}

const handlers = new Set<(command: ViewerCommand) => void>();
const statusListeners = new Set<() => void>();
let status: ViewerStatus = { grid: false, layerControls: true };

export const viewerControls = {
  /** Registers the viewer that carries out commands; returns the unregistration. */
  handle(handler: (command: ViewerCommand) => void): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  },
  /** Whether a viewer is there to carry out commands. */
  get available(): boolean {
    return handlers.size > 0;
  },
  send(command: ViewerCommand): void {
    for (const handler of handlers) handler(command);
  },
  get status(): ViewerStatus {
    return status;
  },
  publish(next: ViewerStatus): void {
    if (next.grid === status.grid && next.layerControls === status.layerControls) return;
    status = next;
    for (const listener of statusListeners) listener();
  },
  subscribe(listener: () => void): () => void {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
};
