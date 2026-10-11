// @vitest-environment jsdom
// The Particle Match window (Extra > Particle Match): choosing the reference, the training window and its
// strip, training, saving a model and exporting it to Particular. Decoding, training and the GPU preview are
// stand-ins; the model, the export and the project are the real ones.
import { act, cleanup, fireEvent, render as renderLoose, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ComponentType, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { encodeModel, type ParticleWorldModel } from "../src/extra/pmatch/model.ts";
import { PARTICULAR } from "../src/extra/pmatch/particular.ts";
import type { ParticleMatchProject } from "../src/ui/ParticleMatchExport.tsx";
import { syntheticModel } from "./pmatch-fixtures.ts";

const mocks = vi.hoisted(() => ({
  finishTraining: null as ((model: ParticleWorldModel) => void) | null,
  saveFileBytes: vi.fn(async (_bytes: Uint8Array, name: string, _description: string, extension: string) => `${name}${extension}`),
}));

vi.mock("../src/extra/pmatch/frames.ts", async (original) => ({
  ...(await original<object>()),
  videoInfo: async () => ({ track: {}, width: 1920, height: 1080, times: [], frameRate: 60, duration: 120 }),
}));
vi.mock("../src/extra/pmatch/soundtrack.ts", async (original) => ({ ...(await original<object>()), fileSound: async () => null }));
vi.mock("../src/extra/pmatch/preview.ts", () => ({
  ModelPreview: class {
    draw() {}
    dispose() {}
  },
}));
vi.mock("../src/extra/pmatch/trainer.ts", async (original) => ({ ...(await original<object>()), devServerTrainer: () => async () => new Uint8Array() }));
vi.mock("../src/extra/pmatch/pipeline.ts", async (original) => ({
  ...(await original<object>()),
  trainModel: () =>
    new Promise((resolve) => {
      mocks.finishTraining = (model) => resolve({ model, tracks: [], features: null });
    }),
}));
vi.mock("../src/ui/projectFiles.ts", async (original) => ({ ...(await original<object>()), saveFileBytes: mocks.saveFileBytes }));
vi.mock("../src/media/localFootage.ts", async (original) => ({ ...(await original<object>()), identifyLocal: async (files: File[]) => files.map(() => null) }));

type Dialog = ComponentType<{ onClose: () => void; project?: ParticleMatchProject }>;

/** Renders as the app does (src/main.tsx): in StrictMode, which mounts, unmounts and mounts again. */
const render = (element: ReactElement) => renderLoose(<StrictMode>{element}</StrictMode>);

/**
 * A fresh copy of the window's module (its session lives in the module until the page is left), and of the
 * project module from the same module graph.
 */
async function fresh() {
  vi.resetModules();
  const Dialog: Dialog = (await import("../src/ui/ParticleMatchDialog.tsx")).ParticleMatchDialog;
  const project = await import("../src/edit/project.ts");
  return { Dialog, project };
}

const video = () => new File([new Uint8Array(64)], "reference.mp4", { type: "video/mp4" });
const modelFile = () => new File([Uint8Array.from(encodeModel(syntheticModel(null)))], "synthetic.pmwm");
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const dialog = () => screen.getByRole("dialog", { name: "Particle Match" });
const windowFields = () => [field("Training start (seconds)").value, field("Training end (seconds)").value];
const effects = (layer: Layer) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).map((e) => e.matchName);

async function chooseVideo() {
  fireEvent.change(field("Reference video"), { target: { files: [video()] } });
  await screen.findByRole("button", { name: "Analyze & Train" });
}

async function openModel() {
  fireEvent.change(field("Trained model"), { target: { files: [modelFile()] } });
  await screen.findByRole("button", { name: "Save Model…" });
}

