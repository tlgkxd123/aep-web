// Drives expression editing and Timeline value editing in the running dev server's app
// (headless Edge): Alt+click a stopwatch, type with completions, apply, break the
// expression to see its error, and change an effect popup from the Timeline.
//
//   node scripts/check-expression-ui.ts <project.aep> <comp name> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compName, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
const step = (text: string) => console.log(`- ${text}`);
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(4000);
for (let pass = 0; pass < 300; pass++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);

const timeline = page.locator('[role="tree"]').filter({ has: page.locator(".tl-row") }).first();
await timeline.locator(".tl-row .twirl").first().click();
await page.getByRole("button", { name: "Expand Transform" }).first().click();
const opacity = page.locator('[role="treeitem"][aria-label="Opacity"]').first();
step(`Opacity row: ${await opacity.count()}`);

step(`Opacity stopwatch is a button: ${await opacity.locator("button.stopwatch").count()}`);
await opacity.locator("button.stopwatch").click({ modifiers: ["Alt"] });
await page.waitForTimeout(800);
step(`expression rows: ${await page.locator(".tl-expr-row").count()}, alerts: ${JSON.stringify(await page.locator('[role="alertdialog"], .alert, .modal').allInnerTexts())}`);
const field = page.getByRole("textbox", { name: "Expression: Opacity" });
await field.waitFor({ timeout: 5000 }).catch(async (e) => {
  await page.screenshot({ path: "refs/probe/expression-ui-fail.png" });
  throw e;
});
step(`after Alt+click the field opens with: ${JSON.stringify(await field.inputValue())}, focused: ${await field.evaluate((el) => el === document.activeElement)}`);

await page.keyboard.press("Control+A");
await page.keyboard.type("wig");
const options = page.getByRole("option");
step(`completions for "wig": ${(await page.getByRole("listbox", { name: "Completions" }).getByRole("option").allInnerTexts()).map((t) => t.split("\n")[0]).join(" | ")}`);
void options;
await opacity.locator("xpath=..").screenshot({ path: "refs/probe/expression-editor.png" }).catch(() => undefined);
await page.locator(".expr-editor").screenshot({ path: "refs/probe/expression-field.png" }).catch(() => undefined);
await page.screenshot({ path: "refs/probe/expression-typing.png", clip: { x: 0, y: 560, width: 1100, height: 420 } });
await page.keyboard.press("Tab");
await page.keyboard.type("2, 30");
step(`after Tab and typing: ${JSON.stringify(await field.inputValue())}`);
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(800);
const opacityExpression = page.locator('[role="treeitem"][aria-label="Expression: Opacity"]');
const code = opacityExpression.locator(".tl-expr");
step(`applied expression: ${JSON.stringify(await code.innerText())}`);
step(`Opacity value red (driven by the expression): ${await opacity.locator(".c-prop-value.has-expression").count()}`);
step(`Opacity value now: ${await opacity.locator(".c-prop-value").innerText()}`);

await code.click();
await page.getByRole("textbox", { name: "Expression: Opacity" }).waitFor();
await page.keyboard.press("Control+A");
await page.keyboard.type("thisComp.layer(\"nope\").transform.opacity");
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(800);
step(`error shown: ${JSON.stringify(await opacityExpression.locator(".tl-expr-error").innerText().catch(() => "(none)"))}`);

await opacityExpression.getByRole("button", { name: "Disable expression" }).click();
await page.waitForTimeout(400);
step(`after the = toggle the expression is disabled: ${await opacityExpression.getByRole("button", { name: "Enable expression" }).count() === 1}`);

await page.getByRole("button", { name: "Expand Effects" }).first().click().catch(() => undefined);
await page.waitForTimeout(300);
for (let i = 0; i < 10; i++) {
  const closed = page.locator(".tl-row.role-effect button.twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
  await page.waitForTimeout(150);
}
const popups = page.locator(".tl-row.tl-prop button.ae-select");
const scrubs = page.locator('.tl-row.tl-prop [role="treeitem"], .tl-row.tl-prop .c-prop-value [role="spinbutton"]');
step(`editable effect popups in the Timeline: ${await popups.count()}, scrubbable values: ${await scrubs.count()}`);
if (await popups.count()) {
  const popup = popups.first();
  const before = await popup.innerText();
  await popup.click();
  const items = page.locator(".context-menu").getByRole("menuitem");
  const labels = (await items.allInnerTexts()).map((l) => l.trim());
  const pick = labels.findIndex((l) => l && l !== before.trim());
  if (pick >= 0) await items.nth(pick).click();
  await page.waitForTimeout(400);
  step(`effect popup changed from ${JSON.stringify(before)} to ${JSON.stringify(await popups.first().innerText())} (menu: ${labels.join(", ")})`);
}
await page.screenshot({ path: "refs/probe/expression-ui.png" });
step("screenshot: refs/probe/expression-ui.png");
await browser.close();
