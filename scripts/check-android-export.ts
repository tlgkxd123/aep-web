// The Android app (Capacitor) exports H.264 MP4: run on an emulator or a device with the debug APK installed.
//
//   node scripts/check-android-export.ts [--comp name] [--software-h264]
//
// Drives the app's WebView over DevTools: opens a fixture through the project file input, queues the comp as H.264,
// renders it, then pulls the file the app saved to Documents/aep-web and checks its MP4 structure.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { demuxMp4 } from "./lib/mp4-demux.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const PKG = "com.zionschxma.aev3";
const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = opt("--comp") ?? "roundtrip_minimax";
const OUT = resolve("dist-tools/android");
mkdirSync(OUT, { recursive: true });
const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android/Sdk"), "platform-tools/adb");
const adb = (...a: string[]) => execFileSync(adbPath, a, { encoding: "utf8" });

let failed = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};

adb("shell", "am", "force-stop", PKG);
adb("shell", "rm", "-rf", "/sdcard/Documents/aep-web");
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
let socket = "";
for (let i = 0; i < 40 && !socket; i++) {
  await new Promise((r) => setTimeout(r, 500));
  let pid = "";
  try {
    pid = adb("shell", "pidof", PKG).trim();
  } catch {
    // Not started yet.
  }
  if (pid && i > 4) socket = `webview_devtools_remote_${pid}`;
}
if (!socket) throw new Error("The app's WebView exposes no DevTools socket (is it a debug build?).");
adb("forward", "tcp:9333", `localabstract:${socket}`);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0] ?? (await browser.contexts()[0].waitForEvent("page"));
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.waitForLoadState("load");

const support = await page.evaluate(async () => {
  const video = async (hardwareAcceleration: HardwareAcceleration) =>
    (await VideoEncoder.isConfigSupported({ codec: "avc1.42e028", width: 1280, height: 720, bitrate: 4e6, framerate: 30, hardwareAcceleration })).supported;
  const audio = async (codec: string) => (await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 })).supported;
  return { ua: navigator.userAgent, h264Hardware: await video("prefer-hardware"), h264Software: await video("prefer-software"), aac: await audio("mp4a.40.2"), opus: await audio("opus") };
});
console.log(`${support.ua}\nWebCodecs: H.264 hardware ${support.h264Hardware}, software ${support.h264Software}; AAC ${support.aac}, Opus ${support.opus}`);

// --software-h264: the WebView reports no H.264 encoder, as on phones without one, so the export takes the WebAssembly encoder.
if (args.includes("--software-h264")) {
  await page.evaluate(() => {
    const supported = VideoEncoder.isConfigSupported.bind(VideoEncoder);
    VideoEncoder.isConfigSupported = async (config) => (config.codec.startsWith("avc1") ? { supported: false, config } : supported(config));
  });
}

const bytes = readFileSync(FIXTURE).toString("base64");
await page.evaluate(
  ([data, name]) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Open After Effects project"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], name));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  },
  [bytes, "roundtrip.base.aep"] as const,
);
await page.getByRole("tab", { name: "Project", exact: true }).click();
await page.getByLabel("Search project").fill(COMP);
const item = page.getByRole("tree", { name: "Project items" }).getByRole("treeitem").filter({ hasText: COMP }).first();
await item.locator(".cell-text").dblclick();
await page.getByRole("img", { name: new RegExp(`^${COMP}, `) }).waitFor({ timeout: 30_000 });

await page.getByRole("tab", { name: "Render Queue", exact: true }).click();
await page.getByRole("button", { name: "Add Active Comp" }).click();
await page.getByRole("listitem", { name: `${COMP}: Queued` }).waitFor();
await page.getByRole("button", { name: "Render", exact: true }).click();
const started = Date.now();
const finished = page.getByRole("listitem", { name: new RegExp(`^${COMP}: (Done|Failed)$`) });
await finished.waitFor({ timeout: 600_000 });
const label = (await finished.getAttribute("aria-label")) ?? "";
const error = await finished.locator(".rq-error").textContent().catch(() => null);
await page.screenshot({ path: join(OUT, "render-queue.png") });
check(label.endsWith("Done"), "the H.264 render finishes", `${label} in ${((Date.now() - started) / 1000).toFixed(1)} s${error ? ` (${error})` : ""}`);

const listing = adb("shell", "ls", "/sdcard/Documents/aep-web/").trim();
const name = listing.split(/\s+/).find((f) => f.endsWith(".mp4"));
check(!!name, "the app saves the MP4 to Documents/aep-web", listing || "nothing there");
if (name) {
  const local = join(OUT, name);
  adb("pull", `/sdcard/Documents/aep-web/${name}`, local);
  const mp4 = demuxMp4(new Uint8Array(readFileSync(local)));
  const keys = mp4.samples.map((s, i) => (s.key ? i : -1)).filter((i) => i >= 0);
  const colr = mp4.colr;
  check(
    mp4.sampleEntry === "avc1" && !!mp4.avcC && mp4.samples.length > 0 && keys[0] === 0 && keys.length < mp4.samples.length && colr?.matrix === 1 && !colr.fullRange,
    "the MP4 holds H.264 with an avcC, sync samples at the keyframes only and BT.709 colour",
    `${mp4.width}x${mp4.height}, ${mp4.samples.length} samples, key ${keys.join(",")}, colr ${JSON.stringify(colr)}${mp4.audio ? `, audio ${mp4.audio.sampleEntry}` : ""}`,
  );
  const played = await page.evaluate(async (b64) => {
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "video/mp4" }));
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error(video.error?.message ?? "error"));
    });
    return `${video.videoWidth}x${video.videoHeight}, ${video.duration.toFixed(3)} s`;
  }, readFileSync(local).toString("base64")).catch((e: Error) => `error: ${e.message}`);
  check(!played.startsWith("error"), "the WebView's <video> loads the saved MP4", played);
}
await browser.close();
console.log(failed ? `ANDROID-EXPORT-FAILED (${failed})` : "ANDROID-EXPORT-PASSED");
process.exitCode = failed ? 1 : 0;
