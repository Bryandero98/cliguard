import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Every E2E test spawns the built CLI as a real subprocess, in a
// throwaway directory - the closest thing to how cliguard is actually
// invoked, and the only way to exercise a real dynamic import() (Jest's
// own VM sandbox intercepts one called in-process; see
// commander-adapter.test.ts's comment on the same topic).
const BIN = path.join(__dirname, "..", "..", "dist", "bin.js");

export interface CliResult {
  readonly status: number;
  readonly output: string;
}

export function runCli(cwd: string, args: string[]): CliResult {
  try {
    const output = execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8" });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

/** A fresh throwaway directory, cleaned up by the returned function - call it in a `finally`. */
export function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cliguard-e2e-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}
