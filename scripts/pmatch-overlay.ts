// Diagnostics: draws pmatch-explore's dumped frame with masked tiles dimmed and that frame's
// detections circled: node scripts/pmatch-overlay.ts <frame index> [tile]
// Writes dist-tools/pmatch/explore/overlay.png.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { DETECTION_FLOATS, D_PEAK, D_X, D_Y } from "../src/extra/pmatch/detect.ts";
import { PMATCH_OUT } from "./lib/pmatch-browser.ts";

const dir = join(PMATCH_OUT, "explore");
const index = Number(process.argv[2]);
const tile = Number(process.argv[3] ?? 8);
const raw = readFileSync(join(dir, "detections.f32"));
const data = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
let found: number[] = [];
for (let at = 0; at < data.length; ) {
  const n = data[at + 1];
  if (data[at] === index) {
    for (let i = 0; i < n; i++) {
      const d = at + 2 + i * DETECTION_FLOATS;
      found.push(data[d + D_X], data[d + D_Y], data[d + D_PEAK]);
    }
  }
  at += 2 + n * DETECTION_FLOATS;
}
if (!found.length) throw new Error(`no detections recorded for frame ${index}`);
const toUrl = (name: string) => `data:image/png;base64,${readFileSync(join(dir, name)).toString("base64")}`;
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage();
  const png = await page.evaluate(
    async ([frameUrl, maskUrl, points, size]) => {
      const load = async (url: string) => createImageBitmap(await (await fetch(url)).blob());
      const frame = await load(frameUrl);
      const mask = await load(maskUrl);
      const canvas = new OffscreenCanvas(frame.width, frame.height);
      const g = canvas.getContext("2d")!;
      g.drawImage(frame, 0, 0);
      const m = new OffscreenCanvas(mask.width, mask.height).getContext("2d")!;
      m.drawImage(mask, 0, 0);
      const bits = m.getImageData(0, 0, mask.width, mask.height).data;
      g.fillStyle = "rgba(0, 0, 0, 0.65)";
      for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (bits[(y * mask.width + x) * 4] < 128) g.fillRect(x * size, y * size, size, size);
      g.lineWidth = 1.5;
      for (let i = 0; i < points.length; i += 3) {
        g.strokeStyle = points[i + 2] > 40 / 255 ? "#00ff66" : "#ffcc00";
        g.beginPath();
        g.arc(points[i], points[i + 1], 6, 0, Math.PI * 2);
        g.stroke();
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    },
    [toUrl("frame.png"), toUrl("mask.png"), found, tile] as const,
  );
  writeFileSync(join(dir, "overlay.png"), Uint8Array.from(png));
  console.log(`${found.length / 3} detections drawn`);
} finally {
  await browser.close();
}
