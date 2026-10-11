// Summarizes pixel-report.ts output per comp: frames passing / total, worst mean error.
//
//   node scripts/pixel-summary.ts <pixel-report log> [--failing]
import { readFileSync } from "node:fs";

const [file, ...flags] = process.argv.slice(2);
const comps = new Map<string, { ok: number; total: number; worstMean: number; notes: Set<string> }>();
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = /^(ok  |known|DIFF|NO REF) (\S+)@(\d+)\s.*?mean (\d+\.\d+)(.*)$/.exec(line);
  if (!m) continue;
  const [, status, comp, , mean, rest] = m;
  const entry = comps.get(comp) ?? { ok: 0, total: 0, worstMean: 0, notes: new Set<string>() };
  entry.total++;
  if (status === "ok  " || status === "known") entry.ok++;
  if (status === "NO REF") entry.notes.add("no ref");
  entry.worstMean = Math.max(entry.worstMean, Number(mean));
  const note = /\[(.*)\]/.exec(rest)?.[1];
  if (note) entry.notes.add(note.slice(0, 90));
  comps.set(comp, entry);
}
let passing = 0;
for (const [comp, e] of [...comps].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (e.ok === e.total) passing++;
  if (flags.includes("--failing") && e.ok === e.total) continue;
  console.log(`${e.ok === e.total ? "PASS" : "FAIL"} ${comp.padEnd(40)} ${String(e.ok).padStart(3)}/${String(e.total).padEnd(3)} worst mean ${e.worstMean.toFixed(2)} ${[...e.notes].join("; ")}`);
}
console.log(`${passing}/${comps.size} comps pass`);
