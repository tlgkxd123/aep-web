// Checks Particular's "No DOF" types on the GPU: switching Depth of Field must leave their pixels identical,
// while Sphere must still defocus. Both sides of the focal plane are exercised.
//   node scripts/check-particular-dof.ts [--no-build]
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { openHarness } from "./lib/harness-page.ts";

const COMP = "roundtrip_cs_vignette";
const LAYER = "roundtrip_card";
const { browser, page } = await openHarness(resolve("refs/fixtures/roundtrip.base.aep"), { build: !process.argv.includes("--no-build") });
const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

async function render(type: number, dof: number, z: number, rate = 1): Promise<Buffer> {
  return Buffer.from(await page.evaluate(async ({ comp, layer, type, dof, z, rate }) => {
    const h = (globalThis as any).aepHarness;
    h.setEffect(comp, layer, "tc Particular", {
      146: rate, 581: [80, 60, z], 11: 0, 12: 0, 2: 20, 65: 0,
      26: type, 27: 6, 29: 33, 74: 0, 33: 100, 75: 0,
      215: 370, 216: 25, 217: 100, 319: dof,
    });
    const r = await h.render(comp, 0.5);
    for (const w of r.warnings as string[]) if (/not rendered yet|failed|error/i.test(w)) throw new Error(w);
    return r.pixels as string;
  }, { comp: COMP, layer: LAYER, type, dof, z, rate }), "base64");
}

try {
  const blank = await render(1, 1, 0, 0);
  for (const z of [-100, 100]) {
    for (const [type, name] of [[1, "Sphere"], [2, "Glow Sphere"], [3, "Star"], [13, "Circle"]] as const) {
      const off = await render(type, 1, z);
      const on = await render(type, 2, z);
      assert.notDeepEqual(off, blank, `${name} at z=${z} must draw particles`);
      const equal = off.equals(on);
      assert.equal(equal, type !== 1, `${name} at z=${z}: ${type === 1 ? "Sphere must defocus" : "No DOF pixels must stay identical"}`);
      console.log(`ok ${name} z=${z}: ${equal ? "identical with DOF on/off" : "Sphere defocuses"}`);
    }
  }
  assert.deepEqual(errors, [], "browser errors");
  console.log("PARTICULAR-DOF-OK");
} finally {
  await browser.close();
}
