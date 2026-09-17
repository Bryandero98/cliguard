import { existsSync, readFileSync } from "fs";

import { detectDiffTool, openDiffInEditor, type DiffTool } from "../core/open-diff";
import type { Contract } from "../core/types";

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    contractVersion: 1,
    adapter: "commander",
    capturedAt: "2026-01-01T00:00:00.000Z",
    root: {
      name: "mycli",
      description: "",
      aliases: [],
      options: [],
      arguments: [],
      subcommands: [],
    },
    ...overrides,
  };
}

describe("detectDiffTool", () => {
  it("returns the first tool whose own availability check reports true", () => {
    const tools: DiffTool[] = [
      { command: "nope", buildArgs: () => [] },
      { command: "code", buildArgs: (a, b) => ["--diff", a, b] },
    ];
    const isAvailable = (command: string) => command === "code";

    const found = detectDiffTool(tools, isAvailable);

    expect(found?.command).toBe("code");
  });

  it("returns undefined when no tool is available", () => {
    const tools: DiffTool[] = [{ command: "nope", buildArgs: () => [] }];
    expect(detectDiffTool(tools, () => false)).toBeUndefined();
  });
});

describe("openDiffInEditor", () => {
  it("always writes both contracts to disk as pretty-printed JSON, even with no tool available", () => {
    const oldContract = makeContract();
    const newContract = makeContract({
      root: { ...oldContract.root, description: "changed" },
    });

    const result = openDiffInEditor(oldContract, newContract, undefined);
    if (!result)
      throw new Error("expected openDiffInEditor to succeed - temp dir should be writable in CI");

    expect(result.openedWith).toBeUndefined();
    expect(existsSync(result.oldPath)).toBe(true);
    expect(existsSync(result.newPath)).toBe(true);
    expect(JSON.parse(readFileSync(result.oldPath, "utf8"))).toEqual(oldContract);
    expect(JSON.parse(readFileSync(result.newPath, "utf8"))).toEqual(newContract);
  });

  it("reports which tool it opened when one is given/available", () => {
    const oldContract = makeContract();
    const newContract = makeContract({
      root: { ...oldContract.root, description: "changed" },
    });
    // A real, always-present, side-effect-free command stands in for a
    // real diff tool here - proves the "found a tool -> launch it, report
    // its name" path without depending on VS Code (or any other real
    // editor) being installed on whatever machine runs this test.
    const fakeTool: DiffTool = {
      command: process.platform === "win32" ? "cmd" : "true",
      buildArgs: () => (process.platform === "win32" ? ["/c", "exit", "0"] : []),
    };

    const result = openDiffInEditor(oldContract, newContract, fakeTool);
    if (!result)
      throw new Error("expected openDiffInEditor to succeed - temp dir should be writable in CI");

    expect(result.openedWith).toBe(fakeTool.command);
    expect(existsSync(result.oldPath)).toBe(true);
  });

  it("writes to a fresh temp directory on every call, never colliding with a previous one", () => {
    const contract = makeContract();
    const first = openDiffInEditor(contract, contract, undefined);
    const second = openDiffInEditor(contract, contract, undefined);
    if (!first || !second)
      throw new Error("expected openDiffInEditor to succeed - temp dir should be writable in CI");

    expect(first.oldPath).not.toBe(second.oldPath);
  });
});
