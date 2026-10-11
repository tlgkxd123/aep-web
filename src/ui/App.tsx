import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import type { CompItem, Item, Layer, Project } from "../aep/model.ts";
import { catalogCategories, catalogName } from "../edit/effectCatalog.ts";
import { applyLibraryEffect, definedEffects, effectSource, projectEffect } from "../edit/effectLibrary.ts";
import { Editor, type LayerSwitch } from "../edit/editor.ts";
import { addLayer } from "../edit/layers.ts";
import { nudgeLayers } from "../edit/transform-ops.ts";
import { audioPreview } from "../media/audioPreview.ts";
import { loadLocalFootage, localFootageAvailable } from "../media/localFootage.ts";
import { playhead } from "../playback/playhead.ts";
import { appRenderOptions, setSapphireLookalikes, useRenderOptionsVersion } from "../playback/renderOptions.ts";
import { DEFAULT_PREVIEW, usePlayback, type PreviewSettings } from "../playback/usePlayback.ts";
import { ContextMenuHost } from "./ContextMenu.tsx";
import { AppActionsContext, type AppActions } from "./contextMenus.ts";
import { ChunkPanel } from "./ChunkPanel.tsx";
import { CompositionPanel } from "./CompositionPanel.tsx";
import { EditingContext, type Editing, type ToolId } from "./editing.tsx";
import { EffectControlsPanel } from "./EffectControlsPanel.tsx";
import { EffectsPresetsPanel, useEffectLibrary } from "./EffectsPresetsPanel.tsx";
import { HomeScreen } from "./HomeScreen.tsx";
import { Icon } from "./icons.tsx";
import { canRunLayerCommand, isLayerCommand, layerShortcut, runLayerCommand, type LayerCommand, type LayerTarget } from "./layerCommands.ts";
import { addDroppedFootage, locateFootageFolder, useFootageVersion } from "./LocateFootage.tsx";
import { APPLY_EFFECT, MenuBar, type MenuCommand } from "./MenuBar.tsx";
import { MobileTabs, MobileWorkspace, Transport, type MobileTab } from "./MobileWorkspace.tsx";
import { PanelFrame, type PanelTab } from "./Panel.tsx";
import { droppedHandle, pickProjectHandle, type ProjectHandle } from "./projectFiles.ts";
import { layerEffects } from "./properties.ts";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { RenderQueuePanel } from "./RenderQueuePanel.tsx";
import { renderQueue } from "../export/queue.ts";
import { isMobileOS, LANDSCAPE_QUERY, useCompact, useMedia } from "./responsive.ts";
import { dismissTopmost, exitApp, onBackButton, onLaunchedProjects } from "./system.ts";
import { RightPanels } from "./RightPanels.tsx";
import { SolidSettings } from "./SolidSettings.tsx";
import { TimelinePanel } from "./TimelinePanel.tsx";
import { Toolbar, type Workspace } from "./Toolbar.tsx";
import { followPointer } from "./pointer.ts";
import { useLongPressMenus } from "./touch.ts";

/** Panel sizes per workspace: left frame share, right column px, Timeline share. */
const WORKSPACE_LAYOUTS: Record<Workspace, { left: number; right: number; bottom: number }> = {
  Default: { left: 0.24, right: 300, bottom: 0.42 },
  Review: { left: 0.16, right: 240, bottom: 0.3 },
  Learn: { left: 0.22, right: 380, bottom: 0.36 },
  Standard: { left: 0.26, right: 300, bottom: 0.4 },
  "Small Screen": { left: 0.2, right: 240, bottom: 0.36 },
  Libraries: { left: 0.22, right: 380, bottom: 0.4 },
};
import { useProjectOps, type Session } from "./useProjectOps.tsx";

const ParticleMatchDialog = lazy(() => import("./ParticleMatchDialog.tsx").then((m) => ({ default: m.ParticleMatchDialog })));

type Frame = "left" | "center" | "right" | "bottom";

const TOOL_KEYS: Record<string, ToolId> = { v: "selection", w: "rotation", y: "anchor" };
const NUDGES: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** The layer command a menu command runs when the Project panel does not take it (Edit > Clear, Duplicate). */
const layerCommandFor = (cmd: MenuCommand): LayerCommand | undefined =>
  cmd === "clear" ? "delete-layer" : cmd === "duplicate" ? "duplicate-layer" : isLayerCommand(cmd) ? cmd : undefined;

interface CompView {
  time: number;
  layerId?: number;
}

