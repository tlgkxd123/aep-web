import { createContext, useContext } from "react";
import type { Editor } from "../edit/editor.ts";
import "./layer-ops.css";

/** Toolbar tools the Composition panel acts on; the other toolbar tools only highlight. */
export type ToolId = "selection" | "rotation" | "anchor" | (string & {});

export interface Editing {
  editor?: Editor;
  /** `editor.revision`, so memoized views recompute after every edit, undo and redo. */
  revision: number;
  tool: ToolId;
  setTool?: (tool: ToolId) => void;
  /** Shows a failed edit the way AE does, in an alert. */
  report: (message: string) => void;
}

export const EditingContext = createContext<Editing>({ revision: 0, tool: "selection", report: () => {} });

export const useEditing = () => useContext(EditingContext);

/** Drag data type of a Project panel item (its id) dragged into a Timeline or Composition panel. */
export const ITEM_MIME = "application/x-aep-item";
/** Drag data type of a Timeline layer row (its id) being reordered. */
export const LAYER_MIME = "application/x-aep-layer";

let dragSerial = 0;
/** A fresh coalesce key: every event of one drag or scrub shares it, so the gesture is one undo step. */
export const nextDragKey = (kind: string) => `${kind}:${++dragSerial}`;

/** Runs an edit, reporting its error instead of throwing into React. */
export function attempt(editing: Editing, edit: () => void): void {
  try {
    edit();
  } catch (e) {
    editing.report((e as Error).message);
  }
}
