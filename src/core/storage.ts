import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve as resolvePath } from "path";

import type { AcceptedBreak, Contract, Deprecation } from "./types";

const CLIGUARD_DIR = join(process.cwd(), ".cliguard");
const CI_WORKFLOW_PATH = join(process.cwd(), ".github", "workflows", "cliguard.yml");

/**
 * `namespace` is a config-resolved target's own `name` (see
 * core/config.ts's `resolveTargets`) - `null` for the classic single-CLI
 * flow, which keeps every path exactly what it always was
 * (`.cliguard/contract.json`, not `.cliguard/null/contract.json`;
 * `path.join` drops an empty segment the same way). A named target gets
 * its own `.cliguard/<name>/` directory so two targets' contracts,
 * accepted breaks, and deprecations never collide on disk.
 */
function targetPath(namespace: string | null, fileName: string): string {
  return join(CLIGUARD_DIR, namespace ?? "", fileName);
}

/** Contract path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getContractDisplayPath(namespace: string | null = null): string {
  return relative(process.cwd(), targetPath(namespace, "contract.json")).split("\\").join("/");
}

/** Accepted-breaks path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getAcceptedBreaksDisplayPath(namespace: string | null = null): string {
  return relative(process.cwd(), targetPath(namespace, "accepted-breaks.json"))
    .split("\\")
    .join("/");
}

export function contractExists(namespace: string | null = null): boolean {
  return existsSync(targetPath(namespace, "contract.json"));
}

export function readContract(namespace: string | null = null): Contract {
  const contractPath = targetPath(namespace, "contract.json");
  if (!existsSync(contractPath)) {
    throw new Error(
      `cliguard: no contract found at "${getContractDisplayPath(namespace)}". Run \`cliguard init <entry.js>\` first.`,
    );
  }
  const raw = readFileSync(contractPath, "utf-8");
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
      `cliguard: "${getContractDisplayPath(namespace)}" is not valid JSON (${reason}). ` +
        "If this file was hand-edited or came out of a bad merge, re-run " +
        "`cliguard update <entry.js>` to regenerate it.",
    );
  }
}

export function writeContract(contract: Contract, namespace: string | null = null): void {
  const contractPath = targetPath(namespace, "contract.json");
  mkdirSync(dirname(contractPath), { recursive: true });
  writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n", "utf-8");
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
export function readContractAtRef(ref: string, namespace: string | null = null): Contract {
  const contractGitPath = getContractDisplayPath(namespace);
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
export function readAcceptedBreaks(namespace: string | null = null): AcceptedBreak[] {
  const acceptedBreaksPath = targetPath(namespace, "accepted-breaks.json");
  if (!existsSync(acceptedBreaksPath)) return [];
  const raw = readFileSync(acceptedBreaksPath, "utf-8");
  try {
    return JSON.parse(raw) as AcceptedBreak[];
  } catch (error) {
    // See readContract's identical-purpose catch for why naming the file
    // and the fix matters here too.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cliguard: "${getAcceptedBreaksDisplayPath(namespace)}" is not valid JSON (${reason}). ` +
        "If this file was hand-edited or came out of a bad merge, fix it or delete it " +
        "and re-run `cliguard accept` for whatever was in it.",
    );
  }
}

export function writeAcceptedBreaks(
  breaks: readonly AcceptedBreak[],
  namespace: string | null = null,
): void {
  const acceptedBreaksPath = targetPath(namespace, "accepted-breaks.json");
  mkdirSync(dirname(acceptedBreaksPath), { recursive: true });
  writeFileSync(acceptedBreaksPath, JSON.stringify(breaks, null, 2) + "\n", "utf-8");
}

/** Deprecations path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getDeprecationsDisplayPath(namespace: string | null = null): string {
  return relative(process.cwd(), targetPath(namespace, "deprecations.json")).split("\\").join("/");
}

/** Unlike readContract, a missing file is normal (most projects never deprecate anything) - returns [] rather than throwing. */
export function readDeprecations(namespace: string | null = null): Deprecation[] {
  const deprecationsPath = targetPath(namespace, "deprecations.json");
  if (!existsSync(deprecationsPath)) return [];
  const raw = readFileSync(deprecationsPath, "utf-8");
  try {
    return JSON.parse(raw) as Deprecation[];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `cliguard: "${getDeprecationsDisplayPath(namespace)}" is not valid JSON (${reason}). ` +
        "If this file was hand-edited or came out of a bad merge, fix it or delete it " +
        "and re-run `cliguard deprecate` for whatever was in it.",
    );
  }
}

export function writeDeprecations(
  deprecations: readonly Deprecation[],
  namespace: string | null = null,
): void {
  const deprecationsPath = targetPath(namespace, "deprecations.json");
  mkdirSync(dirname(deprecationsPath), { recursive: true });
  writeFileSync(deprecationsPath, JSON.stringify(deprecations, null, 2) + "\n", "utf-8");
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

/**
 * `git rev-parse --git-path hooks` rather than a hardcoded `.git/hooks` -
 * correct even when a repo sets `core.hooksPath`, is a worktree (`.git` is
 * a file, not a directory, pointing elsewhere), or is a submodule.
 */
function resolveHooksDir(): string {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "cliguard: not a git repository (or git isn't installed) - install-hook needs one.",
    );
  }
  return resolvePath(process.cwd(), out);
}

/** Hook path relative to cwd, normalized to forward slashes - display only, never used for I/O. */
export function getHookDisplayPath(hookName: string): string {
  return relative(process.cwd(), join(resolveHooksDir(), hookName)).split("\\").join("/");
}

export function hookExists(hookName: string): boolean {
  return existsSync(join(resolveHooksDir(), hookName));
}

/** Reads an arbitrary user-supplied text file (not one of cliguard's own fixed `.cliguard/*` paths) - `null` when it doesn't exist, since "no committed docs yet" is a normal, expected state for `cliguard docs --check`, not an error. */
export function readTextFileIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

/** Never called when hookExists() is true - install-hook checks first so a hand-edited hook is never clobbered. */
export function writeHook(hookName: string, content: string): void {
  const hookPath = join(resolveHooksDir(), hookName);
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, content, "utf-8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // Best-effort: Windows filesystems mostly ignore the Unix exec bit
    // anyway, and Git for Windows runs hooks via its own shebang handling
    // regardless - a failed chmod here shouldn't fail the whole command.
  }
}
