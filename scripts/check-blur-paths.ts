// Renders Gaussians (Gaussian Blur, Glow, Drop Shadow) through their fast ways (two taps a texture read, wide ones
// at half or a quarter of the resolution, stockUtil.ts) and with exactBlurs (one read a tap, full resolution, as
// they were drawn before), on hard-edged solids and a 3 px line and on the Trap Nation 2020 Quick Start template, in
// headless Edge on this machine's GPU. Both are measured against the exact kernel rounded to 8 bits only once
// (exactBlurs.float): the fast frame may be off by no more than 3/255 anywhere, and by more than 1/255 in at most
// 0.1 % of the channels or in no more of them than the exact kernel is. The template's frame must also render at
// least twice as fast as with the exact kernel on SwiftShader. Prints BLUR-PATHS-PASSED when every case holds.
//
//   node scripts/check-blur-paths.ts [--no-build]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { openHarness } from "./lib/harness-page.ts";

const build = !process.argv.includes("--no-build");
const dir = mkdtempSync(join(tmpdir(), "aep-blur-"));
const fixture = join(dir, "blur.aep");
{
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Blur", width: 480, height: 270, frameRate: 30, duration: 1 });
  addLayer(editor, comp, { kind: "solid", name: "Line", color: [1, 1, 1], width: 300, height: 3 });
  addLayer(editor, comp, { kind: "solid", name: "Plate", color: [1, 0.8, 0.2], width: 200, height: 120 });
  writeFileSync(fixture, editor.save());
}

interface Off {
  overOne: number;
  overThree: number;
  worst: number;
}
interface Stats {
  channels: number;
  fast: Off;
  exact: Off;
  fastMs: number;
  exactMs: number;
}
let failed = 0;
const report = (label: string, s: Stats) => {
  const share = (o: Off) => `${o.worst}/255 at worst, ${((100 * o.overOne) / s.channels).toFixed(3)} % off by more than 1`;
  // Against a Gaussian rounded once: within 3/255, and off by more than 1 nowhere much, or no more than the exact kernel rounding between its passes is.
  const ok = s.fast.overThree === 0 && s.fast.overOne <= Math.max(s.channels * 0.001, s.exact.overOne);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: fast ${share(s.fast)}; exact ${share(s.exact)}; ${s.fastMs.toFixed(1)} ms against ${s.exactMs.toFixed(1)} ms exact`);
};

const BLUR = "ADBE Gaussian Blur 2";
const cases: [string, string, string, Record<number, number | number[]>][] = [
  ...[12, 23.9, 24, 30, 36, 47.9, 48, 57.6].map((b): [string, string, string, Record<number, number>] => [`Gaussian Blur ${b} (sigma ${(b / 2.4).toFixed(2)})`, "Plate", BLUR, { 1: b, 2: 1, 3: 0 }]),
  ["Gaussian Blur 30 horizontal", "Plate", BLUR, { 1: 30, 2: 2, 3: 0 }],
  ["Gaussian Blur 30 on a 3 px line", "Line", BLUR, { 1: 30, 2: 1, 3: 0 }],
  ["Gaussian Blur 30 with Repeat Edge Pixels", "Plate", BLUR, { 1: 30, 2: 1, 3: 1 }],
  ["Glow radius 30", "Plate", "ADBE Glo2", { 1: 2, 2: 100, 3: 30, 4: 1, 5: 2, 6: 3, 7: 1, 14: 1 }],
  ["Glow radius 50", "Plate", "ADBE Glo2", { 1: 2, 2: 100, 3: 50, 4: 1, 5: 2, 6: 3, 7: 1, 14: 1 }],
  ["Glow radius 30 intensity 1.5", "Plate", "ADBE Glo2", { 1: 2, 2: 100, 3: 30, 4: 1.5, 5: 2, 6: 3, 7: 1, 14: 1 }],
  ["Glow radius 50 intensity 1.5", "Plate", "ADBE Glo2", { 1: 2, 2: 100, 3: 50, 4: 1.5, 5: 2, 6: 3, 7: 1, 14: 1 }],
  ["Drop Shadow softness 30", "Plate", "ADBE Drop Shadow", { 1: [0, 0, 0, 1], 2: 200, 3: 135, 4: 12, 5: 30, 6: 0 }],
];

try {
  {
    const { browser, page } = await openHarness(fixture, { build });
    for (const [label, layer, matchName, values] of cases) {
      await page.evaluate(([l, m, v]) => (globalThis as any).aepHarness.setEffect("Blur", l, m, v), [layer, matchName, values] as const);
      report(label, (await page.evaluate(() => (globalThis as any).aepHarness.compareBlurs("Blur", 0))) as Stats);
    }
    await browser.close();
  }
  {
    const { execSync } = await import("node:child_process");
    execSync(`node scripts/quickstart-sample.ts refs/fixtures/fxmisc_audio/fxmisc_music.wav --out "${dir}"`, { stdio: "ignore" });
    const { browser, page } = await openHarness(join(dir, "trap-nation-2020.aep"), { build: false });
    for (const t of [0.5, 1, 2]) report(`Trap Nation 2020 at ${t} s (Glow radius 30 on the ring)`, (await page.evaluate((time) => (globalThis as any).aepHarness.compareBlurs("Trap Nation 2020", time), t)) as Stats);
    await browser.close();
  }
  {
    // On a GPU as slow as a phone's or slower (SwiftShader), where the blurs' work shows in the frame's time; frames
    // rendered as an export renders them, the layers that did not change reused.
    const { browser, page } = await openHarness(join(dir, "trap-nation-2020.aep"), { build: false, swiftshader: true });
    const frameMs = async (exact: boolean) =>
      page.evaluate(async (on) => {
        const h = (globalThis as any).aepHarness;
        h.setExactBlurs(on);
        const { frameMs } = await h.profile("Trap Nation 2020", [0.5, 1, 1.5], {});
        h.setExactBlurs(false);
        return (frameMs as number[]).reduce((a, b) => a + b, 0) / frameMs.length;
      }, exact);
    const exact = await frameMs(true);
    const fast = await frameMs(false);
    const ok = fast * 2 <= exact;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} the 1080p Trap Nation 2020 frames render at least twice as fast on SwiftShader: ${fast.toFixed(0)} ms a frame against ${exact.toFixed(0)} ms with the exact kernel`);
    await browser.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `BLUR-PATHS-FAILED (${failed})` : "BLUR-PATHS-PASSED");
process.exit(failed ? 1 : 0);
