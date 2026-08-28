import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

import type { Contract } from "./types";

const CONTRACT_PATH = join(process.cwd(), ".cliguard", "contract.json");

/** Contract path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getContractDisplayPath(): string {
  return relative(process.cwd(), CONTRACT_PATH).split("\\").join("/");
}

export function contractExists(): boolean {
  return existsSync(CONTRACT_PATH);
}

export function readContract(): Contract {
  if (!existsSync(CONTRACT_PATH)) {
    throw new Error(
      `cliguard: no contract found at "${getContractDisplayPath()}". Run \`cliguard init <entry.js>\` first.`,
    );
  }
  const raw = readFileSync(CONTRACT_PATH, "utf-8");
  try {
    return JSON.parse(raw) as Contract;
  } catch (error) {
    // A bare JSON.parse error ("Unexpected token..." with no file
    // context) reads as an internal cliguard bug, not "your committed
    // contract file is corrupted" - which is the actual, fixable cause
    // (a bad manual edit, a botched merge). Naming the file and the
    // fix (re-run init/update) turns a confusing crash into an
    // actionable message.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cliguard: "${getContractDisplayPath()}" is not valid JSON (${reason}). ` +
        "If this file was hand-edited or came out of a bad merge, re-run " +
        "`cliguard update <entry.js>` to regenerate it.",
    );
  }
}

export function writeContract(contract: Contract): void {
  mkdirSync(dirname(CONTRACT_PATH), { recursive: true });
  writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + "\n", "utf-8");
}
