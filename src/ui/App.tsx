import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { CompItem, Layer, Project } from "../aep/model.ts";
import { Editor, type LayerSwitch } from "../edit/editor.ts";
import { addLayer } from "../edit/layers.ts";
import { nudgeLayers } from "../edit/transform-ops.ts";
import { audioPreview } from "../media/audioPreview.ts";
import { loadLocalFootage, localFootageAvailable } from "../media/localFootage.ts";
import { ContextMenuHost } from "./ContextMenu.tsx";
import { AppActionsContext, type AppActions } from "./contextMenus.ts";
import { ChunkPanel } from "./ChunkPanel.tsx";
import { CompositionPanel } from "./CompositionPanel.tsx";
import { EditingContext, type Editing, type ToolId } from "./editing.tsx";
import { EffectControlsPanel } from "./EffectControlsPanel.tsx";
import { HomeScreen } from "./HomeScreen.tsx";
import { Icon } from "./icons.tsx";
import { canRunLayerCommand, isLayerCommand, layerShortcut, runLayerCommand, type LayerCommand, type LayerTarget } from "./layerCommands.ts";
import { addDroppedFootage, locateFootageFolder, useFootageVersion } from "./LocateFootage.tsx";
import { MenuBar, type MenuCommand } from "./MenuBar.tsx";
import { PanelFrame, type PanelTab } from "./Panel.tsx";
import { droppedHandle, pickProjectHandle, type ProjectHandle } from "./projectFiles.ts";
import { ProjectPanel } from "./ProjectPanel.tsx";
import { RightPanels } from "./RightPanels.tsx";
import { SolidSettings } from "./SolidSettings.tsx";
import { TimelinePanel } from "./TimelinePanel.tsx";
import { Toolbar } from "./Toolbar.tsx";
import { useProjectOps, type Session } from "./useProjectOps.tsx";

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
  const move = (ev: PointerEvent | MouseEvent) => onMove(ev.clientX - x, ev.clientY - y);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function RenderQueue() {
  return (
    <div className="render-queue">
      <div className="rq-head">
        <span className="dim">Current Render</span>
        <span className="rq-spacer" />
        <span className="ae-button" aria-disabled="true">
          Queue in AME
        </span>
        <span className="ae-button" aria-disabled="true">
          Render
        </span>
      </div>
      <div className="rq-cols" aria-hidden="true">
        <span>Render</span>
        <span>#</span>
        <span>Comp Name</span>
        <span>Status</span>
        <span>Started</span>
        <span>Render Time</span>
      </div>
      <p className="panel-empty">Render queue items are not decoded from the project file yet.</p>
    </div>
  );
}

