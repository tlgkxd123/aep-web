// Project operations of the File, Edit and Composition menus and the Project
// panel: each runs one undoable editor command (src/edit/project.ts) and
// opens the dialogs AE shows for it.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { CompItem, FootageItem, Item, Project } from "../aep/model.ts";
import { Editor } from "../edit/editor.ts";
import { nextName } from "../edit/items.ts";
import {
  DEFAULT_COMP_SETTINGS,
  deleteItems,
  duplicateComp,
  importFootage,
  itemUsage,
  moveItems,
  newComposition,
  newFolder,
  newProject,
  reduceProject,
  removeUnusedFootage,
  renameItem,
  replaceFootage,
  validateCompSettings,
  type CompSettings,
  type FootageFile,
} from "../edit/project.ts";
import { identifyLocal, localFootageAvailable, readLocal } from "../media/localFootage.ts";
import { isImportable, probeMedia } from "../media/probe.ts";
import { footageStore } from "../media/store.ts";
import { quickStartTemplate, type QuickStartId, type QuickStartTemplate } from "../quickstart/catalog.ts";
import { createQuickStart, type QuickStartFiles } from "../quickstart/create.ts";
import type { ProjectItemCommand } from "./contextMenus.ts";
import { bitsPerChannel } from "./format.ts";
import { AlertDialog, type AlertAction } from "./Dialog.tsx";
import { CompSettingsDialog } from "./CompSettingsDialog.tsx";
import { ImportDialog } from "./ImportDialog.tsx";
import { QUICK_START, type MenuCommand } from "./MenuBar.tsx";
import { pickMediaFiles, saveProjectBytes, type ProjectHandle } from "./projectFiles.ts";
import { QuickStartDialog } from "./QuickStart.tsx";
import type { ProjectPanelOps } from "./ProjectPanel.tsx";
import type { FileInfo } from "./RightPanels.tsx";

export interface Session {
  editor: Editor;
  file: FileInfo;
  /** Where Save writes, when the browser gave the opened or saved file's handle. */
  handle?: ProjectHandle;
  /** The file as last opened or saved, what File > Revert goes back to. */
  bytes?: Uint8Array;
}

export interface ProjectOpsHost {
  session: Session | undefined;
  /** The current snapshot of the session's project. */
  project: Project | undefined;
  activeComp: CompItem | undefined;
  /** The Project panel's selection, first the item the info header shows. */
  selectedIds: readonly number[];
  /** Whether the Project panel has focus (Edit > Clear and Duplicate act on its items). */
  projectFocused: boolean;
  /** Shows a new or reopened session from scratch. */
  showSession(session: Session): void;
  /** Updates the shown session (after a save). */
  updateSession(session: Session): void;
  select(ids: number[]): void;
  /** Opens a composition in the viewer and timeline. */
  showComp(id: number): void;
}

const UNTITLED = "Untitled Project.aep";
const LAST_SETTINGS = "aep-web.compSettings";

/** AE remembers the last New Composition settings. */
function lastSettings(): CompSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_SETTINGS) ?? "null") as CompSettings | null;
    if (stored) {
      const settings = { ...DEFAULT_COMP_SETTINGS, ...stored };
      validateCompSettings(settings);
      return settings;
    }
  } catch {
    // Unreadable or invalid: the factory settings.
  }
  return DEFAULT_COMP_SETTINGS;
}

