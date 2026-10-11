// Reaches the PyTorch trainer (ml/pmatch) from the page. The dev server runs it on
// this machine's GPU (server/pmatch-trainer.ts); the headless checks' server does
// the same. Both answer a posted analysis with one JSON object per line: progress
// ({"stage", "share"}), then the model ({"model": base64}) or {"error"}.
import type { Trainer } from "./pipeline.ts";

/** Where the dev server's trainer listens, and the meta tag holding the token its page must send. */
export const TRAINER_PATH = "/__aep/pmatch/train";
export const TRAINER_META = "aep-pmatch-trainer";

/** Posts `dataset` to the trainer at `url` and resolves with the model it trained. */
export async function streamTraining(url: string, dataset: Uint8Array<ArrayBuffer>, onProgress: (stage: string, share: number) => void, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { method: "POST", body: new Blob([dataset]), headers: { "content-type": "application/octet-stream" }, signal });
  if (!response.ok || !response.body) throw new Error(`The trainer refused the request (${response.status} ${await response.text().catch(() => "")}).`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += value ?? "";
    const lines = pending.split("\n");
    pending = done ? "" : lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { stage?: string; share?: number; model?: string; error?: string };
      if (message.error) throw new Error(message.error);
      if (message.model) return Uint8Array.from(atob(message.model), (c) => c.charCodeAt(0));
      if (message.stage) onProgress(message.stage, message.share ?? 0);
    }
    if (done) throw new Error("The trainer stopped without a model.");
  }
}

/** The dev server's trainer, or null when the page was not served by a dev server that has one. */
export function devServerTrainer(): Trainer | null {
  const token = typeof document === "undefined" ? null : document.querySelector<HTMLMetaElement>(`meta[name="${TRAINER_META}"]`)?.content;
  if (!token) return null;
  return (dataset, onProgress, signal) => streamTraining(`${TRAINER_PATH}?token=${encodeURIComponent(token)}`, dataset, onProgress, signal);
}
