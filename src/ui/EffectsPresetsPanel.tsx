import { memo, useMemo, useState } from "react";
import { EffectControlType, type EffectParamDef, type Project } from "../aep/model.ts";
import { controlTypeName, formatValue } from "./format.ts";
import { Icon } from "./icons.tsx";
import { isPluginEffect, layerEffects } from "./properties.ts";

const CATEGORIES = [
  "* Animation Presets", "3D Channel", "Audio", "Blur & Sharpen", "Channel", "Cinema 4D", "Color Correction",
  "Distort", "Expression Controls", "Generate", "Immersive Video", "Keying", "Matte", "Noise & Grain", "Obsolete",
  "Perspective", "Simulation", "Stylize", "Text", "Time", "Transition", "Utility",
];

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

/** Effects & Presets, with a category for the effect types this project uses. */
export const EffectsPresetsPanel = memo(function EffectsPresetsPanel({ project }: { project: Project }) {
  const [query, setQuery] = useState("");
  const [usedOpen, setUsedOpen] = useState(true);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

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

  const q = query.trim().toLowerCase();
  const effects = [...project.effectTypes.entries()]
    .filter(([matchName, name]) => !q || name.toLowerCase().includes(q) || matchName.toLowerCase().includes(q))
    .sort(([, a], [, b]) => a.localeCompare(b));
  const toggle = (matchName: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(matchName)) next.add(matchName);
      return next;
    });

  return (
    <div className="fxp">
      <label className="search-field">
        <Icon name="search" size={12} />
        <input type="search" aria-label="Search effects and presets" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="fxp-tree" role="tree" aria-label="Effects & Presets">
        <div role="treeitem" aria-level={1} aria-expanded={usedOpen}>
          <div className="fxp-row fxp-cat" onClick={() => setUsedOpen(!usedOpen)}>
            <span className={`twirl ${usedOpen ? "open" : ""}`} aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
            <span className="cell-text">Used in This Project</span>
            <span className="dim fxp-count">{project.effectTypes.size}</span>
          </div>
          {usedOpen && (
            <div role="group">
              {effects.length === 0 && <div className="fxp-none">{q ? "No matching effects" : "This project uses no effects"}</div>}
              {effects.map(([matchName, name]) => {
                const plugin = isPluginEffect(matchName);
                const defs = project.effectParams.get(matchName) ?? [];
                const isOpen = open.has(matchName);
                const count = uses.get(matchName) ?? 0;
                return (
                  <div key={matchName} role="treeitem" aria-level={2} aria-expanded={isOpen}>
                    <div
                      className="fxp-row fxp-effect"
                      onClick={() => toggle(matchName)}
                      title={`${matchName} · ${defs.length} parameters · applied ${count} ${count === 1 ? "time" : "times"}`}
                    >
                      <span className={`twirl ${isOpen ? "open" : ""}`} aria-hidden="true">
                        <Icon name="twirl" size={10} />
                      </span>
                      <Icon name="effect" size={14} className="ic ic-effect" />
                      <span className="cell-text">{name}</span>
                      {plugin && <span className="tag-plugin">Plug-in</span>}
                    </div>
                    {isOpen && <ParamDefs defs={defs} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {CATEGORIES.filter((c) => !q || c.toLowerCase().includes(q)).map((name) => (
          <div key={name} role="treeitem" aria-level={1} aria-disabled="true" className="fxp-row fxp-cat inert" title="Effect library browsing is not available in this viewer">
            <span className="twirl" aria-hidden="true">
              <Icon name="twirl" size={10} />
            </span>
            <span className="cell-text">{name}</span>
          </div>
        ))}
      </div>
    </div>
  );
});