async function readBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function initialComp(project: Project): CompItem | undefined {
  const comps = [...project.items.values()].filter((i): i is CompItem => i.kind === "comp");
  return comps.reduce<CompItem | undefined>((best, c) => (!best || c.layers.length > best.layers.length ? c : best), undefined);
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

function dragDelta(e: ReactPointerEvent, onMove: (dx: number, dy: number) => void) {
  e.preventDefault();
  const x = e.clientX;
  const y = e.clientY;
  followPointer(e, (ev) => onMove(ev.clientX - x, ev.clientY - y), undefined, 0);
}

export function App() {
  // The menu shows the render options' check marks.
  useRenderOptionsVersion();
  const [loaded, setLoaded] = useState<Session>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [showHome, setShowHome] = useState(false);
  const [openComps, setOpenComps] = useState<number[]>([]);
  const [activeCompId, setActiveCompId] = useState<number>();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const selectedItemId = selectedIds[0];
  const setSelectedItemId = useCallback((id: number | undefined) => setSelectedIds(id === undefined ? [] : [id]), []);
  const [views, setViews] = useState<Record<number, CompView>>({});
  const [leftTab, setLeftTab] = useState("project");
  const [centerTab, setCenterTab] = useState("composition");
  const [bottomTab, setBottomTab] = useState("comp");
  const [focused, setFocused] = useState<Frame>("bottom");
  const [playing, setPlaying] = useState(false);
  const [layout, setLayout] = useState(WORKSPACE_LAYOUTS.Default);
  const [workspaceName, setWorkspaceName] = useState<Workspace>("Default");
  const [preview, setPreview] = useState<PreviewSettings>(DEFAULT_PREVIEW);
  const [tool, setTool] = useState<ToolId>("selection");
  const [revision, setRevision] = useState(0);
  const [editError, setEditError] = useState<string>();
  const [solidFor, setSolidFor] = useState<number>();
  const [particleMatch, setParticleMatch] = useState(false);
  const effects = useEffectLibrary();
  const [lastEffect, setLastEffect] = useState<string>();
  const compact = useCompact();
  const landscape = useMedia(LANDSCAPE_QUERY);
  const coarse = useMedia("(pointer: coarse)");
  /** The panel compact screens show with the viewer; kept in step with the desktop frames' tabs. */
  const [mobileTab, setMobileTab] = useState<MobileTab>("timeline");
  const [viewerShare, setViewerShare] = useState(0.45);
  useLongPressMenus(compact || coarse);

  const editor = loaded?.editor;
  useEffect(() => editor?.subscribe(() => setRevision(editor.revision)), [editor]);
  // Panels are memoized on the project: each edit hands them a new snapshot of the editor's model.
  const project = useMemo<Project | undefined>(() => editor && { ...editor.project }, [editor, revision]);
  const effectCatalog = useMemo(() => catalogCategories(effects), [effects]);
  const definedEffectTypes = useMemo(() => (editor ? definedEffects(editor.file.root) : new Set<string>()), [editor, revision]);
  const comp = activeCompId !== undefined ? project?.items.get(activeCompId) : undefined;
  const activeComp = comp?.kind === "comp" ? comp : undefined;
  const view = activeComp ? (views[activeComp.id] ?? { time: 0 }) : undefined;
  const selectedLayer = activeComp?.layers.find((l) => l.id === view?.layerId);

  const [snapping, setSnapping] = useState(false);
  const editing: Editing = useMemo(
    () => ({ editor, revision, tool, setTool, report: setEditError, snapping, setSnapping }),
    [editor, revision, tool, snapping],
  );

  const showSession = useCallback((session: Session) => {
    const initial = initialComp(session.editor.project);
    setLoaded(session);
    setOpenComps(initial ? [initial.id] : []);
    setActiveCompId(initial?.id);
    setSelectedItemId(initial?.id);
    setViews({});
    setLeftTab("project");
    setCenterTab("composition");
    setBottomTab("comp");
    setMobileTab(initial ? "timeline" : "project");
    setShowHome(false);
    setPlaying(false);
    audioPreview.reset();
    void loadLocalFootage(session.editor.project).catch((e: Error) => setError(`Could not load footage from disk: ${e.message}`));
  }, [setSelectedItemId]);

  const showComp = useCallback((id: number) => {
    setOpenComps((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveCompId(id);
    setCenterTab("composition");
    setBottomTab("comp");
    setMobileTab("timeline");
    setPlaying(false);
  }, []);

  const ops = useProjectOps({
    session: loaded,
    project,
    activeComp,
    selectedIds,
    projectFocused: focused === "left" && leftTab === "project",
    showSession,
    updateSession: setLoaded,
    select: setSelectedIds,
    showComp,
  });
  const { confirmClose } = ops;

  useEffect(() => {
    document.title = ops.title;
  }, [ops.title]);

  useEffect(() => {
    if (!editor) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (editor.dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editor]);

  // Items an undo or a delete removed leave the timeline tabs and the selection.
  useEffect(() => {
    if (!project) return;
    const isComp = (id: number) => project.items.get(id)?.kind === "comp";
    setOpenComps((prev) => (prev.every(isComp) ? prev : prev.filter(isComp)));
    setActiveCompId((id) => (id === undefined || isComp(id) ? id : undefined));
    setSelectedIds((prev) => (prev.every((id) => project.items.has(id)) ? prev : prev.filter((id) => project.items.has(id))));
  }, [project]);
  useEffect(() => {
    if (activeCompId === undefined && openComps.length) setActiveCompId(openComps[openComps.length - 1]);
  }, [activeCompId, openComps]);

  const open = useCallback(
    async (file: File, handle?: ProjectHandle) => {
      if (!(await confirmClose())) return;
      setBusy(true);
      setError(undefined);
      setPlaying(false);
      try {
        const bytes = await readBytes(file);
        const started = performance.now();
        const opened = Editor.fromBytes(bytes);
        const parseMs = performance.now() - started;
        showSession({ editor: opened, file: { name: file.name, size: bytes.length, parseMs }, handle });
      } catch (e) {
        setError(`Could not read ${file.name}: ${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [confirmClose, showSession],
  );

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(
    () =>
      onLaunchedProjects((launched) => {
        if ("file" in launched) void openRef.current(launched.file, launched.handle);
        else setError(`Could not read ${launched.name}: ${launched.error}`);
      }),
    [],
  );

  // The Android back button closes the topmost sheet or dialog, then the Home screen shown over a project, and only
  // then the app, once unsaved changes are saved or discarded.
  const backRef = useRef<() => void>(undefined);
  backRef.current = () => {
    if (dismissTopmost()) return;
    if (loaded && showHome) return setShowHome(false);
    void confirmClose().then((go) => go && exitApp());
  };
  useEffect(() => onBackButton(() => backRef.current?.()), []);

  const pickFile = useCallback(async () => {
    // Phones and tablets get the file input, unfiltered, opened within the tap: their system pickers offer a file only
    // when its type matches, which an .aep's does not, and a fallback opened after a failed picker has lost the tap.
    if (isMobileOS()) {
      inputRef.current?.click();
      return;
    }
    const picked = await pickProjectHandle();
    if (picked === null) inputRef.current?.click();
    else if (picked) void open(picked.file, picked.handle);
  }, [open]);

  const setTime = useCallback(
    (compId: number, t: number) => {
      const item = project?.items.get(compId);
      if (item?.kind !== "comp") return;
      const frame = item.frameDuration || 1 / (item.frameRate || 24);
      const max = Math.max(0, item.duration - frame);
      const snapped = Math.min(max, Math.max(0, Math.round(t / frame) * frame));
      setViews((prev) => ({ ...prev, [compId]: { ...prev[compId], time: snapped } }));
    },
    [project],
  );

  const selectLayer = useCallback((compId: number, layerId: number | undefined) => {
    setViews((prev) => ({ ...prev, [compId]: { time: prev[compId]?.time ?? 0, layerId } }));
  }, []);

  const openItem = useCallback(
    (id: number) => {
      const item = project?.items.get(id);
      if (item?.kind === "comp") showComp(id);
    },
    [project, showComp],
  );

  const closeComp = (id: number) => {
    const rest = openComps.filter((c) => c !== id);
    setOpenComps(rest);
    if (activeCompId === id) setActiveCompId(rest[rest.length - 1]);
    setPlaying(false);
  };

  /** Stops playback, leaving the playhead (and the app's time) on the frame shown last, or at `at`. */
  const stopPlayback = useCallback(
    (at?: number) => {
      const live = playhead.get();
      // Synchronously, so the viewer never sees playback stopped with the time it started from.
      flushSync(() => {
        if (live) setTime(live.compId, at ?? live.time);
        setPlaying(false);
      });
    },
    [setTime],
  );
  /** Moves the playhead from the UI: stops playback first, as clicking the timeline does in AE. */
  const goTo = useCallback(
    (compId: number, t: number) => {
      if (playhead.get()) stopPlayback();
      setTime(compId, t);
    },
    [stopPlayback, setTime],
  );
  /** The active comp's time, the playhead's while playing. */
  const currentTime = (comp: CompItem) => {
    const live = playhead.get();
    return live?.compId === comp.id ? live.time : (views[comp.id]?.time ?? 0);
  };
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const step = useCallback(
    (frames: number) => {
      if (!activeComp) return;
      const t = currentTimeRef.current(activeComp);
      goTo(activeComp.id, t + frames * (activeComp.frameDuration || 1 / 24));
    },
    [activeComp, goTo],
  );
  const edge = useCallback(
    (end: boolean) => {
      if (!activeComp) return;
      goTo(activeComp.id, end ? activeComp.duration : 0);
    },
    [activeComp, goTo],
  );
  const togglePlay = useCallback(() => {
    if (playing || playhead.get()) stopPlayback();
    else if (activeComp) setPlaying(true);
  }, [playing, activeComp, stopPlayback]);

  usePlayback(project, activeComp, playing, view?.time ?? 0, preview, stopPlayback);

  // Decode the active comp's audio ahead of playback once its footage is located.
  const footageVersion = useFootageVersion();
  useEffect(() => {
    if (project && activeComp && typeof AudioContext !== "undefined") audioPreview.prepare(project, activeComp);
  }, [project, activeComp, footageVersion]);

  const layerTarget: LayerTarget = { editor, comp: activeComp, layers: selectedLayer ? [selectedLayer] : [] };
  const runLayer = (cmd: LayerCommand) => {
    if (cmd === "new-solid") {
      if (editor && activeComp) setSolidFor(activeComp.id);
      return;
    }
    if (!canRunLayerCommand(cmd, layerTarget)) return;
    try {
      const id = runLayerCommand(cmd, layerTarget, view?.time ?? 0);
      if (activeComp && cmd !== "undo" && cmd !== "redo") selectLayer(activeComp.id, cmd === "delete-layer" ? undefined : id);
    } catch (e) {
      setEditError((e as Error).message);
    }
  };
  const runLayerRef = useRef(runLayer);
  runLayerRef.current = runLayer;

  // Effects apply to unlocked layers, by default the active comp's selected one, which then shows in Effect Controls.
  const effectTarget = (target?: { compId: number; layerIds: number[] }) => {
    const comp = editor?.project.items.get(target?.compId ?? activeComp?.id ?? -1);
    if (comp?.kind !== "comp") return undefined;
    const ids = target?.layerIds ?? (selectedLayer ? [selectedLayer.id] : []);
    const layerIds = ids.filter((id) => comp.layers.some((l) => l.id === id && !l.locked));
    return layerIds.length ? { comp, layerIds } : undefined;
  };
  // Library effects apply from their templates, other effects the project defines from its definitions.
  const applyEffect = (matchName: string, target?: { compId: number; layerIds: number[] }) => {
    const to = effectTarget(target);
    if (!editor || !to) return;
    try {
      const effect = effects?.find((e) => e.matchName === matchName) ?? projectEffect(editor.file.root, matchName);
      if (!effect) return;
      applyLibraryEffect(editor, to.comp, to.layerIds, effect);
    } catch (e) {
      setEditError((e as Error).message);
      return;
    }
    setLastEffect(matchName);
    selectLayer(to.comp.id, to.layerIds[0]);
    setLeftTab("effects");
    setMobileTab("controls");
  };
  const removeAllEffects = () => {
    const to = effectTarget();
    if (!editor || !to) return;
    const { comp, layerIds } = to;
    try {
      editor.perform("Remove All Effects", [comp], () => {
        for (const id of layerIds) {
          for (let n = layerEffects(comp.layers.find((l) => l.id === id)!).length; n > 0; n--) {
            const layer = comp.layers.find((l) => l.id === id)!;
            editor.removeEffect(comp, layer, layerEffects(layer)[n - 1]);
          }
        }
      });
    } catch (e) {
      setEditError((e as Error).message);
    }
  };
  /** File > Add Footage to Comp: the selected project items, as layers at the top of the active comp. */
  const footageToAdd = (): Item[] =>
    activeComp ? selectedIds.flatMap((id) => project?.items.get(id) ?? []).filter((item) => item.kind !== "folder" && item.id !== activeComp.id) : [];
  const addFootageToComp = () => {
    const items = footageToAdd();
    if (!editor || !activeComp || !items.length) return;
    try {
      let added = 0;
      editor.perform("Add Footage to Comp", [activeComp], () => {
        for (const item of items) added = addLayer(editor, activeComp, { kind: "item", itemId: item.id });
      });
      selectLayer(activeComp.id, added);
      setBottomTab("comp");
      setMobileTab("timeline");
    } catch (e) {
      setEditError((e as Error).message);
    }
  };
  const addFootageRef = useRef(addFootageToComp);
  addFootageRef.current = addFootageToComp;
  const applyEffectRef = useRef(applyEffect);
  applyEffectRef.current = applyEffect;
  const removeAllEffectsRef = useRef(removeAllEffects);
  removeAllEffectsRef.current = removeAllEffects;
  const lastEffectRef = useRef(lastEffect);
  lastEffectRef.current = lastEffect;

  // The render queue belongs to the open project and follows its edits.
  useEffect(() => renderQueue.attach(loaded ? (editor?.project ?? null) : null), [loaded]);
  useEffect(() => renderQueue.update(project ?? null), [project]);
  const addToRenderQueue = (compId?: number) => {
    const comp = compId !== undefined ? project?.items.get(compId) : activeComp;
    if (!project || comp?.kind !== "comp") return;
    renderQueue.add(project, comp);
    setBottomTab("render-queue");
    setMobileTab("render");
    setFocused("bottom");
  };
  const addToRenderQueueRef = useRef(addToRenderQueue);
  addToRenderQueueRef.current = addToRenderQueue;

  const command = useCallback(
    (cmd: MenuCommand) => {
      if (ops.command(cmd)) return;
      switch (cmd) {
        case "open":
          void pickFile();
          break;
        case "close-project":
          void confirmClose().then((go) => {
            if (!go) return;
            setLoaded(undefined);
            setOpenComps([]);
            setActiveCompId(undefined);
            setPlaying(false);
          });
          break;
        case "home":
          setShowHome(true);
          break;
        case "show-project":
          setLeftTab("project");
          setMobileTab("project");
          setFocused("left");
          break;
        case "show-effect-controls":
          setLeftTab("effects");
          setMobileTab("controls");
          setFocused("left");
          break;
        case "show-render-queue":
          setBottomTab("render-queue");
          setMobileTab("render");
          setFocused("bottom");
          break;
        case "add-to-render-queue":
          addToRenderQueueRef.current();
          break;
        case "show-chunks":
          setCenterTab("chunks");
          setMobileTab("more");
          setFocused("center");
          break;
        case "toggle-sapphire":
          setSapphireLookalikes(!appRenderOptions.sapphireLookalikes);
          break;
        case "particle-match":
          setParticleMatch(true);
          break;
        case "add-footage-to-comp":
          addFootageRef.current();
          break;
        case "last-effect":
          if (lastEffectRef.current) applyEffectRef.current(lastEffectRef.current);
          break;
        case "remove-all-effects":
          removeAllEffectsRef.current();
          break;
        case "show-composition":
          setCenterTab("composition");
          setFocused("center");
          break;
        default: {
          if (cmd.startsWith(APPLY_EFFECT)) {
            applyEffectRef.current(cmd.slice(APPLY_EFFECT.length));
            break;
          }
          const layerCmd = layerCommandFor(cmd);
          if (layerCmd) runLayerRef.current(layerCmd);
        }
      }
    },
    [pickFile, ops, confirmClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTyping(e.target)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pickFile();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        addToRenderQueueRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === "/") {
        e.preventDefault();
        addFootageRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e" && editor) {
        // Ctrl+Alt+Shift+E applies the last effect again; Ctrl+Shift+E removes all effects.
        e.preventDefault();
        if (!e.altKey) removeAllEffectsRef.current();
        else if (lastEffectRef.current) applyEffectRef.current(lastEffectRef.current);
        return;
      }
      if (ops.keyDown(e)) return;
      const layerCmd = editor ? layerShortcut(e) : undefined;
      // Delete and Ctrl+D in the Project panel act on project items, not layers.
      if (layerCmd && !((layerCmd === "delete-layer" || layerCmd === "duplicate-layer") && focused === "left")) {
        e.preventDefault();
        runLayerRef.current(layerCmd);
        return;
      }
      if (!activeComp || e.ctrlKey || e.metaKey || e.altKey) return;
      const letter = e.key.toLowerCase();
      if ((letter === "b" || letter === "n") && !e.shiftKey && editor) {
        // B: work area start at the current time; N: work area end after the current frame (AE).
        e.preventDefault();
        const frame = activeComp.frameDuration || 1 / (activeComp.frameRate || 24);
        const t = currentTimeRef.current(activeComp);
        const start = activeComp.workAreaStart;
        const end = start + activeComp.workAreaDuration;
        const area: [number, number] =
          letter === "b" ? [t, end > t ? end : activeComp.duration] : [start < t + frame ? start : 0, Math.min(activeComp.duration, t + frame)];
        try {
          editor.setCompSettings(activeComp, { workArea: area });
        } catch (err) {
          setEditError((err as Error).message);
        }
        return;
      }
      const toolKey = editor && !e.shiftKey ? TOOL_KEYS[letter] : undefined;
      if (toolKey) {
        e.preventDefault();
        setTool(toolKey);
        return;
      }
      const nudge = NUDGES[e.key];
      if (nudge && editor && focused === "center" && selectedLayer) {
        e.preventDefault();
        const n = e.shiftKey ? 10 : 1;
        try {
          nudgeLayers(editor, activeComp, [selectedLayer], [nudge[0] * n, nudge[1] * n], currentTimeRef.current(activeComp));
        } catch (err) {
          setEditError((err as Error).message);
        }
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        step((e.key === "PageDown" ? 1 : -1) * (e.shiftKey ? 10 : 1));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        edge(e.key === "End");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeComp, pickFile, togglePlay, step, edge, editor, focused, selectedLayer, views, ops]);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      const handled = e.defaultPrevented;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (handled) return;
      const files = Array.from(e.dataTransfer.files);
      const projectFile = files.find((f) => /\.aep$/i.test(f.name));
      if (loaded && !projectFile) void addDroppedFootage(e.dataTransfer);
      else if (projectFile) void droppedHandle(e.dataTransfer, projectFile).then((handle) => open(projectFile, handle));
      else if (files[0]) void open(files[0]);
    },
  };

  const resize = (edgeName: "left" | "right" | "bottom") => (e: ReactPointerEvent) => {
    const rect = workspaceRef.current?.getBoundingClientRect();
    const width = rect?.width || window.innerWidth;
    const height = rect?.height || window.innerHeight;
    const start = layout;
    dragDelta(e, (dx, dy) =>
      setLayout({
        ...start,
        ...(edgeName === "left" && { left: Math.min(0.5, Math.max(0.12, start.left + dx / width)) }),
        ...(edgeName === "right" && { right: Math.min(560, Math.max(200, start.right - dx)) }),
        ...(edgeName === "bottom" && { bottom: Math.min(0.8, Math.max(0.2, start.bottom - dy / height)) }),
      }),
    );
  };

  const leftTabs: PanelTab[] = useMemo(
    () => [
      { id: "project", name: "Project", title: "Project" },
      {
        id: "effects",
        name: "Effect Controls",
        title: (
          <>
            Effect Controls <span className="tab-sub">{selectedLayer ? selectedLayer.name : "(none)"}</span>
          </>
        ),
      },
    ],
    [selectedLayer],
  );
  const centerTabs: PanelTab[] = [
    {
      id: "composition",
      name: "Composition",
      title: (
        <>
          Composition <span className="tab-sub">{activeComp?.name ?? "(none)"}</span>
        </>
      ),
    },
    { id: "chunks", name: "RIFX Chunks", title: "RIFX Chunks" },
  ];
  const bottomTabs: PanelTab[] = [
    ...openComps.flatMap((id) => {
      const item = project?.items.get(id);
      return item
        ? [{ id: `comp:${id}`, name: item.name, title: item.name, onClose: () => closeComp(id), onRename: (name: string) => ops.rename(item, name) }]
        : [];
    }),
    { id: "render-queue", name: "Render Queue", title: "Render Queue" },
  ];
  const bottomActive = bottomTab === "render-queue" || !activeComp ? "render-queue" : `comp:${activeComp.id}`;

  const actions = useMemo<AppActions>(
    () => ({
      openComp: openItem,
      addToRenderQueue: (compId: number) => addToRenderQueueRef.current(compId),
      revealInProject: (id) => {
        setSelectedItemId(id);
        setLeftTab("project");
        setMobileTab("project");
        setFocused("left");
      },
      selectLayer,
      locateFootage: () => void locateFootageFolder(),
      reloadFootage:
        project && localFootageAvailable()
          ? () => void loadLocalFootage(project).catch((e: Error) => setError(`Could not load footage from disk: ${e.message}`))
          : undefined,
      showEffectControls: (compId, layerId) => {
        selectLayer(compId, layerId);
        setLeftTab("effects");
        setMobileTab("controls");
        setFocused("left");
      },
      ...(editor && {
        ...ops.contextMenu,
        applyEffect: (matchName: string, target?: { compId: number; layerIds: number[] }) => applyEffectRef.current(matchName, target),
        layerCommand: (cmd: LayerCommand) => runLayerRef.current(cmd),
        canLayerCommand: (cmd: LayerCommand, comp: CompItem, layer: Layer | undefined) =>
          canRunLayerCommand(cmd, { editor, comp, layers: layer ? [layer] : [] }),
        setBlendingMode: (comp: CompItem, layer: Layer, mode: number) => {
          try {
            editor.setBlendingMode(comp, layer, mode);
          } catch (e) {
            setEditError((e as Error).message);
          }
        },
        setLayerSwitch: (comp: CompItem, layer: Layer, name: LayerSwitch, on: boolean) => {
          try {
            editor.setLayerSwitch(comp, layer, name, on);
          } catch (e) {
            setEditError((e as Error).message);
          }
        },
      }),
    }),
    [openItem, selectLayer, project, editor, ops.contextMenu],
  );

  // The panels, docked in frames on desktop screens and one at a time beside the viewer on compact ones.
  const projectPanel = project && (
    <ProjectPanel
      project={project}
      selectedId={selectedItemId}
      onSelect={setSelectedItemId}
      onOpenItem={openItem}
      selectedIds={selectedIds}
      onSelectIds={setSelectedIds}
      ops={ops.panel}
    />
  );
  const effectControls = project && <EffectControlsPanel project={project} comp={activeComp} layer={selectedLayer} time={view?.time ?? 0} />;
  const viewer =
    project &&
    (activeComp ? (
      <CompositionPanel
        project={project}
        comp={activeComp}
        time={view?.time ?? 0}
        selectedLayerId={view?.layerId}
        onSelectLayer={(id) => selectLayer(activeComp.id, id)}
        onTime={(t) => goTo(activeComp.id, t)}
      />
    ) : (
      <div className="viewer-empty">
        <Icon name="comp" size={32} />
        <p>{compact ? "No composition is open. Double-tap a composition in the Project tab." : "No composition is open. Double-click a composition in the Project panel."}</p>
      </div>
    ));
  const timeline = project && activeComp && (
    <TimelinePanel key={activeComp.id} project={project} comp={activeComp} time={view?.time ?? 0} selectedLayerId={view?.layerId} onTime={goTo} onSelectLayer={selectLayer} />
  );
  const renderQueuePanel = project && <RenderQueuePanel project={project} activeComp={activeComp} />;
  const rightPanels = project && loaded && (
    <RightPanels
      project={project}
      comp={activeComp}
      file={loaded.file}
      playing={playing}
      onPlay={togglePlay}
      onStep={step}
      onEdge={edge}
      preview={preview}
      onPreview={setPreview}
      selectedLayer={selectedLayer}
      time={view?.time ?? 0}
      compact={compact}
      showChunks={compact && centerTab === "chunks"}
    />
  );
  const selectCompTab = (id: string) => {
    if (id === "render-queue") {
      setBottomTab("render-queue");
      return;
    }
    setBottomTab("comp");
    setActiveCompId(Number(id.slice(5)));
    setPlaying(false);
  };
  const mobilePanels: Record<MobileTab, ReactNode> = {
    project: projectPanel,
    timeline: (
      <PanelFrame
        tabs={bottomTabs.filter((t) => t.id !== "render-queue")}
        active={activeComp ? `comp:${activeComp.id}` : ""}
        onSelect={selectCompTab}
        focused={false}
        onFocus={() => {}}
        className="frame-mobile"
      >
        {timeline || <p className="panel-empty">No composition is open. Double-tap a composition in the Project tab.</p>}
      </PanelFrame>
    ),
    controls: effectControls,
    effects: project && <EffectsPresetsPanel project={project} target={selectedLayer} />,
    render: renderQueuePanel,
    more: rightPanels,
  };

  const workspace = loaded && project && !showHome && (
    <AppActionsContext.Provider value={actions}>
    {compact ? (
      <MobileWorkspace
        viewer={
          <>
            {viewer}
            {activeComp && (
              <Transport
                comp={activeComp}
                time={view?.time ?? 0}
                playing={playing}
                onPlay={togglePlay}
                onStep={step}
                onEdge={edge}
                onTime={(t) => goTo(activeComp.id, t)}
              />
            )}
          </>
        }
        panel={mobilePanels[mobileTab]}
        tab={mobileTab}
        landscape={landscape}
        share={viewerShare}
        onShare={setViewerShare}
      />
    ) : (
    <div
      ref={workspaceRef}
      className="ws"
      style={{ "--left-w": `${layout.left * 100}%`, "--right-w": `${layout.right}px`, "--bottom-h": `${layout.bottom * 100}%` } as CSSProperties}
    >
      <div className="ws-top">
        <PanelFrame tabs={leftTabs} active={leftTab} onSelect={setLeftTab} focused={focused === "left"} onFocus={() => setFocused("left")} className="frame-left">
          {leftTab === "project" ? projectPanel : effectControls}
        </PanelFrame>
        <div className="splitter v" role="separator" aria-orientation="vertical" aria-label="Resize Project panel" onPointerDown={resize("left")} />
        <PanelFrame
          tabs={centerTabs}
          active={centerTab}
          onSelect={setCenterTab}
          focused={focused === "center"}
          onFocus={() => setFocused("center")}
          className="frame-center"
        >
          {centerTab === "chunks" ? <ChunkPanel root={project.file.root} /> : viewer}
        </PanelFrame>
        <div className="splitter v" role="separator" aria-orientation="vertical" aria-label="Resize right panels" onPointerDown={resize("right")} />
        <section className={`frame frame-right ${focused === "right" ? "focused" : ""}`} onPointerDownCapture={() => setFocused("right")}>
          {rightPanels}
        </section>
      </div>
      <div className="splitter h" role="separator" aria-orientation="horizontal" aria-label="Resize Timeline" onPointerDown={resize("bottom")} />
      <PanelFrame
        tabs={bottomTabs}
        active={bottomActive}
        onSelect={selectCompTab}
        focused={focused === "bottom"}
        onFocus={() => setFocused("bottom")}
        className="frame-bottom"
      >
        {bottomActive === "render-queue" || !activeComp ? renderQueuePanel : timeline}
      </PanelFrame>
    </div>
    )}
    </AppActionsContext.Provider>
  );

  const menuEnabled = (cmd: MenuCommand) => {
    const own = ops.menu.enabled[cmd];
    if (own !== undefined) return own;
    if (cmd.startsWith(APPLY_EFFECT)) return !!effectTarget() && !!effectSource(cmd.slice(APPLY_EFFECT.length), effects, definedEffectTypes);
    if (cmd === "add-footage-to-comp") return !!editor && footageToAdd().length > 0;
    if (cmd === "last-effect") return !!lastEffect && !!effectTarget();
    if (cmd === "remove-all-effects") return !!selectedLayer && layerEffects(selectedLayer).length > 0 && !!effectTarget();
    const layerCmd = layerCommandFor(cmd);
    return !layerCmd || canRunLayerCommand(layerCmd, layerTarget);
  };
  const effectName = (matchName: string) =>
    effects?.find((e) => e.matchName === matchName)?.name ?? catalogName(matchName) ?? project?.effectTypes.get(matchName) ?? matchName;
  const menuLabel = (cmd: MenuCommand) => (cmd === "last-effect" ? lastEffect && effectName(lastEffect) : ops.menu.labels[cmd]);
  const menuChecked = (cmd: MenuCommand) => (cmd === "toggle-sapphire" ? appRenderOptions.sapphireLookalikes : undefined);
  const solidComp = solidFor !== undefined ? project?.items.get(solidFor) : undefined;

  const menuBar = (
    <MenuBar
      hasProject={!!loaded}
      onCommand={command}
      enabled={menuEnabled}
      label={menuLabel}
      checked={menuChecked}
      effects={effectCatalog}
      compact={compact}
      title={loaded?.file.name ?? "AEP Web"}
    />
  );
  const historyButton = (cmd: "undo" | "redo") => (
    <button
      type="button"
      className="mtop-btn"
      aria-label={menuLabel(cmd) || (cmd === "undo" ? "Undo" : "Redo")}
      title={menuLabel(cmd) || (cmd === "undo" ? "Undo" : "Redo")}
      disabled={!menuEnabled(cmd)}
      onClick={() => command(cmd)}
    >
      <Icon name={cmd} size={18} />
    </button>
  );

  const app = (
    <div className={`app ${compact ? "compact" : ""} ${compact && landscape ? "landscape" : ""} ${dragging ? "dragging" : ""}`} {...dropHandlers}>
      {compact ? (
        <header className="mtop">
          {menuBar}
          {workspace ? <Toolbar compact onHome={() => setShowHome(true)} /> : <span className="mtop-title cell-text">{loaded?.file.name ?? "AEP Web"}</span>}
          {editor && workspace && (
            <>
              {historyButton("undo")}
              {historyButton("redo")}
            </>
          )}
        </header>
      ) : (
        <>
          {menuBar}
          <Toolbar
            onHome={() => setShowHome(true)}
            workspace={workspaceName}
            onWorkspace={(w) => {
              setWorkspaceName(w);
              setLayout(WORKSPACE_LAYOUTS[w]);
            }}
          />
        </>
      )}
      {workspace || (
        <HomeScreen onOpen={pickFile} onNew={() => command("new-project")} onDismiss={loaded ? () => setShowHome(false) : undefined} />
      )}
      {compact && workspace && <MobileTabs tab={mobileTab} onTab={setMobileTab} />}
      <ContextMenuHost />
      <input
        ref={inputRef}
        type="file"
        accept={isMobileOS() ? undefined : ".aep"}
        aria-label="Open After Effects project"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
          e.target.value = "";
        }}
      />
      {ops.dialogs}
      {busy && (
        <div className="busy" role="status">
          Reading project…
        </div>
      )}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <Icon name="comp" size={28} />
            Drop to open the project
          </div>
        </div>
      )}
      {error && (
        <div className="modal-backdrop">
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="error-title"
            aria-describedby="error-text"
            onKeyDown={(e) => e.key === "Escape" && setError(undefined)}
          >
            <h2 id="error-title">
              <Icon name="warning" size={16} /> Could not open project
            </h2>
            <p id="error-text">{error}</p>
            <div className="dialog-actions">
              <button type="button" className="ae-primary" autoFocus onClick={() => setError(undefined)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {solidComp?.kind === "comp" && project && editor && (
        <SolidSettings
          project={project}
          comp={solidComp}
          onCancel={() => setSolidFor(undefined)}
          onOk={(solid) => {
            setSolidFor(undefined);
            try {
              const above = views[solidComp.id]?.layerId;
              const id = addLayer(editor, solidComp, { kind: "solid", ...solid }, { above: solidComp.layers.find((l) => l.id === above) });
              selectLayer(solidComp.id, id);
            } catch (e) {
              setEditError((e as Error).message);
            }
          }}
        />
      )}
      {particleMatch && (
        <Suspense fallback={null}>
          <ParticleMatchDialog
            onClose={() => setParticleMatch(false)}
            project={
              editor && project
                ? {
                    editor,
                    project,
                    activeCompId: activeComp?.id,
                    onAdded: (compId, layerIds) => {
                      showComp(compId);
                      selectLayer(compId, layerIds[0]);
                      setLeftTab("effects");
                      setMobileTab("controls");
                      setFocused("left");
                    },
                  }
                : undefined
            }
          />
        </Suspense>
      )}
      {editError && (
        <div className="modal-backdrop">
          <div
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="edit-error-title"
            aria-describedby="edit-error-text"
            onKeyDown={(e) => e.key === "Escape" && setEditError(undefined)}
          >
            <h2 id="edit-error-title">
              <Icon name="warning" size={16} /> After Effects warning
            </h2>
            <p id="edit-error-text">{editError}</p>
            <div className="dialog-actions">
              <button type="button" className="ae-primary" autoFocus onClick={() => setEditError(undefined)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
  return <EditingContext.Provider value={editing}>{app}</EditingContext.Provider>;
}
