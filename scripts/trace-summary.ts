// Summarises a Chrome trace (as check-video-playback.ts TRACE=1 writes): busy time per process and thread, the
// events taking the most time on each busy thread, and the longest single events.
//
//   node scripts/trace-summary.ts <trace.json> [top=15] [thread=CrGpuMain]
import { readFileSync } from "node:fs";

const [file, topArg = "15", threadArg = "CrGpuMain"] = process.argv.slice(2);
const top = Number(topArg);
const raw = JSON.parse(readFileSync(file, "utf8"));
const events: { ph: string; name: string; cat: string; pid: number; tid: number; ts: number; dur?: number; args?: any }[] = Array.isArray(raw) ? raw : raw.traceEvents;

const processNames = new Map<number, string>();
const threadNames = new Map<string, string>();
for (const e of events) {
  if (e.ph !== "M") continue;
  if (e.name === "process_name") processNames.set(e.pid, e.args?.name);
  if (e.name === "thread_name") threadNames.set(`${e.pid}:${e.tid}`, e.args?.name);
}
const label = (pid: number, tid: number) => `${processNames.get(pid) ?? pid}/${threadNames.get(`${pid}:${tid}`) ?? tid}`;

// Complete events, plus begin/end pairs matched per thread.
const slices: { name: string; thread: string; ts: number; dur: number; depth: number }[] = [];
const open = new Map<string, { name: string; ts: number }[]>();
for (const e of events) {
  const key = `${e.pid}:${e.tid}`;
  if (e.ph === "X" && e.dur !== undefined) slices.push({ name: e.name, thread: label(e.pid, e.tid), ts: e.ts, dur: e.dur, depth: 0 });
  else if (e.ph === "B") (open.get(key) ?? open.set(key, []).get(key)!).push({ name: e.name, ts: e.ts });
  else if (e.ph === "E") {
    const b = open.get(key)?.pop();
    if (b) slices.push({ name: b.name, thread: label(e.pid, e.tid), ts: b.ts, dur: e.ts - b.ts, depth: 0 });
  }
}
const start = slices.reduce((m, s) => Math.min(m, s.ts), Infinity);
const end = slices.reduce((m, s) => Math.max(m, s.ts + s.dur), -Infinity);
console.log(`${slices.length} slices over ${((end - start) / 1e6).toFixed(1)} s`);

// Busy time per thread: the union of its top-level slices.
const byThread = new Map<string, typeof slices>();
for (const s of slices) (byThread.get(s.thread) ?? byThread.set(s.thread, []).get(s.thread)!).push(s);
const busy: [string, number][] = [];
for (const [thread, list] of byThread) {
  list.sort((a, b) => a.ts - b.ts);
  let total = 0;
  let reach = -Infinity;
  for (const s of list) {
    const from = Math.max(s.ts, reach);
    if (s.ts + s.dur > from) total += s.ts + s.dur - from;
    reach = Math.max(reach, s.ts + s.dur);
  }
  busy.push([thread, total / 1000]);
}
busy.sort((a, b) => b[1] - a[1]);
console.log("\nbusy ms per thread:");
for (const [thread, ms] of busy.slice(0, 14)) console.log(`  ${ms.toFixed(0).padStart(7)}  ${thread}`);

for (const [thread] of busy.slice(0, 6)) {
  const totals = new Map<string, { ms: number; n: number; max: number }>();
  for (const s of byThread.get(thread)!) {
    const t = totals.get(s.name) ?? { ms: 0, n: 0, max: 0 };
    t.ms += s.dur / 1000;
    t.n++;
    t.max = Math.max(t.max, s.dur / 1000);
    totals.set(s.name, t);
  }
  console.log(`\n${thread}: events by total ms (inclusive)`);
  for (const [name, t] of [...totals].sort((a, b) => b[1].ms - a[1].ms).slice(0, top)) {
    console.log(`  ${t.ms.toFixed(0).padStart(7)} ms  ${String(t.n).padStart(5)}x  max ${t.max.toFixed(0).padStart(5)}  ${name}`);
  }
}

console.log("\nlongest events:");
for (const s of [...slices].sort((a, b) => b.dur - a.dur).slice(0, top)) {
  console.log(`  ${(s.dur / 1000).toFixed(0).padStart(6)} ms at ${((s.ts - start) / 1e6).toFixed(2)} s  ${s.name}  [${s.thread}]`);
}

// What a thread (CrGpuMain unless named) spends its longest tasks on: the events nested in them, by total time.
const worst = busy.find(([thread]) => thread.includes(threadArg));
if (worst) {
  const tasks = byThread.get(worst[0])!.filter((s) => s.name === "RunTask").sort((a, b) => b.dur - a.dur).slice(0, 5);
  const inside = new Map<string, number>();
  for (const s of byThread.get(worst[0])!) {
    if (s.name === "RunTask" || !tasks.some((t) => s.ts >= t.ts && s.ts + s.dur <= t.ts + t.dur)) continue;
    inside.set(s.name, (inside.get(s.name) ?? 0) + s.dur / 1000);
  }
  console.log(`\nevents inside the ${tasks.length} longest tasks of ${worst[0]} (${tasks.map((t) => (t.dur / 1000).toFixed(0)).join(", ")} ms):`);
  for (const [name, ms] of [...inside].sort((a, b) => b[1] - a[1]).slice(0, 3 * top)) console.log(`  ${ms.toFixed(0).padStart(7)} ms  ${name}`);
}
