// Reports which WebCodecs encoder/decoder configurations Edge supports, in the
// headless swiftshader setup the pixel gates use and with the GPU.
//   node scripts/probe-codecs.ts [--headed]
import { chromium } from "playwright-core";

const CONFIGS = [
  { label: "H.264 Baseline 3.1", codec: "avc1.42001f" },
  { label: "H.264 Main 4.0", codec: "avc1.4d0028" },
  { label: "H.264 High 4.0", codec: "avc1.640028" },
  { label: "VP9 profile 0", codec: "vp09.00.10.08" },
  { label: "VP9 profile 0 + alpha", codec: "vp09.00.10.08", alpha: "keep" },
  { label: "VP8", codec: "vp8" },
  { label: "VP8 + alpha", codec: "vp8", alpha: "keep" },
  { label: "AV1", codec: "av01.0.04M.08" },
];

const setups = [
  { name: "headless swiftshader (gate setup)", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  { name: "headless GPU", headless: true, args: [] as string[] },
  ...(process.argv.includes("--headed") ? [{ name: "headed GPU (regular Edge)", headless: false, args: [] as string[] }] : []),
];

for (const setup of setups) {
  const browser = await chromium.launch({ channel: "msedge", headless: setup.headless, args: setup.args });
  const page = await browser.newPage();
  // WebCodecs needs a secure context; about:blank is not one.
  await page.route("https://aep.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
  await page.goto("https://aep.test/");
  const result = await page.evaluate(async (configs) => {
    const out: string[] = [`userAgent ${navigator.userAgent}`];
    if (typeof VideoEncoder === "undefined") return [...out, "VideoEncoder is not available"];
    for (const c of configs) {
      const base = { codec: c.codec, width: 640, height: 360, bitrate: 2_000_000, framerate: 24 };
      const enc: string[] = [];
      for (const hardwareAcceleration of ["prefer-software", "prefer-hardware"] as const) {
        const config = { ...base, hardwareAcceleration, ...(c.alpha ? { alpha: c.alpha as AlphaOption } : {}) };
        try {
          const r = await VideoEncoder.isConfigSupported(config);
          enc.push(`${hardwareAcceleration}=${r.supported ? "yes" : "no"}`);
        } catch (e) {
          enc.push(`${hardwareAcceleration}=error(${(e as Error).message})`);
        }
      }
      let dec = "?";
      try {
        dec = (await VideoDecoder.isConfigSupported({ codec: c.codec })).supported ? "yes" : "no";
      } catch (e) {
        dec = `error(${(e as Error).message})`;
      }
      out.push(`${c.label.padEnd(24)} encode ${enc.join(" ")}  decode ${dec}`);
    }
    return out;
  }, CONFIGS);
  console.log(`== ${setup.name}`);
  for (const line of result) console.log(`  ${line}`);
  await browser.close();
}
