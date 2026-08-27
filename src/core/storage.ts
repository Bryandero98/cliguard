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
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as Contract;
}

export function writeContract(contract: Contract): void {
  mkdirSync(dirname(CONTRACT_PATH), { recursive: true });
  writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + "\n", "utf-8");
}
