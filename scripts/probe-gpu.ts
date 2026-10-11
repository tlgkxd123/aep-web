// Prints which GPU a WebGL2 context gets in a headless browser (Edge, or Chrome with --chrome) for each
// powerPreference, on the main thread and on an OffscreenCanvas. Windows picks the adapter per program (Settings ›
// Display › Graphics), so this shows what the app gets in that browser.
//
//   node scripts/probe-gpu.ts [--chrome] [extra browser flags...]
import { chromium } from "playwright-core";

const flags = process.argv.slice(2).filter((a) => a !== "--chrome");
const channel = process.argv.includes("--chrome") ? "chrome" : "msedge";
const browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", ...flags] });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
const result = await page.evaluate(async () => {
  const name = (gl: WebGL2RenderingContext | null) => {
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "none";
  };
  const out: Record<string, string> = {};
  for (const pref of ["default", "low-power", "high-performance"] as const) {
    out[`main ${pref}`] = name(document.createElement("canvas").getContext("webgl2", { powerPreference: pref }));
    out[`offscreen ${pref}`] = name(new OffscreenCanvas(1, 1).getContext("webgl2", { powerPreference: pref }) as WebGL2RenderingContext | null);
  }
  return out;
});
for (const [k, v] of Object.entries(result)) console.log(`${k.padEnd(28)} ${v}`);
await browser.close();
