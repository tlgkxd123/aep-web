// Prints the WebGL renderer the Android app's WebView draws with (the debug APK running on an emulator or a device),
// so a timing taken there can be told apart from software rendering.
//
//   node scripts/android-gpu.ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PKG = "com.zionschxma.aev3";
const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? "", "Android/Sdk"), "platform-tools/adb");
const adb = (...a: string[]) => execFileSync(adbPath, a, { encoding: "utf8" });
const pid = adb("shell", "pidof", PKG).trim();
if (!pid) throw new Error(`${PKG} is not running`);
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
const info = await page.evaluate(() => {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
    vendor: gl && ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl?.getParameter(gl.VENDOR),
    cores: navigator.hardwareConcurrency,
    memory: (navigator as { deviceMemory?: number }).deviceMemory,
  };
});
console.log(JSON.stringify(info));
await browser.close();
