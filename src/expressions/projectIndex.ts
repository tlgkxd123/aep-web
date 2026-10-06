// Reverse lookups the expression API needs and the project model does not
// store: the comp of a layer, the project of a comp, the parent group of a
// property.
import type { CompItem, FootageItem, Layer, Project, PropertyGroup, PropertyNode } from "../aep/model.ts";

export class ProjectIndex {
  private readonly layerComp = new WeakMap<Layer, CompItem>();
  private readonly compProject = new WeakMap<CompItem, Project>();
  private readonly indexed = new WeakSet<Project>();
  private readonly parents = new WeakMap<Layer, Map<PropertyNode, PropertyGroup | null>>();

  add(project: Project): void {
    if (this.indexed.has(project)) return;
    this.indexed.add(project);
    for (const item of project.items.values()) {
      if (item.kind !== "comp") continue;
      this.compProject.set(item, project);
      for (const layer of item.layers) this.layerComp.set(layer, item);
    }
  }

  comp(layer: Layer): CompItem | undefined {
    return this.layerComp.get(layer);
  }

  project(comp: CompItem): Project | undefined {
    return this.compProject.get(comp);
  }

  private parentMap(layer: Layer): Map<PropertyNode, PropertyGroup | null> {
    let map = this.parents.get(layer);
    if (!map) {
      map = new Map();
      const walk = (nodes: PropertyNode[], parent: PropertyGroup | null) => {
        for (const n of nodes) {
          map!.set(n, parent);
          if (n.kind === "group") walk(n.children, n);
        }
      };
      walk(layer.properties, null);
      this.parents.set(layer, map);
    }
    return map;
  }

  /** The group holding `node` (null for a layer's top-level groups), undefined when not in this layer. */
  parent(layer: Layer, node: PropertyNode): PropertyGroup | null | undefined {
    return this.parentMap(layer).get(node);
  }

  /** The nodes from the layer's top-level group down to `node`. */
  path(layer: Layer, node: PropertyNode): PropertyNode[] {
    const out: PropertyNode[] = [];
    for (let n: PropertyNode | null | undefined = node; n; n = this.parent(layer, n)) out.unshift(n);
    return out;
  }

  siblings(layer: Layer, node: PropertyNode): PropertyNode[] {
    const parent = this.parent(layer, node);
    return parent ? parent.children : layer.properties;
  }

  /** 1-based position of `node` among its siblings. */
  indexInParent(layer: Layer, node: PropertyNode): number {
    return this.siblings(layer, node).indexOf(node) + 1;
  }

  compByName(project: Project, name: string): CompItem | undefined {
    for (const item of project.items.values()) if (item.kind === "comp" && item.name === name) return item;
    return undefined;
  }

  footageByName(project: Project, name: string): FootageItem | undefined {
    for (const item of project.items.values()) if (item.kind === "footage" && item.name === name) return item;
    return undefined;
  }
}