export function App() {
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
  const [layout, setLayout] = useState({ left: 0.24, right: 300, bottom: 0.42 });
  const [tool, setTool] = useState<ToolId>("selection");
  const [revision, setRevision] = useState(0);
  const [editError, setEditError] = useState<string>();
  const [solidFor, setSolidFor] = useState<number>();

  const editor = loaded?.editor;
  useEffect(() => editor?.subscribe(() => setRevision(editor.revision)), [editor]);
  // Panels are memoized on the project: each edit hands them a new snapshot of the editor's model.
  const project = useMemo<Project | undefined>(() => editor && { ...editor.project }, [editor, revision]);
  const comp = activeCompId !== undefined ? project?.items.get(activeCompId) : undefined;
  const activeComp = comp?.kind === "comp" ? comp : undefined;
  const view = activeComp ? (views[activeComp.id] ?? { time: 0 }) : undefined;
  const selectedLayer = activeComp?.layers.find((l) => l.id === view?.layerId);

  const editing: Editing = useMemo(
    () => ({ editor, revision, tool, setTool, report: setEditError }),
    [editor, revision, tool],
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

  const pickFile = useCallback(async () => {
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

  const step = useCallback(
    (frames: number) => {
      if (!activeComp) return;
      setPlaying(false);
      setTime(activeComp.id, (views[activeComp.id]?.time ?? 0) + frames * (activeComp.frameDuration || 1 / 24));
    },
    [activeComp, views, setTime],
  );
  const edge = useCallback(
    (end: boolean) => {
      if (!activeComp) return;
      setPlaying(false);
      setTime(activeComp.id, end ? activeComp.duration : 0);
    },
    [activeComp, setTime],
  );
  const togglePlay = useCallback(() => setPlaying((p) => !p && !!activeComp), [activeComp]);

  useEffect(() => {
    if (!playing || !activeComp || typeof requestAnimationFrame === "undefined") return;
    const frame = activeComp.frameDuration || 1 / 24;
    const ws = activeComp.workAreaStart;
    const we = Math.min(activeComp.duration, ws + activeComp.workAreaDuration);
    const length = Math.max(frame, we - ws);
    const current = views[activeComp.id]?.time ?? 0;
    const start = current >= ws && current < we ? current : ws;
    const startWall = performance.now();
    if (project) audioPreview.play(project, activeComp, start, we);
    let loop = 0;
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = start - ws + (now - startWall) / 1000;
      const t = ws + (elapsed % length);
      // Each pass over the work area restarts the audio from its start.
      const pass = Math.floor(elapsed / length);
      if (pass !== loop && project) {
        loop = pass;
        audioPreview.play(project, activeComp, t, we);
      }
      setTime(activeComp.id, Math.floor(t / frame) * frame);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audioPreview.stop();
    };
    // `views` is read once at start: playback must not restart on its own ticks.
  }, [playing, activeComp, setTime, project]);

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
          setFocused("left");
          break;
        case "show-effect-controls":
          setLeftTab("effects");
          setFocused("left");
          break;
        case "show-render-queue":
          setBottomTab("render-queue");
          setFocused("bottom");
          break;
        case "show-chunks":
          setCenterTab("chunks");
          setFocused("center");
          break;
        case "show-composition":
          setCenterTab("composition");
          setFocused("center");
          break;
        default: {
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
      if (ops.keyDown(e)) return;
      const layerCmd = editor ? layerShortcut(e) : undefined;
      // Delete and Ctrl+D in the Project panel act on project items, not layers.
      if (layerCmd && !((layerCmd === "delete-layer" || layerCmd === "duplicate-layer") && focused === "left")) {
        e.preventDefault();
        runLayerRef.current(layerCmd);
        return;
      }
      if (!activeComp || e.ctrlKey || e.metaKey || e.altKey) return;
      const toolKey = editor && !e.shiftKey ? TOOL_KEYS[e.key.toLowerCase()] : undefined;
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
          nudgeLayers(editor, activeComp, [selectedLayer], [nudge[0] * n, nudge[1] * n], views[activeComp.id]?.time ?? 0);
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
      revealInProject: (id) => {
        setSelectedItemId(id);
        setLeftTab("project");
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
        setFocused("left");
      },
      ...(editor && {
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
    [openItem, selectLayer, project, editor],
  );

  const workspace = loaded && project && !showHome && (
    <AppActionsContext.Provider value={actions}>
    <div
      ref={workspaceRef}
      className="ws"
      style={{ "--left-w": `${layout.left * 100}%`, "--right-w": `${layout.right}px`, "--bottom-h": `${layout.bottom * 100}%` } as CSSProperties}
    >
      <div className="ws-top">
        <PanelFrame tabs={leftTabs} active={leftTab} onSelect={setLeftTab} focused={focused === "left"} onFocus={() => setFocused("left")} className="frame-left">
          {leftTab === "project" ? (
            <ProjectPanel
              project={project}
              selectedId={selectedItemId}
              onSelect={setSelectedItemId}
              onOpenItem={openItem}
              selectedIds={selectedIds}
              onSelectIds={setSelectedIds}
              ops={ops.panel}
            />
          ) : (
            <EffectControlsPanel project={project} comp={activeComp} layer={selectedLayer} time={view?.time ?? 0} />
          )}
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
          {centerTab === "chunks" ? (
            <ChunkPanel root={project.file.root} />
          ) : activeComp ? (
            <CompositionPanel
              project={project}
              comp={activeComp}
              time={view?.time ?? 0}
              selectedLayerId={view?.layerId}
              onSelectLayer={(id) => selectLayer(activeComp.id, id)}
            />
          ) : (
            <div className="viewer-empty">
              <Icon name="comp" size={32} />
              <p>No composition is open. Double-click a composition in the Project panel.</p>
            </div>
          )}
        </PanelFrame>
        <div className="splitter v" role="separator" aria-orientation="vertical" aria-label="Resize right panels" onPointerDown={resize("right")} />
        <section className={`frame frame-right ${focused === "right" ? "focused" : ""}`} onPointerDownCapture={() => setFocused("right")}>
          <RightPanels project={project} comp={activeComp} file={loaded.file} playing={playing} onPlay={togglePlay} onStep={step} onEdge={edge} />
        </section>
      </div>
      <div className="splitter h" role="separator" aria-orientation="horizontal" aria-label="Resize Timeline" onPointerDown={resize("bottom")} />
      <PanelFrame
        tabs={bottomTabs}
        active={bottomActive}
        onSelect={(id) => {
          if (id === "render-queue") {
            setBottomTab("render-queue");
            return;
          }
          setBottomTab("comp");
          setActiveCompId(Number(id.slice(5)));
          setPlaying(false);
        }}
        focused={focused === "bottom"}
        onFocus={() => setFocused("bottom")}
        className="frame-bottom"
      >
        {bottomActive === "render-queue" || !activeComp ? (
          <RenderQueue />
        ) : (
          <TimelinePanel
            key={activeComp.id}
            project={project}
            comp={activeComp}
            time={view?.time ?? 0}
            selectedLayerId={view?.layerId}
            onTime={setTime}
            onSelectLayer={selectLayer}
          />
        )}
      </PanelFrame>
    </div>
    </AppActionsContext.Provider>
  );

  const menuEnabled = (cmd: MenuCommand) => {
    const own = ops.menu.enabled[cmd];
    if (own !== undefined) return own;
    const layerCmd = layerCommandFor(cmd);
    return !layerCmd || canRunLayerCommand(layerCmd, layerTarget);
  };
  const menuLabel = (cmd: MenuCommand) => ops.menu.labels[cmd];
  const solidComp = solidFor !== undefined ? project?.items.get(solidFor) : undefined;

  const app = (
    <div className={`app ${dragging ? "dragging" : ""}`} {...dropHandlers}>
      <MenuBar hasProject={!!loaded} onCommand={command} enabled={menuEnabled} label={menuLabel} />
      <Toolbar onHome={() => setShowHome(true)} />
      {workspace || (
        <HomeScreen onOpen={pickFile} onNew={() => command("new-project")} onDismiss={loaded ? () => setShowHome(false) : undefined} />
      )}
      <ContextMenuHost />
      <input
        ref={inputRef}
        type="file"
        accept=".aep"
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
