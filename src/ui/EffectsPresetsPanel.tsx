import { memo, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { EffectControlType, type EffectParamDef, type Layer, type Project } from "../aep/model.ts";
import { catalogCategories } from "../edit/effectCatalog.ts";
import { definedEffects, effectLibrary, effectSource, loadedEffectLibrary, type EffectSource, type LibraryEffect } from "../edit/effectLibrary.ts";
import { effectRenderer } from "../render/registry.ts";
import { AppActionsContext } from "./contextMenus.ts";
import { EFFECT_MIME, useEditing } from "./editing.tsx";
import { controlTypeName, formatValue } from "./format.ts";
import { Icon } from "./icons.tsx";
import { isPluginEffect, layerEffects } from "./properties.ts";
import { useCompact, useMedia } from "./responsive.ts";

/** The Effects & Presets library, once loaded (loading starts on first use). */
export function useEffectLibrary(): LibraryEffect[] | undefined {
  const [library, setLibrary] = useState(loadedEffectLibrary);
  useEffect(() => {
    if (library) return;
    // The load is shared and can outlive this component.
    let live = true;
    void effectLibrary().then(
      (loaded) => live && setLibrary(loaded),
      (e: Error) => {
        console.error(`The effect library could not be loaded: ${e.message}`);
        if (live) setLibrary([]);
      },
    );
    return () => {
      live = false;
    };
  }, [library]);
  return library;
}

function defaultText(def: EffectParamDef): string {
  if (def.options && typeof def.defaultValue === "number") return def.options[def.defaultValue - 1] ?? "";
  if (def.controlType === EffectControlType.CHECKBOX) return def.defaultValue ? "On" : "Off";
  return formatValue(def.defaultValue ?? null);
}

function ParamDefs({ defs }: { defs: EffectParamDef[] }) {
  let depth = 0;
  return (
    <div role="group" className="fxp-params">
      {defs.map((def) => {
        if (def.controlType === EffectControlType.GROUP_END) {
          depth = Math.max(0, depth - 1);
          return null;
        }
        const level = depth;
        if (def.controlType === EffectControlType.GROUP_START) depth++;
        return (
          <div
            key={def.matchName}
            role="treeitem"
            aria-level={3 + level}
            className={`fxp-param ${def.invisible ? "hidden-param" : ""}`}
            style={{ paddingLeft: 40 + level * 12 }}
            title={`${def.matchName}${def.invisible ? " · hidden in Effect Controls" : ""}`}
          >
            <span className="fxp-param-name">{def.name || <em className="dim">{def.matchName}</em>}</span>
            <span className="fxp-param-type">{controlTypeName(def.controlType)}</span>
            <span className="fxp-param-default">{defaultText(def)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** What hovering an effect says about applying it. */
function applyTitle(source: EffectSource | undefined, matchName: string): string {
  if (!source) return "Not available in this viewer: it applies the effects of its library and those this project already uses";
  const how = "Double-click or drag onto a layer to apply";
  return effectRenderer(matchName) ? how : `${how}. This viewer does not draw it yet; After Effects renders it`;
}

/** The tag of an effect that can be applied but that the renderer does not draw. */
const notRendered = (source: EffectSource | undefined, matchName: string) =>
  source && !effectRenderer(matchName) && <span className="tag-plugin">Not rendered</span>;

/**
 * Effects & Presets: the effects this project uses, and every effect After Effects lists, by category. Effects of the
 * library and those the project defines apply to `target` (the active comp's selected layer) on double-click or Enter,
 * from the search field too, or to the layer they are dragged onto; the others are listed, unavailable.
 */
export const EffectsPresetsPanel = memo(function EffectsPresetsPanel({ project, target }: { project: Project; target?: Layer }) {
  const actions = useContext(AppActionsContext);
  const { editor } = useEditing();
  const coarse = useMedia("(pointer: coarse)");
  const compact = useCompact();
  const library = useEffectLibrary();
  const [query, setQuery] = useState("");
  const [usedOpen, setUsedOpen] = useState(true);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const tree = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // jsdom has no scrollIntoView.
    tree.current?.querySelector(".fxp-effect.selected")?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  const uses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of project.items.values()) {
      if (item.kind !== "comp") continue;
      for (const layer of item.layers) {
        for (const fx of layerEffects(layer)) counts.set(fx.matchName, (counts.get(fx.matchName) ?? 0) + 1);
      }
    }
    return counts;
  }, [project]);
  const catalog = useMemo(() => catalogCategories(library), [library]);
  // `project` is a new snapshot after each edit, which may define effects.
  const defined = useMemo(() => (editor ? definedEffects(editor.file.root) : new Set<string>()), [editor, project]);
  const sourceOf = (matchName: string) => (actions?.applyEffect ? effectSource(matchName, library, defined) : undefined);

  const q = query.trim().toLowerCase();
  const matches = (name: string, matchName: string) => !q || name.toLowerCase().includes(q) || matchName.toLowerCase().includes(q);
  const used = [...project.effectTypes.entries()].filter(([matchName, name]) => matches(name, matchName)).sort(([, a], [, b]) => a.localeCompare(b));
  const toggle = (set: typeof setOpen, key: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const apply = (matchName: string) => actions?.applyEffect?.(matchName);
  const onEffectKey = (e: KeyboardEvent, matchName: string) => {
    if (e.key !== "Enter" || !sourceOf(matchName)) return;
    e.preventDefault();
    apply(matchName);
  };
  const onDragStart = (e: DragEvent, matchName: string) => {
    setSelected(matchName);
    e.dataTransfer.setData(EFFECT_MIME, matchName);
    e.dataTransfer.effectAllowed = "copy";
  };

  const categories = catalog.flatMap(({ name: category, effects }) => {
    const inCategory = !!q && category.toLowerCase().includes(q);
    const shown = effects.filter((e) => inCategory || matches(e.name, e.matchName));
    if (q && !shown.length && !inCategory) return [];
    return [{ category, effects: shown, known: effects.length > 0 }];
  });
  // Up and Down pick among the listed effects that can be applied; Enter applies the picked one, or the first.
  const listed = [
    ...(usedOpen ? used.map(([matchName]) => matchName) : []),
    ...categories.flatMap(({ category, effects }) => (q || openCategories.has(category) ? effects.map((e) => e.matchName) : [])),
  ].filter((matchName, i, all) => all.indexOf(matchName) === i && !!sourceOf(matchName));

  const onSearchKey = (e: KeyboardEvent) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && listed.length) {
      e.preventDefault();
      const at = listed.indexOf(selected ?? "");
      setSelected(listed[e.key === "ArrowDown" ? Math.min(at + 1, listed.length - 1) : Math.max(at - 1, 0)]);
    } else if (e.key === "Enter") {
      const matchName = listed.find((m) => m === selected) ?? (q ? listed[0] : undefined);
      if (!matchName) return;
      e.preventDefault();
      setSelected(matchName);
      apply(matchName);
    }
  };
  const hint = !actions?.applyEffect ? undefined : !target ? "Select a layer to apply effects to it." : target.locked ? `Unlock ${target.name} to apply effects to it.` : undefined;
  // On touch screens the picked effect also applies from a button: a drag needs a long press, and on compact screens the Timeline is on another tab.
  const touch = compact || coarse;
  const picked = selected && sourceOf(selected) ? selected : undefined;
  const pickedName = picked && (catalog.flatMap((c) => c.effects).find((e) => e.matchName === picked)?.name ?? project.effectTypes.get(picked) ?? picked);

  return (
    <div className="fxp">
      <label className="search-field">
        <Icon name="search" size={12} />
        <input
          type="search"
          aria-label="Search effects and presets"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
      </label>
      {hint && (
        <div className="fxp-hint" role="status">
          {hint}
        </div>
      )}
      <div className="fxp-tree" role="tree" aria-label="Effects & Presets" ref={tree}>
        <div role="treeitem" aria-level={1} aria-expanded={usedOpen} aria-label="Used in This Project">
          <div className="fxp-row fxp-cat" onClick={() => setUsedOpen(!usedOpen)}>
            <span className={`twirl ${usedOpen ? "open" : ""}`} aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
            <span className="cell-text">Used in This Project</span>
            <span className="dim fxp-count">{project.effectTypes.size}</span>
          </div>
          {usedOpen && (
            <div role="group">
              {used.length === 0 && <div className="fxp-none">{q ? "No matching effects" : "This project uses no effects"}</div>}
              {used.map(([matchName, name]) => {
                const source = sourceOf(matchName);
                const defs = project.effectParams.get(matchName) ?? [];
                const isOpen = open.has(matchName);
                const count = uses.get(matchName) ?? 0;
                return (
                  <div key={matchName} role="treeitem" aria-level={2} aria-expanded={isOpen} aria-selected={selected === matchName} aria-label={name}>
                    <div
                      className={`fxp-row fxp-effect ${selected === matchName ? "selected" : ""}`}
                      onClick={() => toggle(setOpen, matchName)}
                      onDoubleClick={() => source && apply(matchName)}
                      draggable={!!source}
                      onDragStart={(e) => onDragStart(e, matchName)}
                      title={`${matchName} · ${defs.length} parameters · applied ${count} ${count === 1 ? "time" : "times"}${source ? ` · ${applyTitle(source, matchName)}` : ""}`}
                    >
                      <span className={`twirl ${isOpen ? "open" : ""}`} aria-hidden="true">
                        <Icon name="twirl" size={10} />
                      </span>
                      <Icon name="effect" size={14} className="ic ic-effect" />
                      <span className="cell-text">{name}</span>
                      {isPluginEffect(matchName) && <span className="tag-plugin">Plug-in</span>}
                      {notRendered(source, matchName)}
                    </div>
                    {isOpen && <ParamDefs defs={defs} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {(!q || "* animation presets".includes(q)) && (
          <div role="treeitem" aria-level={1} aria-disabled="true" className="fxp-row fxp-cat inert" title="Animation presets are not available in this viewer">
            <span className="twirl" aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
            <span className="cell-text">* Animation Presets</span>
          </div>
        )}
        {categories.map(({ category, effects: shown, known }) => {
          if (!known) {
            return (
              <div key={category} role="treeitem" aria-level={1} aria-disabled="true" className="fxp-row fxp-cat inert" title="This viewer does not know the effects of this category">
                <span className="twirl" aria-hidden="true">
                  <Icon name="twirl" size={10} />
                </span>
                <span className="cell-text">{category}</span>
              </div>
            );
          }
          const isOpen = openCategories.has(category) || !!q;
          return (
            <div key={category} role="treeitem" aria-level={1} aria-expanded={isOpen} aria-label={category}>
              <div className="fxp-row fxp-cat" onClick={() => toggle(setOpenCategories, category)}>
                <span className={`twirl ${isOpen ? "open" : ""}`} aria-hidden="true">
                  <Icon name="twirl" size={10} />
                </span>
                <span className="cell-text">{category}</span>
              </div>
              {isOpen && (
                <div role="group">
                  {shown.map((effect) => {
                    const source = sourceOf(effect.matchName);
                    const isSelected = selected === effect.matchName;
                    return (
                      <div
                        key={effect.matchName}
                        role="treeitem"
                        aria-level={2}
                        aria-selected={isSelected}
                        aria-disabled={!source || undefined}
                        aria-label={effect.name}
                        tabIndex={isSelected ? 0 : -1}
                        className={`fxp-row fxp-effect fxp-lib ${isSelected ? "selected" : ""} ${source ? "" : "unavailable"}`}
                        title={`${effect.matchName} · ${applyTitle(source, effect.matchName)}`}
                        draggable={!!source}
                        onDragStart={(e) => onDragStart(e, effect.matchName)}
                        onClick={(e) => {
                          setSelected(effect.matchName);
                          e.currentTarget.focus();
                        }}
                        onDoubleClick={() => source && apply(effect.matchName)}
                        onKeyDown={(e) => onEffectKey(e, effect.matchName)}
                      >
                        <Icon name="effect" size={14} className="ic ic-effect" />
                        <span className="cell-text">{effect.name}</span>
                        {notRendered(source, effect.matchName)}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {touch && picked && (
        <div className="fxp-apply">
          <Icon name="effect" size={16} className="ic ic-effect" />
          <span className="cell-text">{pickedName}</span>
          <button
            type="button"
            className="ae-primary"
            disabled={!target || target.locked}
            aria-label={`Apply ${pickedName}${target ? ` to ${target.name}` : ""}`}
            onClick={() => apply(picked)}
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
});
