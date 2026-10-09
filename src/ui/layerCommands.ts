import type { CompItem, Layer } from "../aep/model.ts";
import type { Editor } from "../edit/editor.ts";
import { addLayer, arrangeLayer, canRemapTime, deleteLayers, duplicateLayers, setTimeRemapping, type Arrange } from "../edit/layers.ts";
import { centerAnchorPoint, centerInView, fitToComp, flipLayers, resetTransform } from "../edit/transform-ops.ts";

export type LayerCommand =
  | "undo"
  | "redo"
  | "new-solid"
  | "new-null"
  | "new-shape"
  | "new-adjustment"
  | "delete-layer"
  | "duplicate-layer"
  | "bring-to-front"
  | "bring-forward"
  | "send-backward"
  | "send-to-back"
  | "reset-transform"
  | "flip-horizontal"
  | "flip-vertical"
  | "center-anchor"
  | "center-in-view"
  | "fit-to-comp"
  | "fit-to-comp-width"
  | "fit-to-comp-height"
  | "time-remap";

const LAYER_COMMANDS = new Set<string>([
  "undo", "redo", "new-solid", "new-null", "new-shape", "new-adjustment", "delete-layer", "duplicate-layer",
  "bring-to-front", "bring-forward", "send-backward", "send-to-back", "reset-transform", "flip-horizontal",
  "flip-vertical", "center-anchor", "center-in-view", "fit-to-comp", "fit-to-comp-width", "fit-to-comp-height",
  "time-remap",
]);

export const isLayerCommand = (command: string): command is LayerCommand => LAYER_COMMANDS.has(command);

const ARRANGE: Partial<Record<LayerCommand, Arrange>> = {
  "bring-to-front": "front",
  "bring-forward": "forward",
  "send-backward": "backward",
  "send-to-back": "back",
};

interface Keys {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey?: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** AE's Windows shortcut for a layer command, if `e` is one. */
export function layerShortcut(e: Keys): LayerCommand | undefined {
  const ctrl = e.ctrlKey || !!e.metaKey;
  const key = e.key.toLowerCase();
  const bracket = e.code === "BracketRight" || key === "]" || key === "}" ? "]" : e.code === "BracketLeft" || key === "[" || key === "{" ? "[" : "";
  if (!ctrl) return !e.altKey && !e.shiftKey && (key === "delete" || key === "backspace") ? "delete-layer" : undefined;
  if (bracket && !e.altKey) {
    if (bracket === "]") return e.shiftKey ? "bring-to-front" : "bring-forward";
    return e.shiftKey ? "send-to-back" : "send-backward";
  }
  if (e.altKey && e.shiftKey) {
    if (key === "y") return "new-null";
    if (key === "h") return "fit-to-comp-width";
    if (key === "g") return "fit-to-comp-height";
    return undefined;
  }
  if (e.altKey) {
    if (key === "y") return "new-adjustment";
    if (key === "f") return "fit-to-comp";
    if (key === "t") return "time-remap";
    if (key === "home") return "center-anchor";
    return undefined;
  }
  if (e.shiftKey) return key === "z" ? "redo" : undefined;
  if (key === "z") return "undo";
  if (key === "y") return "new-solid";
  if (key === "d") return "duplicate-layer";
  if (key === "home") return "center-in-view";
  return undefined;
}

export interface LayerTarget {
  editor?: Editor;
  comp?: CompItem;
  layers: Layer[];
}

/** Whether the command can run now: the menus grey out the others. */
export function canRunLayerCommand(command: LayerCommand, { editor, comp, layers }: LayerTarget): boolean {
  if (!editor) return false;
  if (command === "undo") return !!editor.undoLabel;
  if (command === "redo") return !!editor.redoLabel;
  if (!comp) return false;
  if (command.startsWith("new-")) return true;
  if (command === "time-remap") return layers.some((l) => canRemapTime(editor.project, l));
  return layers.length > 0;
}

/**
 * Runs a layer command on the selected layers at comp time `time`. Returns the
 * layer to select afterwards (the new or duplicated layer), if any. New Solid
 * opens the Solid Settings dialog instead and is not handled here.
 */
export function runLayerCommand(command: LayerCommand, { editor, comp, layers }: LayerTarget, time: number): number | undefined {
  if (!editor) return undefined;
  if (command === "undo") return void editor.undo();
  if (command === "redo") return void editor.redo();
  if (!comp) return undefined;
  const above = layers[0];
  switch (command) {
    case "new-null":
      return addLayer(editor, comp, { kind: "null" }, { above });
    case "new-shape":
      return addLayer(editor, comp, { kind: "shape" }, { above });
    case "new-adjustment":
      return addLayer(editor, comp, { kind: "adjustment" }, { above });
    case "new-solid":
      return undefined;
    default:
  }
  if (!layers.length) return undefined;
  switch (command) {
    case "delete-layer":
      deleteLayers(editor, comp, layers, time);
      return undefined;
    case "duplicate-layer":
      return duplicateLayers(editor, comp, layers)[0];
    case "reset-transform":
      resetTransform(editor, comp, layers, time);
      break;
    case "flip-horizontal":
    case "flip-vertical":
      flipLayers(editor, comp, layers, command === "flip-horizontal" ? "horizontal" : "vertical", time);
      break;
    case "center-anchor":
      centerAnchorPoint(editor, comp, layers, time);
      break;
    case "center-in-view":
      centerInView(editor, comp, layers, time);
      break;
    case "fit-to-comp":
      fitToComp(editor, comp, layers, "both", time);
      break;
    case "fit-to-comp-width":
      fitToComp(editor, comp, layers, "width", time);
      break;
    case "fit-to-comp-height":
      fitToComp(editor, comp, layers, "height", time);
      break;
    case "time-remap": {
      // As in After Effects: on for all the selected layers unless the first one already remaps time.
      const remappable = layers.filter((l) => canRemapTime(editor.project, l));
      setTimeRemapping(editor, comp, remappable, !remappable[0]?.timeRemapEnabled);
      break;
    }
    default: {
      const how = ARRANGE[command];
      if (!how) break;
      for (const { id } of how === "back" || how === "backward" ? [...layers].reverse() : layers) {
        const layer = comp.layers.find((l) => l.id === id);
        if (layer) arrangeLayer(editor, comp, layer, how);
      }
    }
  }
  return layers[0]?.id;
}
