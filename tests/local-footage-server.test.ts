// The dev server's search for footage near the project file the browser opened (server/local-footage.ts).
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findProjectFile, ProjectFolder } from "../server/local-footage.ts";

let root: string;
const at = (...parts: string[]) => join(root, ...parts);

function put(path: string, text = path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aep-near-"));
  put(at("work", "Proj", "Proj.aep"), "RIFX project");
  put(at("work", "Proj", "clip.mp4"));
  put(at("work", "Proj", "renders", "v2", "photo.jpg"));
  put(at("work", "Proj", "renders", "v2", "0001.png"));
  put(at("work", "assets", "straight.png"));
  // A copy elsewhere, same name: told apart by size and modification time.
  put(at("other", "Proj.aep"), "RIFX another project");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("near the project", () => {
  test("finds the project file the browser describes by name, size and modification time", async () => {
    const path = at("work", "Proj", "Proj.aep");
    const { size, mtimeMs } = statSync(path);
    expect(await findProjectFile("Proj.aep", size, mtimeMs, [], [root])).toBe(path);
    expect(await findProjectFile("Proj.aep", size + 1, mtimeMs, [], [root])).toBeNull();
    // Two files that match cannot be told apart.
    const twin = at("other", "Proj.aep");
    writeFileSync(twin, "RIFX project");
    utimesSync(twin, new Date(mtimeMs), new Date(mtimeMs));
    expect(await findProjectFile("Proj.aep", size, mtimeMs, [], [root])).toBeNull();
    writeFileSync(twin, "RIFX another project");
  });

  test("resolves footage beside the project, through its relative link, and below its folder", async () => {
    const near = new ProjectFolder(at("work", "Proj"));
    expect(await near.resolve("D:\\Jobs\\Proj\\clip.mp4")).toBe(at("work", "Proj", "clip.mp4"));
    expect(await near.resolve("/Volumes/Work/Proj/assets/straight.png", "assets/straight.png")).toBe(at("work", "assets", "straight.png"));
    expect(await near.resolve("D:\\Jobs\\photo.jpg")).toBe(at("work", "Proj", "renders", "v2", "photo.jpg"));
    // A bare frame number needs its folder to match as well.
    expect(await near.resolve("D:\\Jobs\\comp\\0001.png")).toBeNull();
    expect(await near.resolve("D:\\Jobs\\v2\\0001.png")).toBe(at("work", "Proj", "renders", "v2", "0001.png"));
    expect(await near.resolve("D:\\Jobs\\missing.mov")).toBeNull();
  });
});
