// Scratch: why does the Effect Controls name fall back to the match name for Portal Cards?
import { containerText } from "../src/aep/decode.ts";
import { findChild, findList } from "../src/aep/riff.ts";
import { effectLibrary } from "../src/edit/effectLibrary.ts";
import { PORTAL_CARDS } from "../src/edit/portalCards.ts";

const library = await effectLibrary();
const effect = library.find((e) => e.matchName === PORTAL_CARDS)!;
const sspc = effect.template.instance;
const fnam = findChild(sspc, "fnam");
console.log("fnam present:", !!fnam);
console.log("fnam.data length:", fnam?.data.length);
console.log("fnam.children:", fnam?.children?.map((c) => c.type).join(",") ?? "(none)");
console.log("containerText(fnam):", JSON.stringify(containerText(fnam)));
const tdgp = findList(sspc, "tdgp")!;
const tdsn = findChild(tdgp, "tdsn");
console.log("tdsn.children:", tdsn?.children?.map((c) => c.type).join(",") ?? "(none)");
console.log("containerText(tdsn):", JSON.stringify(containerText(tdsn)));
// A parameter's tdsn, set through setName, for comparison.
const nameSet = findChild(findList(tdgp, "tdbs")!, "tdsn");
console.log("param tdsn.children:", nameSet?.children?.map((c) => c.type).join(",") ?? "(none)");
console.log("containerText(param tdsn):", JSON.stringify(containerText(nameSet)));
