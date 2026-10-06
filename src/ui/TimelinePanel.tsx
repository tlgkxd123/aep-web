import type { CompItem, Layer } from "../aep/model.ts";
import { blendingModeName, timecode, trackMatteName } from "./format.ts";

interface Props {
  comp: CompItem;
  selectedLayer: Layer | undefined;
  onSelect: (layer: Layer) => void;
}

const LAYER_ICONS: Record<Layer["layerType"], string> = {
  AVLayer: "▭",
  TextLayer: "T",
  ShapeLayer: "★",
  CameraLayer: "◉",
  LightLayer: "☼",
  ThreeDModelLayer: "⬢",
  ParametricMeshLayer: "⬡",
};

function switches(layer: Layer): string {
  const flags = [
    layer.enabled ? "" : "hidden",
    layer.solo ? "solo" : "",
    layer.locked ? "locked" : "",
    layer.shy ? "shy" : "",
    layer.threeDLayer ? "3D" : "",
    layer.adjustmentLayer ? "adjustment" : "",
    layer.nullLayer ? "null" : "",
    layer.guideLayer ? "guide" : "",
    layer.motionBlur ? "motion blur" : "",
    layer.collapseTransformation ? "collapse" : "",
    layer.timeRemapEnabled ? "time remap" : "",
  ];
  return flags.filter(Boolean).join(" · ");
}

export function TimelinePanel({ comp, selectedLayer, onSelect }: Props) {
  const span = comp.duration || 1;
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - comp.displayStartTime) / span) * 100))}%`;
  return (
    <div className="timeline">
      <div className="comp-header">
        <strong>{comp.name}</strong>
        <span>
          {comp.width}×{comp.height} · {comp.frameRate.toFixed(3).replace(/\.?0+$/, "")} fps · {timecode(comp.duration, comp.frameRate)}
        </span>
      </div>
      {comp.layers.length === 0 && <p className="empty">This composition has no layers.</p>}
      <ul className="layers" aria-label="Layers">
        {comp.layers.map((layer) => {
          const parent = layer.parentId ? comp.layers.find((l) => l.id === layer.parentId) : undefined;
          const matte = trackMatteName(layer.trackMatteType);
          return (
            <li
              key={layer.id}
              className={`layer ${selectedLayer === layer ? "selected" : ""} ${layer.enabled ? "" : "disabled"}`}
              onClick={() => onSelect(layer)}
            >
              <span className="index">{layer.index}</span>
              <span className="icon" title={layer.layerType}>{LAYER_ICONS[layer.layerType]}</span>
              <span className="layer-name">
                {layer.name}
                <small>
                  {[
                    layer.blendingMode !== 5212 ? blendingModeName(layer.blendingMode) : "",
                    matte ? `matte: ${matte}` : "",
                    parent ? `parent: ${parent.index}. ${parent.name}` : "",
                    switches(layer),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span className="bar-track">
                <span
                  className="bar"
                  style={{ left: pct(layer.inPoint), width: `calc(${pct(layer.outPoint)} - ${pct(layer.inPoint)})` }}
                  title={`${timecode(layer.inPoint, comp.frameRate)} → ${timecode(layer.outPoint, comp.frameRate)}`}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
