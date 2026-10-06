// Replacing and importing audio files: the footage is written the way After
// Effects stores audio (MP3A/WAVE source, no frame size, exact length in samples,
// sample rate, audio flag) and reads back as audio-only footage.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSspc } from "../src/aep/decode.ts";
import type { FootageItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild, findList } from "../src/aep/riff.ts";
import { Editor } from "../src/edit/editor.ts";
import { importFootage, replaceFootage } from "../src/edit/project.ts";
import { probeMedia } from "../src/media/probe.ts";

/** A mono 16-bit PCM WAV of `samples` silent samples. */
function wav(sampleRate: number, samples: number): Blob {
  const data = samples * 2;
  const b = new DataView(new ArrayBuffer(44 + data));
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => b.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  b.setUint32(4, 36 + data, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, sampleRate, true);
  b.setUint32(28, sampleRate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  ascii(36, "data");
  b.setUint32(40, data, true);
  return new Blob([b.buffer]);
}

const FIXTURES = new URL("../refs/fixtures/footage.aep", import.meta.url);

function check(project: ReturnType<typeof parseProject>, id: number, sampleRate: number, samples: number) {
  const item = project.items.get(id) as FootageItem;
  expect(item.kind).toBe("footage");
  expect(item.hasAudio).toBe(true);
  expect(item.hasVideo).toBe(false);
  expect(item.duration).toBeCloseTo(samples / sampleRate, 9);
  const sspc = decodeSspc(findChild(findList(item.chunk!, "Pin "), "sspc")!);
  expect(sspc.sourceFormatType).toBe("WAVE");
  expect([sspc.width, sspc.height]).toEqual([0, 0]);
  expect(sspc.audioSampleRate).toBe(sampleRate);
}

describe("audio footage", () => {
  it("probes a WAV file as audio", async () => {
    const info = await probeMedia(wav(44100, 88200), "tone.wav");
    expect(info).toMatchObject({ kind: "audio", format: "WAVE", width: 0, height: 0, duration: 2, frameRate: 0, audio: { sampleRate: 44100, samples: 88200 } });
  });

  it("replaces footage with an audio file", async () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
    const item = [...editor.project.items.values()].find((i): i is FootageItem => i.kind === "footage" && i.mainSource.sourceType === "FileSource")!;
    const info = await probeMedia(wav(48000, 120000), "music.wav");
    replaceFootage(editor, item, { path: "C:/media/music.wav", info });
    check(parseProject(editor.save()), item.id, 48000, 120000);
    editor.undo();
    expect((parseProject(editor.save()).items.get(item.id) as FootageItem).hasVideo).toBe(item.hasVideo);
  });

  it("imports an audio file", async () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
    const info = await probeMedia(wav(22050, 22050), "click.wav");
    const [added] = importFootage(editor, [{ path: "C:/media/click.wav", info }]);
    check(parseProject(editor.save()), added.id, 22050, 22050);
  });
});
