import type { Item, Layer, Project } from "../aep/model.ts";
import { colorCss } from "./format.ts";
import { Icon } from "./icons.tsx";
import { sourceItem } from "./properties.ts";

/** The Project panel glyph for an item: folder, comp, solid in its colour, still, movie, audio or placeholder. */
export function ItemIcon({ item, size = 14 }: { item: Item | undefined; size?: number }) {
  if (!item) return <Icon name="nullObject" size={size} className="ic ic-null" />;
  if (item.kind === "folder") return <Icon name="folder" size={size} className="ic ic-folder" />;
  if (item.kind === "comp") return <Icon name="comp" size={size} className="ic ic-comp" />;
  const source = item.mainSource;
  if (source.sourceType === "SolidSource") {
    return (
      <span className="ic ic-solid" style={{ color: colorCss(source.color) }}>
        <Icon name="solid" size={size} />
      </span>
    );
  }
  if (source.sourceType === "PlaceholderSource") return <Icon name="placeholder" size={size} className="ic ic-placeholder" />;
  if (item.width === 0) return <Icon name="audio" size={size} className="ic ic-audio" />;
  return <Icon name={source.isStill ? "still" : "footage"} size={size} className="ic ic-footage" />;
}

export function LayerIcon({ layer, project }: { layer: Layer; project: Project }) {
  switch (layer.layerType) {
    case "TextLayer":
      return <Icon name="text" size={14} className="ic ic-text" />;
    case "ShapeLayer":
      return <Icon name="shape" size={14} className="ic ic-shape" />;
    case "CameraLayer":
      return <Icon name="camera" size={14} className="ic ic-camera" />;
    case "LightLayer":
      return <Icon name="light" size={14} className="ic ic-light" />;
    case "ThreeDModelLayer":
    case "ParametricMeshLayer":
      return <Icon name="cube" size={14} className="ic ic-model" />;
  }
  if (layer.nullLayer) return <Icon name="nullObject" size={14} className="ic ic-null" />;
  return <ItemIcon item={sourceItem(layer, project)} />;
}