function rememberSettings(settings: CompSettings): void {
  try {
    localStorage.setItem(LAST_SETTINGS, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable; the next dialog then starts from the factory settings.
  }
}

const compSettingsOf = (comp: CompItem): CompSettings => ({
  name: comp.name,
  width: comp.width,
  height: comp.height,
  pixelAspect: comp.pixelAspect,
  frameRate: comp.frameRate,
  duration: comp.duration,
  bgColor: comp.bgColor,
  resolutionFactor: comp.resolutionFactor,
  displayStartTime: comp.displayStartTime,
});

const fileName = (name: string) => (/\.aep$/i.test(name) ? name : `${name}.aep`);

/** File > Increment and Save's name: "Project.aep" becomes "Project 2.aep", "Project 2.aep" "Project 3.aep". */
export function incrementedName(name: string): string {
  const base = fileName(name).replace(/\.aep$/i, "");
  const numbered = /^(.*?)[ _]?(\d+)$/.exec(base);
  return numbered && numbered[1] ? `${numbered[1]} ${Number(numbered[2]) + 1}.aep` : `${base} 2.aep`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type CompDialog = { mode: "new"; folderId: number; initial: CompSettings } | { mode: "edit"; comp: CompItem };
type ImportTarget = { mode: "import"; folderId: number } | { mode: "replace"; item: FootageItem };
interface Alert {
  message: ReactNode;
  actions: AlertAction[];
  onCancel: () => void;
}

export function useProjectOps(host: ProjectOpsHost) {
  const { session, project, activeComp, selectedIds } = host;
  const editor = session?.editor;
  const [compDialog, setCompDialog] = useState<CompDialog>();
  const [importTarget, setImportTarget] = useState<ImportTarget>();
  const [alert, setAlert] = useState<Alert>();
  const [renamingId, setRenamingId] = useState<number>();
  const [quickStart, setQuickStart] = useState<QuickStartTemplate>();

  const live = (id: number | undefined) => (id !== undefined ? editor?.project.items.get(id) : undefined);
  const selectedItems = () => selectedIds.map(live).filter((i): i is Item => !!i);

  const fail = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setAlert({ message, actions: [{ label: "OK", primary: true, onClick: () => setAlert(undefined) }], onCancel: () => setAlert(undefined) });
  }, []);

  /** Runs a command, reporting what it throws in AE's warning box. */
  const attempt = <T,>(body: () => T): T | undefined => {
    try {
      return body();
    } catch (error) {
      fail(error);
      return undefined;
    }
  };

  /** New items go into the selected folder, or the folder of the selected item. */
  const targetFolder = (): number => {
    const item = live(selectedIds[0]);
    if (!item) return 0;
    return item.kind === "folder" ? item.id : item.parentFolderId;
  };

  // ------------------------------------------------------------ save / close

  /** Save, Save As (`saveAs`), or Increment and Save, which saves as a new file under `name`. */
  const save = async (saveAs: boolean, name = session?.file.name): Promise<boolean> => {
    if (!session || !name) return false;
    try {
      const bytes = session.editor.save();
      const saved = await saveProjectBytes(bytes, name, session.handle, saveAs || !session.handle);
      if (!saved) return false;
      session.editor.markSaved();
      host.updateSession({ ...session, file: { ...session.file, name: saved.name, size: bytes.length }, handle: saved.handle, bytes });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  /** Before the project closes: AE's "Save changes" prompt when it has unsaved changes. Resolves to whether to go on. */
  const confirmClose = (): Promise<boolean> => {
    if (!session?.editor.dirty) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (go: boolean) => {
        setAlert(undefined);
        resolve(go);
      };
      setAlert({
        message: `Save changes to "${session.file.name}" before closing?`,
        actions: [
          {
            label: "Save",
            primary: true,
            onClick: () => {
              setAlert(undefined);
              void save(false).then(resolve);
            },
          },
          { label: "Don't Save", onClick: () => done(true) },
          { label: "Cancel", onClick: () => done(false) },
        ],
        onCancel: () => done(false),
      });
    });
  };

  /** File > Save As > Save a Copy: writes the project to a new file and keeps working on the current one. */
  const saveCopy = async () => {
    if (!session) return;
    try {
      await saveProjectBytes(session.editor.save(), `${fileName(session.file.name).replace(/\.aep$/i, "")} copy.aep`, undefined, true);
    } catch (error) {
      fail(error);
    }
  };

  /** File > Revert: back to the file as last saved, after AE's warning. */
  const revert = () => {
    const bytes = session?.bytes;
    if (!session || !bytes || !session.editor.dirty) return;
    setAlert({
      message: `Revert to the last saved version of "${session.file.name}"? Changes since then will be lost.`,
      actions: [
        {
          label: "Revert",
          primary: true,
          onClick: () => {
            setAlert(undefined);
            const reverted = attempt(() => Editor.fromBytes(bytes));
            if (reverted) host.showSession({ ...session, editor: reverted });
          },
        },
        { label: "Cancel", onClick: () => setAlert(undefined) },
      ],
      onCancel: () => setAlert(undefined),
    });
  };

  const report = (message: string) =>
    setAlert({ message, actions: [{ label: "OK", primary: true, onClick: () => setAlert(undefined) }], onCancel: () => setAlert(undefined) });

  /** The compositions Reduce Project keeps: those selected in the Project panel, or the active one. */
  const compsToKeep = (): CompItem[] => {
    const selected = selectedItems().filter((i): i is CompItem => i.kind === "comp");
    if (selected.length) return selected;
    const active = activeComp && live(activeComp.id);
    return active?.kind === "comp" ? [active] : [];
  };

  const removeUnused = () => {
    if (!editor) return;
    const removed = attempt(() => removeUnusedFootage(editor));
    if (removed !== undefined) report(removed ? `Removed ${plural(removed, "item")} from the project.` : "There is no unused footage to remove.");
  };

  const reduce = () => {
    if (!editor) return;
    const removed = attempt(() => reduceProject(editor, compsToKeep()));
    if (removed === undefined) return;
    host.select(selectedIds.filter((id) => editor.project.items.has(id)));
    report(removed ? `Removed ${plural(removed, "item")} from the project.` : "Every item is used by the selected compositions.");
  };

  const createProject = async () => {
    if (!(await confirmClose())) return;
    const fresh = newProject();
    host.showSession({ editor: fresh, file: { name: UNTITLED, size: fresh.save().length, parseMs: 0 } });
  };

  /** Builds the Quick Start template around the picked files, then opens it in place of the current project. */
  const createFromTemplate = async (id: QuickStartId, files: QuickStartFiles, particles: boolean) => {
    const { editor: built, comp } = await createQuickStart(id, files, particles);
    if (!(await confirmClose())) return;
    setQuickStart(undefined);
    host.showSession({ editor: built, file: { name: fileName(comp.name), size: built.save().length, parseMs: 0 } });
  };

  // ------------------------------------------------------------ items

  const openNewComp = () => {
    if (!editor) return;
    setCompDialog({ mode: "new", folderId: targetFolder(), initial: { ...lastSettings(), name: nextName(editor.project, "Comp") } });
  };

  const openCompSettings = (compId?: number) => {
    const selected = live(selectedIds[0]);
    const comp =
      compId !== undefined ? live(compId) : host.projectFocused && selected?.kind === "comp" ? selected : activeComp ? live(activeComp.id) : undefined;
    if (comp?.kind === "comp") setCompDialog({ mode: "edit", comp });
  };

  const confirmCompDialog = (settings: CompSettings) => {
    if (!editor || !compDialog) return;
    const dialog = compDialog;
    setCompDialog(undefined);
    if (dialog.mode === "new") {
      const comp = attempt(() => newComposition(editor, settings, dialog.folderId));
      if (!comp) return;
      rememberSettings({ ...settings, name: DEFAULT_COMP_SETTINGS.name });
      host.select([comp.id]);
      host.showComp(comp.id);
    } else {
      attempt(() => editor.setCompSettings(dialog.comp, settings));
    }
  };

  const createFolder = (folderId = targetFolder()) => {
    if (!editor) return;
    const folder = attempt(() => newFolder(editor, folderId));
    if (!folder) return;
    host.select([folder.id]);
    setRenamingId(folder.id);
  };

  const rename = (item: Item, name: string) => {
    if (editor) attempt(() => renameItem(editor, live(item.id) ?? item, name));
  };

  const move = (items: Item[], folderId: number) => {
    if (editor) attempt(() => moveItems(editor, items.map((i) => live(i.id) ?? i), folderId));
  };

  const remove = (items: Item[]) => {
    if (!editor || !items.length) return;
    const targets = items.map((i) => live(i.id) ?? i);
    const usage = itemUsage(editor.project, targets);
    const run = () => {
      setAlert(undefined);
      attempt(() => deleteItems(editor, targets));
      host.select([]);
    };
    const folders = targets.filter((i): i is Item & { kind: "folder" } => i.kind === "folder" && i.items.length > 0);
    if (!usage.layers.length && !folders.length) return run();
    const comps = new Set(usage.layers.map((u) => u.comp));
    const message = usage.layers.length
      ? `${targets.length === 1 ? "The selected item is" : "The selected items are"} used ${plural(usage.layers.length, "time")} in ${plural(comps.size, "composition")}. Delete anyway?`
      : `Delete ${plural(folders.length, "folder")} and everything in ${folders.length === 1 ? "it" : "them"}?`;
    setAlert({
      message,
      actions: [
        { label: "Delete", primary: true, onClick: run },
        { label: "Cancel", onClick: () => setAlert(undefined) },
      ],
      onCancel: () => setAlert(undefined),
    });
  };

  const duplicate = () => {
    if (!editor) return;
    const comps = selectedItems().filter((i): i is CompItem => i.kind === "comp");
    const copies = comps.map((comp) => attempt(() => duplicateComp(editor, comp))).filter((c): c is CompItem => !!c);
    if (copies.length) host.select(copies.map((c) => c.id));
  };

  // ------------------------------------------------------------ footage

  /** Probes picked files and stores their blobs; `paths` are their absolute paths where known. */
  const footageFiles = async (files: File[], paths?: (string | null)[]): Promise<FootageFile[]> => {
    const rejected = files.filter((f) => !isImportable(f.name));
    if (rejected.length) {
      throw new Error(
        `${rejected.map((f) => `"${f.name}"`).join(", ")} cannot be imported. This editor imports PNG, JPEG, GIF, BMP and TIFF images and MP4/MOV video.`,
      );
    }
    const located = paths ?? (await identifyLocal(files));
    return Promise.all(
      files.map(async (file, i) => {
        const path = located[i] ?? file.name;
        const info = await probeMedia(file, file.name);
        footageStore.addFiles([{ path, blob: file }]);
        return { path, info };
      }),
    );
  };

  const importFiles = async (files: File[], folderId = targetFolder(), paths?: (string | null)[]) => {
    if (!editor || !files.length) return;
    try {
      const footage = await footageFiles(files, paths);
      const items = importFootage(editor, footage, folderId);
      host.select(items.map((i) => i.id));
    } catch (error) {
      fail(error);
    }
  };

  const replaceWith = async (item: FootageItem, file: File, path?: string) => {
    if (!editor) return;
    try {
      const [footage] = await footageFiles([file], path ? [path] : undefined);
      const replaced = replaceFootage(editor, live(item.id)?.kind === "footage" ? (live(item.id) as FootageItem) : item, footage);
      host.select([replaced.id]);
    } catch (error) {
      fail(error);
    }
  };

  const startImport = (target: ImportTarget) => {
    if (localFootageAvailable()) return setImportTarget(target);
    void systemPick(target);
  };

  const systemPick = async (target: ImportTarget) => {
    setImportTarget(undefined);
    const files = await pickMediaFiles(target.mode === "import");
    if (!files.length) return;
    if (target.mode === "import") await importFiles(files, target.folderId);
    else await replaceWith(target.item, files[0]);
  };

  const chooseLocal = async (paths: string[]) => {
    const target = importTarget;
    setImportTarget(undefined);
    if (!target) return;
    try {
      const files = await Promise.all(paths.map(readLocal));
      if (target.mode === "import") await importFiles(files, target.folderId, paths);
      else await replaceWith(target.item, files[0], paths[0]);
    } catch (error) {
      fail(error);
    }
  };

  const startReplace = () => {
    const item = live(selectedIds[0]);
    if (item?.kind !== "footage" || item.mainSource.sourceType !== "FileSource") {
      return fail("Select a footage file in the Project panel to replace.");
    }
    startImport({ mode: "replace", item });
  };

  // ------------------------------------------------------------ commands

  const undo = () => {
    if (editor?.undoLabel) attempt(() => editor.undo());
  };
  const redo = () => {
    if (editor?.redoLabel) attempt(() => editor.redo());
  };

  /** Carries out a menu command; false when it is not a project operation. */
  const command = (cmd: MenuCommand): boolean => {
    if (cmd.startsWith(QUICK_START)) {
      setQuickStart(quickStartTemplate(cmd.slice(QUICK_START.length)));
      return true;
    }
    switch (cmd) {
      case "new-project":
        void createProject();
        return true;
      case "new-folder":
        createFolder();
        return true;
      case "new-comp":
        openNewComp();
        return true;
      case "comp-settings":
        openCompSettings();
        return true;
      case "save":
        void save(false);
        return true;
      case "save-as":
        void save(true);
        return true;
      case "save-copy":
        void saveCopy();
        return true;
      case "increment-save":
        if (session) void save(true, incrementedName(session.file.name));
        return true;
      case "revert":
        revert();
        return true;
      case "remove-unused-footage":
        removeUnused();
        return true;
      case "reduce-project":
        reduce();
        return true;
      case "import":
        if (editor) startImport({ mode: "import", folderId: targetFolder() });
        return true;
      case "replace-footage":
        startReplace();
        return true;
      case "undo":
        undo();
        return true;
      case "redo":
        redo();
        return true;
      case "duplicate":
        if (host.projectFocused) duplicate();
        return host.projectFocused;
      case "clear":
        if (host.projectFocused) remove(selectedItems());
        return host.projectFocused;
    }
    return false;
  };

  /** AE's shortcuts for the commands above; true when the key was one of them. */
  const handleKey = (e: KeyboardEvent): boolean => {
    if (!(e.ctrlKey || e.metaKey)) return false;
    const key = e.code.replace(/^Key/, "");
    const shortcuts: Record<string, MenuCommand> = {
      "ctrl+alt+N": "new-project",
      "ctrl+alt+shift+N": "new-folder",
      "ctrl+N": "new-comp",
      "ctrl+K": "comp-settings",
      "ctrl+S": "save",
      "ctrl+shift+S": "save-as",
      "ctrl+alt+shift+S": "increment-save",
      "ctrl+I": "import",
      "ctrl+alt+I": "import",
      "ctrl+H": "replace-footage",
      "ctrl+Z": "undo",
      "ctrl+shift+Z": "redo",
      "ctrl+D": "duplicate",
    };
    const combo = `ctrl${e.altKey ? "+alt" : ""}${e.shiftKey ? "+shift" : ""}+${key}`;
    const cmd = shortcuts[combo];
    if (!cmd || (!editor && cmd !== "new-project")) return false;
    if (cmd === "duplicate" && !host.projectFocused) return false;
    e.preventDefault();
    command(cmd);
    return true;
  };

  /** A Project panel context-menu command, on the panel's selection. */
  const itemCommand = (cmd: ProjectItemCommand) => {
    if (cmd === "rename") setRenamingId(selectedIds[0]);
    else if (cmd === "duplicate") duplicate();
    else if (cmd === "delete") remove(selectedItems());
    else command(cmd);
  };

  // The panel and the context menus are memoized and the window's key listener
  // is re-attached only after a render commits: they get stable callbacks that
  // run the latest closures.
  const fresh = { rename, move, remove, createFolder, openNewComp, openCompSettings, importFiles, replaceWith, handleKey, itemCommand, removeUnused, reduce };
  const latest = useRef(fresh);
  latest.current = fresh;
  const keyDown = useCallback((e: KeyboardEvent) => latest.current.handleKey(e), []);
  const contextMenu = useMemo(
    () => ({
      projectCommand: (cmd: ProjectItemCommand) => latest.current.itemCommand(cmd),
      openCompSettings: (compId: number) => latest.current.openCompSettings(compId),
      removeUnusedFootage: () => latest.current.removeUnused(),
      reduceProject: () => latest.current.reduce(),
    }),
    [],
  );
  const panel = useMemo<ProjectPanelOps>(
    () => ({
      rename: (item, name) => latest.current.rename(item, name),
      move: (items, folderId) => latest.current.move(items, folderId),
      remove: (items) => latest.current.remove(items),
      newFolder: () => latest.current.createFolder(),
      newComp: () => latest.current.openNewComp(),
      importFiles: (files, folderId) => void latest.current.importFiles(files, folderId),
      replace: (item, file) => void latest.current.replaceWith(item, file),
      renamingId,
      onRenamingChange: setRenamingId,
    }),
    [renamingId],
  );

  const dialogs = (
    <>
      {compDialog && project && (
        <CompSettingsDialog
          key={compDialog.mode === "edit" ? compDialog.comp.id : "new"}
          initial={compDialog.mode === "edit" ? compSettingsOf(compDialog.comp) : compDialog.initial}
          bitsPerChannel={bitsPerChannel(project.bitsPerChannel)}
          onOK={confirmCompDialog}
          onCancel={() => setCompDialog(undefined)}
        />
      )}
      {importTarget && (
        <ImportDialog
          title={importTarget.mode === "import" ? "Import File" : `Replace Footage File (${importTarget.item.name})`}
          action={importTarget.mode === "import" ? "Import" : "Replace"}
          multiple={importTarget.mode === "import"}
          onChoose={(paths) => void chooseLocal(paths)}
          onSystemDialog={() => void systemPick(importTarget)}
          onCancel={() => setImportTarget(undefined)}
        />
      )}
      {quickStart && (
        <QuickStartDialog
          key={quickStart.id}
          template={quickStart}
          onCreate={(files, particles) => createFromTemplate(quickStart.id, files, particles)}
          onCancel={() => setQuickStart(undefined)}
        />
      )}
      {alert && <AlertDialog message={alert.message} actions={alert.actions} onCancel={alert.onCancel} />}
    </>
  );

  const menu = {
    enabled: {
      "new-folder": !!editor,
      "new-comp": !!editor,
      "comp-settings": !!activeComp,
      save: !!editor,
      "save-as": !!editor,
      "save-copy": !!editor,
      "increment-save": !!editor,
      revert: !!session?.bytes && !!editor?.dirty,
      "remove-unused-footage": !!editor,
      "reduce-project": !!editor && compsToKeep().length > 0,
      import: !!editor,
      "replace-footage": live(selectedIds[0])?.kind === "footage",
      undo: !!editor?.undoLabel,
      redo: !!editor?.redoLabel,
      // Outside the Project panel these act on layers, which the host decides.
      duplicate: host.projectFocused ? selectedItems().some((i) => i.kind === "comp") : undefined,
      clear: host.projectFocused ? selectedIds.length > 0 : undefined,
    } as Partial<Record<MenuCommand, boolean | undefined>>,
    labels: {
      undo: editor?.undoLabel ? `Undo ${editor.undoLabel}` : "Can't Undo",
      redo: editor?.redoLabel ? `Redo ${editor.redoLabel}` : "Can't Redo",
    } as Partial<Record<MenuCommand, string>>,
  };

  /** The browser tab's title, with AE's unsaved-changes asterisk. */
  const title = session ? `${fileName(session.file.name)}${session.editor.dirty ? " *" : ""} - AEP Web` : "AEP Web";

  return { command, keyDown, confirmClose, dialogs, panel, menu, contextMenu, title, rename };
}
