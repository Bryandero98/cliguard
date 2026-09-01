import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";

import type { AcceptedBreak, Contract } from "./types";

const CONTRACT_PATH = join(process.cwd(), ".cliguard", "contract.json");
const ACCEPTED_BREAKS_PATH = join(process.cwd(), ".cliguard", "accepted-breaks.json");
const CI_WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "cliguard.yml");

/** Contract path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getContractDisplayPath(): string {
  return relative(process.cwd(), CONTRACT_PATH).split("\\").join("/");
}

/** Accepted-breaks path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getAcceptedBreaksDisplayPath(): string {
  return relative(process.cwd(), ACCEPTED_BREAKS_PATH).split("\\").join("/");
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

/**
 * Reads a Contract from an arbitrary path, not the committed
 * `.cliguard/contract.json` - for `cliguard diff <a> <b>`, comparing two
 * contract files directly (e.g. two tags' committed contracts pulled via
 * `git show`) without running any real CLI. `displayPath` is what error
 * messages name; defaults to `path` itself since a caller-supplied path is
 * already about as displayable as it gets.
 */
export function readContractFile(path: string, displayPath: string = path): Contract {
  if (!existsSync(path)) {
    throw new Error(`cliguard: no such file: "${displayPath}".`);
  }
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as Contract;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cliguard: "${displayPath}" is not valid JSON (${reason}).`);
  }
}

/**
 * Reads the committed contract as it existed at a git ref (a branch, tag,
 * or commit sha) instead of the working tree - `cliguard check <entry>
 * --against origin/main` needs no local `.cliguard/contract.json` at all,
 * closing the CI-friction gap `readContractFile`'s own doc comment above
 * already names as the manual workaround (`git show <ref>:... > old.json`
 * piped into `cliguard diff`).
 */
export function readContractAtRef(ref: string): Contract {
  const contractGitPath = getContractDisplayPath();
  let raw: string;
  try {
    raw = execFileSync("git", ["show", `${ref}:${contractGitPath}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : undefined;
    throw new Error(
      `cliguard: couldn't read "${contractGitPath}" at ref "${ref}"` +
        (stderr ? ` (${stderr})` : ".") +
        ` Make sure "${ref}" exists and has a contract committed at that path - ` +
        `a shallow clone may need \`git fetch --deepen\` or \`git fetch origin ${ref}\` first.`,
    );
  }

  try {
    return JSON.parse(raw) as Contract;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cliguard: "${contractGitPath}" at ref "${ref}" is not valid JSON (${reason}).`,
    );
  }
}

/** Unlike readContract, a missing file is normal (most projects never accept a break) - returns [] rather than throwing. */
export function readAcceptedBreaks(): AcceptedBreak[] {
  if (!existsSync(ACCEPTED_BREAKS_PATH)) return [];
  const raw = readFileSync(ACCEPTED_BREAKS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as AcceptedBreak[];
  } catch (error) {
    // See readContract's identical-purpose catch for why naming the file
    // and the fix matters here too.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cliguard: "${getAcceptedBreaksDisplayPath()}" is not valid JSON (${reason}). ` +
        "If this file was hand-edited or came out of a bad merge, fix it or delete it " +
        "and re-run `cliguard accept` for whatever was in it.",
    );
  }
}

export function writeAcceptedBreaks(breaks: readonly AcceptedBreak[]): void {
  mkdirSync(dirname(ACCEPTED_BREAKS_PATH), { recursive: true });
  writeFileSync(ACCEPTED_BREAKS_PATH, JSON.stringify(breaks, null, 2) + "\n", "utf-8");
}

/** CI workflow path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getCiWorkflowDisplayPath(): string {
  return relative(process.cwd(), CI_WORKFLOW_PATH).split("\\").join("/");
}

export function ciWorkflowExists(): boolean {
  return existsSync(CI_WORKFLOW_PATH);
}

/** Never called when ciWorkflowExists() is true - `init --with-ci` checks first so a hand-edited workflow is never clobbered. */
export function writeCiWorkflow(content: string): void {
  mkdirSync(dirname(CI_WORKFLOW_PATH), { recursive: true });
  writeFileSync(CI_WORKFLOW_PATH, content, "utf-8");
}
