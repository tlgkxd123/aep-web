import type { Project } from "../aep/model.ts";
import { controlTypeName, formatValue } from "./format.ts";

/** Every effect type the project uses, with the parameter definitions each effect declares. */
export function EffectsPanel({ project }: { project: Project }) {
  const types = [...project.effectTypes.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!types.length) return <p className="empty">This project uses no effects.</p>;
  return (
    <div className="effects">
      {types.map(([matchName, displayName]) => {
        const params = project.effectParams.get(matchName) ?? [];
        const builtIn = matchName.startsWith("ADBE ");
        return (
          <details key={matchName} className="effect-def">
            <summary>
              <span className={`tag ${builtIn ? "tag-effect" : "tag-plugin"}`}>{builtIn ? "built-in" : "plugin"}</span>
              <strong>{displayName}</strong> <span className="meta">{matchName}</span>
              <span className="meta">{params.length} params</span>
            </summary>
            <table className="params">
              <thead>
                <tr>
                  <th>Match name</th>
                  <th>Name</th>
                  <th>Control</th>
                  <th>Default</th>
                  <th>Range</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p.matchName} className={p.invisible ? "muted" : ""}>
                    <td>{p.matchName}</td>
                    <td>{p.name}</td>
                    <td>{controlTypeName(p.controlType)}</td>
                    <td>{p.options ? (p.options[Number(p.defaultValue) - 1] ?? "") : formatValue(p.defaultValue ?? null)}</td>
                    <td>{p.min !== undefined ? `${formatValue(p.min)} – ${formatValue(p.max ?? null)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        );
      })}
    </div>
  );
}
