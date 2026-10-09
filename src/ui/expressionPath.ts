// Expression references to properties, written the way After Effects' pick whip
// writes them: `transform.position`, `effect("Glow")("Glow Radius")`,
// `thisComp.layer("Logo").mask("Mask 1").maskOpacity`, and `("Name")` steps for
// groups without an attribute name.
import type { Layer, Property, PropertyNode } from "../aep/model.ts";
import { ATTRIBUTES } from "../expressions/api.ts";

/** The groups from the layer down to `prop` (excluding the layer), then `prop`; undefined when it is not on the layer. */
export function propertyChain(layer: Layer, prop: Property): PropertyNode[] | undefined {
  const walk = (nodes: readonly PropertyNode[], chain: PropertyNode[]): PropertyNode[] | undefined => {
    for (const node of nodes) {
      if (node === prop) return [...chain, node];
      if (node.kind === "group") {
        const found = walk(node.children, [...chain, node]);
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(layer.properties, []);
}

const quote = (name: string) => JSON.stringify(name);

/** The groups whose children are addressed by name through a function rather than an attribute. */
const NAMED_CALLS: Record<string, string> = {
  "ADBE Effect Parade": "effect",
  "ADBE Mask Parade": "mask",
  "ADBE Root Vectors Group": "content",
  "ADBE Vectors Group": "content",
};

/**
 * The expression text that reads `prop` of `layer`, from an expression on `from` (another layer of the same
 * comp is reached through thisComp.layer()).
 */
export function expressionPath(layer: Layer, prop: Property, from: Layer): string | undefined {
  const chain = propertyChain(layer, prop);
  if (!chain) return undefined;
  const steps: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const call = node.kind === "group" ? NAMED_CALLS[node.matchName] : undefined;
    if (call) {
      const child = chain[i + 1];
      if (!child) break;
      // Shape groups nest their contents one level down: content("Group 1").content("Rectangle 1").
      steps.push(`.${call}(${quote(child.name)})`);
      i++;
      // A shape group's contents sit in its own Contents group: content("Group 1").content("Rectangle 1").
      if (child.kind === "group" && child.matchName === "ADBE Vector Group" && chain[i + 1]?.matchName === "ADBE Vectors Group") i++;
      continue;
    }
    const attribute = ATTRIBUTES[node.matchName]?.[0];
    steps.push(attribute ? `.${attribute}` : `(${quote(node.name)})`);
  }
  const body = steps.join("").replace(/^\./, "");
  if (layer === from) return body.startsWith("(") ? `thisLayer${body}` : body;
  return `thisComp.layer(${quote(layer.name)})${body.startsWith("(") ? "" : "."}${body}`;
}

/** What Alt-clicking a stopwatch writes: the property reading itself, as After Effects does. */
export function defaultExpression(layer: Layer, prop: Property): string {
  return expressionPath(layer, prop, layer) ?? "value";
}
