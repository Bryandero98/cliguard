import { spawn, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { Contract } from "./types";

/**
 * `cliguard check --open-diff`'s local equivalent of ApprovalTests'
 * reporters, which open an external diff tool the moment a test fails -
 * here, the moment a real contract difference is found. Deliberately
 * simple: one known editor (VS Code's own `code` CLI, which ships a
 * built-in two-pane `--diff` view) probed for on PATH, with a plain
 * "here are the file paths" fallback when it isn't there - never a hard
 * failure, and never anything that changes `check`'s own exit code.
 */
export interface DiffTool {
  readonly command: string;
  readonly buildArgs: (oldPath: string, newPath: string) => string[];
}

const DIFF_TOOLS: readonly DiffTool[] = [
  { command: "code", buildArgs: (a, b) => ["--diff", a, b] },
];

/**
 * True if `command --version` runs successfully - the simplest portable
 * "is this on PATH" probe, without depending on `which`/`where` (neither
 * of which exists on every platform cliguard runs on).
 */
export function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return !result.error && result.status === 0;
}

/** `isAvailable` is injectable purely so tests can exercise both branches without depending on whether a real editor happens to be on the test runner's own PATH. */
export function detectDiffTool(
  tools: readonly DiffTool[] = DIFF_TOOLS,
  isAvailable: (command: string) => boolean = isCommandAvailable,
): DiffTool | undefined {
  return tools.find((tool) => isAvailable(tool.command));
}

export interface OpenDiffResult {
  readonly oldPath: string;
  readonly newPath: string;
  /** The diff tool's own command name, present only if one was actually found and launched. */
  readonly openedWith?: string;
}

/**
 * Writes both contracts to a fresh temp directory as pretty-printed JSON,
 * then - if `tool` is given (the caller's own `detectDiffTool()` result,
 * not defaulted here so a test can pass `undefined` and mean it) - opens
 * them there, detached from cliguard's own process so `check` still exits
 * immediately with its normal code instead of waiting on the editor
 * window to close. Never throws: a tool that fails to actually launch
 * still leaves both files on disk, which is all the caller falls back to
 * printing anyway.
 */
export function openDiffInEditor(
  oldContract: Contract,
  newContract: Contract,
  tool: DiffTool | undefined,
): OpenDiffResult {
  const dir = mkdtempSync(join(tmpdir(), "cliguard-diff-"));
  const oldPath = join(dir, "expected.contract.json");
  const newPath = join(dir, "actual.contract.json");
  writeFileSync(oldPath, JSON.stringify(oldContract, null, 2) + "\n");
  writeFileSync(newPath, JSON.stringify(newContract, null, 2) + "\n");

  if (!tool) return { oldPath, newPath };

  try {
    const child = spawn(tool.command, tool.buildArgs(oldPath, newPath), {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    // A launch failure surfacing asynchronously (after this function has
    // already returned "openedWith") is still not fatal - both files are
    // already safely on disk regardless - so this only exists to stop
    // Node from ever treating an unhandled 'error' event as a crash.
    child.on("error", () => undefined);
    child.unref();
    return { oldPath, newPath, openedWith: tool.command };
  } catch {
    return { oldPath, newPath };
  }
}
