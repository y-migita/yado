import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectDetectionError,
  buildLifecycleArgv,
  detectPackageManagerFromNames,
  isViteOrAstro,
  resolveLaunchCommand,
  selectLifecycleScript,
} from "../src/detect";

describe("detectPackageManagerFromNames", () => {
  test.each([
    [["bun.lock"], "bun"],
    [["bun.lockb"], "bun"],
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["package-lock.json"], "npm"],
    [[], "bun"],
  ] as const)("detects %p as %s", (names, expected) => {
    expect(detectPackageManagerFromNames(names)).toBe(expected);
  });

  test("uses the design-specified precedence when lock files coexist", () => {
    expect(
      detectPackageManagerFromNames([
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lock",
      ]),
    ).toBe("bun");
    expect(
      detectPackageManagerFromNames([
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
      ]),
    ).toBe("pnpm");
  });
});

describe("selectLifecycleScript", () => {
  test("prefers dev over start", () => {
    expect(
      selectLifecycleScript({
        scripts: { dev: "vite", start: "node server.js" },
      }),
    ).toEqual({ name: "dev", command: "vite" });
  });

  test("falls back to start", () => {
    expect(
      selectLifecycleScript({ scripts: { start: "node server.js" } }),
    ).toEqual({ name: "start", command: "node server.js" });
  });

  test("returns null when neither script exists", () => {
    expect(selectLifecycleScript({ scripts: { test: "bun test" } })).toBeNull();
  });
});

describe("isViteOrAstro", () => {
  test("detects exact devDependency keys", () => {
    expect(isViteOrAstro({ devDependencies: { vite: "latest" } }, "dev")).toBe(
      true,
    );
    expect(
      isViteOrAstro({ devDependencies: { astro: "latest" } }, "dev"),
    ).toBe(true);
  });

  test("detects executable tokens in the selected script", () => {
    expect(isViteOrAstro({}, "vite --host")).toBe(true);
    expect(isViteOrAstro({}, "bunx astro dev")).toBe(true);
    expect(isViteOrAstro({}, "./node_modules/.bin/vite --host")).toBe(true);
  });

  test("does not mistake similarly named tools for vite or astro", () => {
    expect(isViteOrAstro({}, "vitest --run")).toBe(false);
    expect(isViteOrAstro({}, "echo my-vite-wrapper")).toBe(false);
  });
});

describe("buildLifecycleArgv", () => {
  test("uses Bun's direct script argument form", () => {
    expect(buildLifecycleArgv("bun", "dev", 4_321, true)).toEqual([
      "bun",
      "run",
      "dev",
      "--port",
      "4321",
    ]);
  });

  test.each(["npm", "pnpm", "yarn"] as const)(
    "uses the separator required by %s",
    (packageManager) => {
      expect(buildLifecycleArgv(packageManager, "dev", 4_321, true)).toEqual([
        packageManager,
        "run",
        "dev",
        "--",
        "--port",
        "4321",
      ]);
    },
  );

  test("does not add a port argument for another framework", () => {
    expect(buildLifecycleArgv("npm", "start", 4_321, false)).toEqual([
      "npm",
      "run",
      "start",
    ]);
  });
});

describe("resolveLaunchCommand", () => {
  test("leaves an explicit argv byte-for-byte unchanged and skips detection", async () => {
    const explicit = ["node", "-e", "console.log('hello world')"];
    const result = await resolveLaunchCommand(
      "/path/that/does/not/exist",
      explicit,
      4_321,
    );

    expect(result.argv).toEqual(explicit);
    expect(result.argv).not.toBe(explicit);
    expect(result.packageManager).toBeNull();
    expect(result.scriptName).toBeNull();
  });

  test("detects package manager, script, and Astro port arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yado-detect-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          scripts: { dev: "astro dev" },
          devDependencies: { astro: "5.0.0" },
        }),
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "");

      expect(await resolveLaunchCommand(directory, null, 4_321)).toEqual({
        argv: ["pnpm", "run", "dev", "--", "--port", "4321"],
        display: "pnpm run dev -- --port 4321",
        packageManager: "pnpm",
        scriptName: "dev",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reports a package with no runnable script", async () => {
    const directory = await mkdtemp(join(tmpdir(), "yado-detect-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ scripts: { test: "bun test" } }),
      );
      await expect(resolveLaunchCommand(directory, null, 4_321)).rejects.toThrow(
        ProjectDetectionError,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an empty explicit command", async () => {
    await expect(resolveLaunchCommand("/tmp", [], 4_321)).rejects.toThrow(
      ProjectDetectionError,
    );
  });
});
