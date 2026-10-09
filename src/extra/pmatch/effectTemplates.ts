// The effects Particle Match creates layers with, as After Effects writes them
// (data/effect-templates.json, exported by scripts/export-effect-templates.ts),
// unpacked once on first use.
import type { EffectTemplate } from "../../edit/effects.ts";
import { chunksFromBytes } from "../../edit/layer-templates.ts";
import data from "./data/effect-templates.json" with { type: "json" };

let loading: Promise<Map<string, EffectTemplate>> | undefined;

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Templates by effect match name ("tc Particular", "ADBE Mirror"). */
export function effectTemplates(): Promise<Map<string, EffectTemplate>> {
  loading ??= (async () => {
    const raw = await gunzip(Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0)));
    const chunk = ([at, length]: number[]) => {
      const [only] = chunksFromBytes([raw.subarray(at, at + length)]);
      if (!only) throw new Error("an effect template is damaged");
      return only;
    };
    const templates = new Map<string, EffectTemplate>();
    for (const [matchName, entry] of Object.entries(data.effects)) {
      templates.set(matchName, { matchName, definition: chunk(entry.definition), instance: chunk(entry.instance) });
    }
    return templates;
  })();
  return loading;
}
