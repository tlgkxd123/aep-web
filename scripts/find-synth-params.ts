// Lists effect parameters a project leaves out (synthesized by the parser), per effect, and
// whether a stored donor exists for writing them.
//
//   node scripts/find-synth-params.ts <project.aep>
import { readFileSync } from "node:fs";
import type { PropertyNode } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { canStore } from "../src/edit/stored-property.ts";

const editor = Editor.fromBytes(new Uint8Array(readFileSync(process.argv[2])));
const counts = new Map<string, { left: number; writable: number; example: string }>();
for (const item of editor.project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const walk = (nodes: readonly PropertyNode[], effect?: string) => {
      for (const n of nodes) {
        if (n.kind === "group") walk(n.children, n.isEffect ? `${item.name} > ${layer.name} > ${n.name}` : effect);
        else if (effect && n.synthesized && n.controlType !== undefined) {
          const entry = counts.get(effect) ?? { left: 0, writable: 0, example: n.matchName };
          entry.left++;
          if (canStore(editor, layer, n)) entry.writable++;
          counts.set(effect, entry);
        }
      }
    };
    walk(layer.properties);
  }
}
for (const [effect, c] of [...counts].slice(0, 30)) console.log(`${effect}: ${c.left} left out, ${c.writable} writable (e.g. ${c.example})`);
console.log(`${counts.size} effects with left-out parameters`);