const playheads = new WeakMap<HTMLMediaElement, number>();

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:reference");
  URL.revokeObjectURL = vi.fn();
  // jsdom plays no media: the playhead is only where it was put.
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return playheads.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, t: number) {
      playheads.set(this, t);
    },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // jsdom's Blob reads only through FileReader; the effect templates and models are read as buffers and streams.
  if (!Blob.prototype.arrayBuffer) {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
  if (!Blob.prototype.stream) {
    Blob.prototype.stream = function (this: Blob) {
      const blob = this;
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
          controller.close();
        },
      }) as ReturnType<Blob["stream"]>;
    };
  }
  mocks.saveFileBytes.mockClear();
  mocks.finishTraining = null;
});

afterEach(cleanup);

describe("Particle Match window", () => {
  it("keeps Analyze & Train disabled until a reference video is chosen and the training window is valid", async () => {
    const { Dialog } = await fresh();
    render(<Dialog onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Analyze & Train" })).toBeNull();

    await chooseVideo();
    expect(button("Analyze & Train").disabled).toBe(false);
    fireEvent.change(field("Training start (seconds)"), { target: { value: "62" } });
    expect(button("Analyze & Train").disabled).toBe(true);
    expect(screen.getByText("Train on at least 5 seconds.")).toBeTruthy();
    fireEvent.change(field("Training end (seconds)"), { target: { value: "200" } });
    expect(button("Analyze & Train").disabled).toBe(true);
    expect(screen.getByText("The window must lie within 0 – 120 s.")).toBeTruthy();
    fireEvent.change(field("Training end (seconds)"), { target: { value: "100" } });
    expect(button("Analyze & Train").disabled).toBe(false);
  });

  it("takes a reference video dropped on it", async () => {
    const { Dialog } = await fresh();
    render(<Dialog onClose={() => {}} />);
    const backdrop = dialog().parentElement!;
    const dataTransfer = { types: ["Files"], files: [video()] };
    fireEvent.dragEnter(backdrop, { dataTransfer });
    fireEvent.drop(backdrop, { dataTransfer });
    expect((await screen.findByRole("button", { name: "Analyze & Train" })).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("reference.mp4")).toBeTruthy();
  });

  it("follows its fields, its strip handles and B / N at the playhead", async () => {
    const { Dialog } = await fresh();
    render(<Dialog onClose={() => {}} />);
    await chooseVideo();
    const start = () => screen.getByRole("slider", { name: "Training window start" });
    const end = () => screen.getByRole("slider", { name: "Training window end" });
    expect(windowFields()).toEqual(["36", "66"]);
    expect([start().getAttribute("aria-valuenow"), end().getAttribute("aria-valuenow")]).toEqual(["36", "66"]);

    fireEvent.keyDown(start(), { key: "ArrowRight" });
    fireEvent.keyDown(end(), { key: "ArrowRight", shiftKey: true });
    expect(windowFields()).toEqual(["37", "76"]);

    fireEvent.change(field("Training start (seconds)"), { target: { value: "40" } });
    expect(start().getAttribute("aria-valuenow")).toBe("40");

    const reference = dialog().querySelector("video")!;
    reference.currentTime = 50;
    fireEvent.keyDown(dialog(), { key: "b" });
    expect(windowFields()).toEqual(["50", "76"]);
    reference.currentTime = 90;
    fireEvent.keyDown(dialog(), { key: "n" });
    expect(windowFields()).toEqual(["50", "90"]);
  });

  it("does not close on Escape while training, then offers saving and exporting the model", async () => {
    const { Dialog } = await fresh();
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    await chooseVideo();
    fireEvent.click(button("Analyze & Train"));
    await screen.findByRole("button", { name: "Cancel Training" });
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(button("Close").disabled).toBe(true);

    await act(async () => mocks.finishTraining!(syntheticModel(null)));
    expect(button("Export to Particular…")).toBeTruthy();
    fireEvent.click(button("Save Model…"));
    await screen.findByText("Saved “synthetic.pmwm”.");
    const [bytes, name, description, extension] = mocks.saveFileBytes.mock.calls[0];
    expect([name, description, extension]).toEqual(["synthetic", "Particle Match model", ".pmwm"]);
    expect(Array.from(bytes)).toEqual(Array.from(encodeModel(syntheticModel(null))));

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers saving and exporting a model it opens", async () => {
    const { Dialog } = await fresh();
    render(<Dialog onClose={() => {}} />);
    await openModel();
    expect(button("Export to Particular…")).toBeTruthy();
    expect(screen.getByText("PyTorch test on test")).toBeTruthy();
  });

  it("adds the Particular layers to the chosen comp of the open project in one undoable step", async () => {
    const { Dialog, project } = await fresh();
    const editor = project.newProject();
    const main = project.newComposition(editor, { ...project.DEFAULT_COMP_SETTINGS, name: "Main", duration: 5 });
    const other = project.newComposition(editor, { ...project.DEFAULT_COMP_SETTINGS, name: "Other", width: 1280, height: 720, duration: 5 });
    const before = editor.save();
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} project={{ editor, project: editor.project, activeCompId: main.id, onAdded }} />);
    await openModel();
    fireEvent.click(button("Export to Particular…"));
    fireEvent.change(screen.getByLabelText("Composition"), { target: { value: String(other.id) } });
    const add = (await screen.findByRole("button", { name: /^Add \d+ Layers?$/ }, { timeout: 5000 })) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());

    const comp = editor.project.items.get(other.id) as CompItem;
    const [compId, ids] = onAdded.mock.calls[0] as [number, number[]];
    expect(compId).toBe(other.id);
    expect(comp.layers.map((l) => l.id)).toEqual(ids);
    expect(comp.layers.every((l) => effects(l)[0] === PARTICULAR)).toBe(true);
    expect((editor.project.items.get(main.id) as CompItem).layers).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
    editor.undo();
    expect(Buffer.from(editor.save()).equals(Buffer.from(before))).toBe(true);
  });

  it("saves a new .aep with the Particular layers through the file picker", async () => {
    const { Dialog } = await fresh();
    render(<Dialog onClose={() => {}} />);
    await openModel();
    fireEvent.click(button("Export to Particular…"));
    expect((screen.getByRole("radio", { name: "Save as a new project (.aep)" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Speed follows"), { target: { value: "none" } });
    fireEvent.change(field("Composition name"), { target: { value: "Learned" } });
    const save = button("Save .aep…");
    await waitFor(() => expect(save.disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(save);
    await screen.findByText(/^Saved “synthetic - Particular\.aep”/, {}, { timeout: 5000 });

    const [bytes, name, description, extension] = mocks.saveFileBytes.mock.calls[0];
    expect([name, description, extension]).toEqual(["synthetic - Particular", "After Effects Project", ".aep"]);
    const comps = [...Editor.fromBytes(bytes).project.items.values()].filter((i): i is CompItem => i.kind === "comp");
    expect(comps.map((c) => [c.name, c.width, c.height])).toEqual([["Learned", 1280, 720]]);
    expect(comps[0].layers.length).toBeGreaterThan(0);
    expect(comps[0].layers.every((l) => effects(l)[0] === PARTICULAR)).toBe(true);
  });

  it("keeps its session when closed and reopened", async () => {
    const { Dialog } = await fresh();
    const first = render(<Dialog onClose={() => {}} />);
    await chooseVideo();
    fireEvent.change(field("Training start (seconds)"), { target: { value: "12" } });
    fireEvent.change(field("Training end (seconds)"), { target: { value: "48" } });
    await openModel();
    first.unmount();

    render(<Dialog onClose={() => {}} />);
    expect(button("Save Model…")).toBeTruthy();
    fireEvent.click(button("Train Again"));
    expect(screen.getByText("reference.mp4")).toBeTruthy();
    expect(windowFields()).toEqual(["12", "48"]);
  });
});
