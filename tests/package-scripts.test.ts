import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("package scripts", () => {
  test("check runs the CI gates in order", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts?: { check?: string };
    };
    expect(pkg.scripts?.check).toBe("tsc --noEmit && vitest run && vite build");
  });
});
