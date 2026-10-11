// @vitest-environment jsdom
// The effect library loads once for every component waiting on it; a component unmounted meanwhile is left alone
// when it arrives, even after the test environment (and with it `window`) is gone.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

let resolve!: (effects: []) => void;
vi.mock("../src/edit/effectLibrary.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/edit/effectLibrary.ts")>()),
  loadedEffectLibrary: () => undefined,
  effectLibrary: () => new Promise((done) => (resolve = done)),
}));

const { useEffectLibrary } = await import("../src/ui/EffectsPresetsPanel.tsx");

function Probe() {
  const library = useEffectLibrary();
  return <p>{library ? `${library.length} effects` : "loading"}</p>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a component unmounted before the library loads is not updated", async () => {
  const failures: unknown[] = [];
  const onRejection = (reason: unknown) => failures.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const { unmount } = render(<Probe />);
    unmount();
    vi.stubGlobal("window", undefined);
    resolve([]);
    await new Promise((done) => setImmediate(done));
    await new Promise((done) => setImmediate(done));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  expect(failures).toEqual([]);
});

test("a mounted component shows the library once it loads", async () => {
  const { getByText } = render(<Probe />);
  getByText("loading");
  await act(async () => resolve([]));
  expect(getByText("0 effects")).toBeTruthy();
});
