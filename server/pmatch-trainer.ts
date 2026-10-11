// Trains the Particle Match world model in PyTorch (ml/pmatch) on this machine's GPU
// for Extra > Particle Match: the page posts its analysis of a reference window
// (src/extra/pmatch/dataset.ts), the trainer runs through uv, and its progress and
// then the model stream back as JSON lines (src/extra/pmatch/trainer.ts).
//
// As a dev-server plugin only the page this dev server served can use it: every
// request needs the per-start token injected into index.html, from the same origin.
// The headless checks' server (scripts/lib/pmatch-browser.ts) calls the handler too.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { TRAINER_META, TRAINER_PATH } from "../src/extra/pmatch/trainer.ts";

/** The trainer's uv project. */
export const TRAINER_PROJECT = fileURLToPath(new URL("../ml/pmatch", import.meta.url));
const MAX_DATASET = 1 << 30;
/** Lines of the trainer's error output kept for a failure message. */
const ERROR_LINES = 12;

export interface TrainerRun {
  model: Buffer;
  report: Record<string, number>;
  trainer: Record<string, unknown>;
}

export interface TrainerOptions {
  signal?: AbortSignal;
  /** Keeps the analysis, the model and the PyTorch checkpoint in this folder (otherwise a temporary one is removed). */
  keep?: string;
  /** "cuda" or "cpu"; the trainer's default is the GPU when there is one. */
  device?: string;
}

function stop(pid: number | undefined): void {
  if (pid === undefined) return;
  // uv starts Python as a child of its own; on Windows only a tree kill ends both.
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else process.kill(pid, "SIGTERM");
}

/** The run in progress: trainings take turns (they share the GPU and the kept folder). */
let turn: Promise<unknown> = Promise.resolve();

/** Runs the trainer on an analysis once the trainings before it have finished; `onProgress` gets its stages with shares from 0 to 1. */
export function runTrainer(dataset: Uint8Array, onProgress: (stage: string, share: number) => void, options: TrainerOptions = {}): Promise<TrainerRun> {
  const run = turn.then(() => {
    if (options.signal?.aborted) throw new DOMException("Training was cancelled.", "AbortError");
    return train(dataset, onProgress, options);
  });
  turn = run.catch(() => {});
  return run;
}

function train(dataset: Uint8Array, onProgress: (stage: string, share: number) => void, options: TrainerOptions): Promise<TrainerRun> {
  const dir = options.keep ?? mkdtempSync(join(tmpdir(), "aep-pmatch-"));
  mkdirSync(dir, { recursive: true });
  const datasetPath = join(dir, "dataset.safetensors");
  const modelPath = join(dir, "model-raw.pmwm");
  writeFileSync(datasetPath, dataset);
  const args = ["run", "--project", TRAINER_PROJECT, "python", "-m", "pmatch", "train", datasetPath, "--out", modelPath, "--checkpoint", join(dir, "model.pt")];
  if (options.device) args.push("--device", options.device);
  return new Promise<TrainerRun>((ok, fail) => {
    const child = spawn("uv", args, { cwd: TRAINER_PROJECT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    let pending = "";
    let result: TrainerRun | null = null;
    let failure: string | null = null;
    const errors: string[] = [];
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        let message: { stage?: string; share?: number; done?: boolean; error?: string; report?: Record<string, number>; trainer?: Record<string, unknown> };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) failure = message.error;
        else if (message.done) result = { model: readFileSync(modelPath), report: message.report ?? {}, trainer: message.trainer ?? {} };
        else if (message.stage) onProgress(message.stage, message.share ?? 0);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors.push(...chunk.split(/\r?\n/).filter((l) => l.trim()));
      errors.splice(0, Math.max(0, errors.length - ERROR_LINES));
    });
    const abort = () => stop(child.pid);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => fail(new Error(`The PyTorch trainer could not start (is uv installed?): ${e.message}`)));
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
      if (options.signal?.aborted) fail(new DOMException("Training was cancelled.", "AbortError"));
      else if (result && code === 0) ok(result);
      else fail(new Error(failure ?? `The PyTorch trainer stopped (exit code ${code}): ${errors.join("\n")}`));
    });
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("the analysis is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

/** Answers a posted analysis with the trainer's progress, then the model or the error, one JSON object per line. */
export async function handleTrainRequest(req: IncomingMessage, res: ServerResponse, options: Omit<TrainerOptions, "signal"> = {}): Promise<void> {
  let dataset: Buffer;
  try {
    dataset = await readBody(req, MAX_DATASET);
  } catch (e) {
    res.writeHead(413, { "content-type": "text/plain" }).end((e as Error).message);
    return;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);
  try {
    const run = await runTrainer(dataset, (stage, share) => send({ stage, share }), { ...options, signal: controller.signal });
    send({ model: run.model.toString("base64"), report: run.report, trainer: run.trainer });
  } catch (e) {
    send({ error: (e as Error).message });
  }
  res.end();
}

export function pmatchTrainer(): Plugin {
  const token = randomBytes(24).toString("hex");
  return {
    name: "aep-pmatch-trainer",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: TRAINER_META, content: token }, injectTo: "head" }],
    configureServer(server) {
      server.middlewares.use(TRAINER_PATH, (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        // Same-origin only: a foreign page could send requests but never learns the token.
        if ((req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) || req.method !== "POST" || url.searchParams.get("token") !== token) {
          res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
          return;
        }
        void handleTrainRequest(req, res, { keep: resolve("dist-tools/pmatch/app") });
      });
    },
  };
}
