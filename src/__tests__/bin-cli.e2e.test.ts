import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";

import { ensureDir, makeTempDir, runCli } from "../test-helpers/run-cli";

// A throwaway git identity, scoped to a single command via -c flags rather
// than relying on (or polluting) any real global/user git config - keeps
// these tests self-contained on a machine that's never run `git config
// user.email` at all, CI included.
const GIT_IDENTITY = [
  "-c",
  "user.email=cliguard-test@example.com",
  "-c",
  "user.name=cliguard-test",
];

function git(dir: string, args: string[]): void {
  execFileSync("git", [...GIT_IDENTITY, ...args], { cwd: dir, stdio: "pipe" });
}

/** Commits the current contents of `dir` (expected: a fresh contract.json from `init`) as the repo's first commit. */
function commitContract(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "cliguard baseline"]);
}

// Exercises the full init/check/update flow through the real built CLI
// (a subprocess, not an in-process call) - what a user actually runs.
// The adapter-level tests already cover extraction in detail; this file
// covers bin.ts's own behavior: exit codes, messages, and the diff
// engine wired end to end against a real contract on disk.
const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-cli.js");

// A modified copy of basic-cli.js has to live inside this project's own
// tree (not an arbitrary temp dir) so its own `require("commander")`
// resolves normally via node_modules - a temp dir outside the project
// has none. The contract itself (.cliguard/) still lives in a separate
// temp dir per test (via makeTempDir), passed as the CLI's cwd, so tests
// stay isolated from each other; only the target fixture file needs to
// be inside the tree.
const SCRATCH_ROOT = path.join(__dirname, "..", "..", ".e2e-scratch");

function writeModifiedFixture(transform: (source: string) => string): {
  path: string;
  cleanup: () => void;
} {
  ensureDir(SCRATCH_ROOT);
  const dir = mkdtempSync(path.join(SCRATCH_ROOT, "fixture-"));
  const filePath = path.join(dir, "modified-cli.js");
  writeFileSync(filePath, transform(readFileSync(FIXTURE, "utf8")));
  return { path: filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("cliguard CLI (subprocess)", () => {
  it("check exits 0 and reports intact when nothing changed since init", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      expect(runCli(dir, ["init", FIXTURE]).status).toBe(0);
      const { status, output } = runCli(dir, ["check", FIXTURE]);
      expect(status).toBe(0);
      expect(output).toContain("CLI contract is intact.");
    } finally {
      cleanup();
    }
  });

  it("check exits 1 and prints a 🔴 line when a required option was removed (BREAKING)", () => {
    const { dir, cleanup } = makeTempDir();
    // A modified copy of the fixture with the entire --target option
    // deleted - a real BREAKING change, not a fabricated Contract
    // object, so this also proves the adapter and diff engine agree
    // with each other end to end. (Changing requiredOption(...) to
    // option(...) instead of deleting the line would be a *different*,
    // non-BREAKING scenario - required flipping to optional is PATCH,
    // already covered in diff-engine.test.ts - caught by this test
    // failing unexpectedly on first write, not anticipated in advance.)
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(1);
      expect(output).toContain("🔴");
      expect(output).toContain('Option "--target" was removed');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check exits 0 and prints a 🟢 line for an ADDITIVE-only change (new optional option)", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source.replace(
        '.option("--verbose", "verbose logging")',
        '.option("--verbose", "verbose logging")\n    .option("--dry-run", "dry run mode")',
      ),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("🟢");
      expect(output).toContain('New optional option "--dry-run" was added');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --json reports ok:true and no changes when nothing changed", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", FIXTURE, "--json"]);
      expect(status).toBe(0);
      expect(JSON.parse(output)).toEqual({
        ok: true,
        changes: [],
        summary: { breaking: 0, acknowledgedBreaking: 0, additive: 0, patch: 0 },
        suggestedBump: null,
      });
    } finally {
      cleanup();
    }
  });

  it("check --json reports a BREAKING change with suggestedBump major, exit 1", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--json"]);
      expect(status).toBe(1);
      const result = JSON.parse(output) as { ok: boolean; suggestedBump: string; summary: object };
      expect(result.ok).toBe(false);
      expect(result.suggestedBump).toBe("major");
      expect(result.summary).toEqual({
        breaking: 1,
        acknowledgedBreaking: 0,
        additive: 0,
        patch: 0,
      });
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("accept records a real BREAKING change, and check then exits 0 and prints a 🟣 acknowledged line instead of 🔴", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    const changePath = "root -> build -> option[--target]";
    try {
      runCli(dir, ["init", FIXTURE]);

      const acceptResult = runCli(dir, [
        "accept",
        fixture.path,
        changePath,
        "--reason",
        "removed in v2, replaced by --targets",
      ]);
      expect(acceptResult.status).toBe(0);
      expect(acceptResult.output).toContain("✅ Accepted");
      expect(acceptResult.output).toContain(changePath);

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("🟣");
      expect(output).not.toContain("🔴");
      expect(output).toContain("removed in v2, replaced by --targets");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --json marks an accepted BREAKING change as acknowledged and excludes it from the failing count", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    const changePath = "root -> build -> option[--target]";
    try {
      runCli(dir, ["init", FIXTURE]);
      runCli(dir, ["accept", fixture.path, changePath, "--reason", "intentional"]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--json"]);
      expect(status).toBe(0);
      const result = JSON.parse(output) as {
        ok: boolean;
        summary: object;
        changes: { path: string; acknowledged?: boolean; reason?: string }[];
      };
      expect(result.ok).toBe(true);
      expect(result.summary).toEqual({
        breaking: 0,
        acknowledgedBreaking: 1,
        additive: 0,
        patch: 0,
      });
      const change = result.changes.find((c) => c.path === changePath);
      expect(change).toMatchObject({ acknowledged: true, reason: "intentional" });
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("accept refuses a path with no current BREAKING change, listing what actually is breaking", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, [
        "accept",
        fixture.path,
        "root -> nonexistent -> option[--nope]",
        "--reason",
        "doesn't matter",
      ]);
      expect(status).toBe(1);
      expect(output).toContain("no current BREAKING change");
      expect(output).toContain("root -> build -> option[--target]");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("accept requires --reason", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      const { status, output } = runCli(dir, [
        "accept",
        FIXTURE,
        "root -> build -> option[--target]",
      ]);
      expect(status).not.toBe(0);
      expect(output).toContain("--reason");
    } finally {
      cleanup();
    }
  });

  it("deprecate records a currently-existing path, and its later removal counts as PATCH instead of BREAKING", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    const changePath = "root -> build -> option[--target]";
    try {
      runCli(dir, ["init", FIXTURE]);

      const deprecateResult = runCli(dir, [
        "deprecate",
        FIXTURE,
        changePath,
        "--remove-by",
        "2.0.0",
        "--reason",
        "replaced by --targets",
      ]);
      expect(deprecateResult.status).toBe(0);
      expect(deprecateResult.output).toContain("✅ Deprecated");
      expect(deprecateResult.output).toContain(changePath);

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("🟡");
      expect(output).not.toContain("🔴");
      expect(output).toContain("scheduled removal by 2.0.0");
      expect(output).toContain("replaced by --targets");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("removing an option with no prior deprecate still fails as BREAKING", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);
      // No deprecate call here - this is the control case proving
      // deprecation, not mere removal, is what flips the severity.

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(1);
      expect(output).toContain("🔴");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("deprecate refuses a path that doesn't currently exist", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, [
        "deprecate",
        FIXTURE,
        "root -> nonexistent -> option[--nope]",
        "--remove-by",
        "2.0.0",
      ]);
      expect(status).toBe(1);
      expect(output).toContain("no such path");
    } finally {
      cleanup();
    }
  });

  it("deprecate requires --remove-by", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      const { status, output } = runCli(dir, [
        "deprecate",
        FIXTURE,
        "root -> build -> option[--target]",
      ]);
      expect(status).not.toBe(0);
      expect(output).toContain("--remove-by");
    } finally {
      cleanup();
    }
  });

  it("check --json reflects a deprecated-then-removed option as a PATCH change, not BREAKING", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    const changePath = "root -> build -> option[--target]";
    try {
      runCli(dir, ["init", FIXTURE]);
      runCli(dir, ["deprecate", FIXTURE, changePath, "--remove-by", "2026-12-01"]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--json"]);
      expect(status).toBe(0);
      const result = JSON.parse(output) as {
        ok: boolean;
        summary: { breaking: number; patch: number };
        changes: { path: string; type: string; message: string }[];
      };
      expect(result.ok).toBe(true);
      expect(result.summary.breaking).toBe(0);
      expect(result.summary.patch).toBe(1);
      const change = result.changes.find((c) => c.path === changePath);
      expect(change?.type).toBe("PATCH");
      expect(change?.message).toContain("scheduled removal by 2026-12-01");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --json reports an ADDITIVE-only change with suggestedBump minor, exit 0", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source.replace(
        '.option("--verbose", "verbose logging")',
        '.option("--verbose", "verbose logging")\n    .option("--dry-run", "dry run mode")',
      ),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--json"]);
      expect(status).toBe(0);
      const result = JSON.parse(output) as { ok: boolean; suggestedBump: string; summary: object };
      expect(result.ok).toBe(true);
      expect(result.suggestedBump).toBe("minor");
      expect(result.summary).toEqual({
        breaking: 0,
        acknowledgedBreaking: 0,
        additive: 1,
        patch: 0,
      });
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("update overwrites the committed contract so a later check against the same file is clean", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source.replace(".requiredOption(", ".option("),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const updateResult = runCli(dir, ["update", fixture.path]);
      expect(updateResult.status).toBe(0);
      expect(updateResult.output).toContain("CLI contract updated successfully");

      // Now that the committed contract matches the modified fixture,
      // checking against it again must be clean - proves update
      // actually wrote what check reads, not just that it printed
      // success.
      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("CLI contract is intact.");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("init refuses to overwrite an existing contract", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      const { status, output } = runCli(dir, ["init", FIXTURE]);
      expect(status).toBe(1);
      expect(output).toContain("cliguard update");
    } finally {
      cleanup();
    }
  });

  it("check fails with a clear message when no contract exists yet", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["check", FIXTURE]);
      expect(status).toBe(1);
      expect(output).toContain("cliguard init");
    } finally {
      cleanup();
    }
  });

  it("diff compares two contract files directly, no adapter or target CLI involved", () => {
    // Two separate temp dirs each get their own real, independently
    // captured contract - `diff` then reads both off disk by path, the
    // same shape as comparing two tags' committed contracts in a repo.
    const oldDir = makeTempDir();
    const newDir = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(oldDir.dir, ["init", FIXTURE]);
      runCli(newDir.dir, ["init", fixture.path]);

      const oldContractPath = path.join(oldDir.dir, ".cliguard", "contract.json");
      const newContractPath = path.join(newDir.dir, ".cliguard", "contract.json");

      const { status, output } = runCli(oldDir.dir, ["diff", oldContractPath, newContractPath]);
      expect(status).toBe(1);
      expect(output).toContain("🔴");
      expect(output).toContain('Option "--target" was removed');
    } finally {
      oldDir.cleanup();
      newDir.cleanup();
      fixture.cleanup();
    }
  });

  it("diff reports identical contracts as a match, exit 0", () => {
    const oldDir = makeTempDir();
    const newDir = makeTempDir();
    try {
      runCli(oldDir.dir, ["init", FIXTURE]);
      runCli(newDir.dir, ["init", FIXTURE]);

      const oldContractPath = path.join(oldDir.dir, ".cliguard", "contract.json");
      const newContractPath = path.join(newDir.dir, ".cliguard", "contract.json");

      const { status, output } = runCli(oldDir.dir, ["diff", oldContractPath, newContractPath]);
      expect(status).toBe(0);
      expect(output).toContain("Contracts are identical");
    } finally {
      oldDir.cleanup();
      newDir.cleanup();
    }
  });

  it("diff --json respects an accepted break the same way check does", () => {
    const oldDir = makeTempDir();
    const newDir = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    const changePath = "root -> build -> option[--target]";
    try {
      runCli(oldDir.dir, ["init", FIXTURE]);
      runCli(newDir.dir, ["init", fixture.path]);
      // accept records into oldDir's own .cliguard/accepted-breaks.json -
      // diff below runs with oldDir as cwd, so it picks that file up.
      // Entry is the *modified* fixture: accept diffs oldDir's committed
      // contract against a fresh extraction, same as check would.
      runCli(oldDir.dir, ["accept", fixture.path, changePath, "--reason", "intentional"]);

      const oldContractPath = path.join(oldDir.dir, ".cliguard", "contract.json");
      const newContractPath = path.join(newDir.dir, ".cliguard", "contract.json");

      const { status, output } = runCli(oldDir.dir, [
        "diff",
        oldContractPath,
        newContractPath,
        "--json",
      ]);
      expect(status).toBe(0);
      const result = JSON.parse(output) as { ok: boolean; summary: object };
      expect(result.ok).toBe(true);
      expect(result.summary).toEqual({
        breaking: 0,
        acknowledgedBreaking: 1,
        additive: 0,
        patch: 0,
      });
    } finally {
      oldDir.cleanup();
      newDir.cleanup();
      fixture.cleanup();
    }
  });

  it("diff fails with a clear error when a file doesn't exist", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["diff", "nope-a.json", "nope-b.json"]);
      expect(status).toBe(1);
      expect(output).toContain("no such file");
    } finally {
      cleanup();
    }
  });

  it("preview prints the extracted contract without writing .cliguard/contract.json", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["preview", FIXTURE]);
      expect(status).toBe(0);
      const contract = JSON.parse(output);
      expect(contract.contractVersion).toBe(1);
      expect(contract.root).toBeDefined();
      expect(existsSync(path.join(dir, ".cliguard", "contract.json"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("preview's own output is a valid contract - init on top of it and check reports intact", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const preview = runCli(dir, ["preview", FIXTURE]);
      writeFileSync(path.join(dir, "previewed-contract.json"), preview.output);

      runCli(dir, ["init", FIXTURE]);
      const { status, output } = runCli(dir, [
        "diff",
        path.join(dir, "previewed-contract.json"),
        path.join(dir, ".cliguard", "contract.json"),
      ]);
      expect(status).toBe(0);
      expect(output).toContain("Contracts are identical.");
    } finally {
      cleanup();
    }
  });

  it("init --with-ci scaffolds a GitHub Actions workflow alongside the contract", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status } = runCli(dir, ["init", FIXTURE, "--with-ci"]);
      expect(status).toBe(0);

      const workflowPath = path.join(dir, ".github", "workflows", "cliguard.yml");
      expect(existsSync(workflowPath)).toBe(true);
      const workflow = readFileSync(workflowPath, "utf8");
      expect(workflow).toContain("uses: Bryandero98/cliguard@v1");
      expect(workflow).toContain("entry:");
      // Default adapter ("commander") is never spelled out - matches the
      // Action's own input default, same as the README's example.
      expect(workflow).not.toContain("adapter:");
    } finally {
      cleanup();
    }
  });

  it("init --with-ci includes an explicit adapter line for a non-default adapter", () => {
    const { dir, cleanup } = makeTempDir();
    const yargsFixture = path.join(__dirname, "..", "__fixtures__", "basic-yargs-cli.js");
    try {
      runCli(dir, ["init", yargsFixture, "--with-ci", "--adapter", "yargs"]);

      const workflow = readFileSync(path.join(dir, ".github", "workflows", "cliguard.yml"), "utf8");
      expect(workflow).toContain("adapter: yargs");
    } finally {
      cleanup();
    }
  });

  it("init --with-ci never overwrites an existing workflow file", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE, "--with-ci"]);
      const workflowPath = path.join(dir, ".github", "workflows", "cliguard.yml");
      writeFileSync(workflowPath, "# hand-customized, do not touch\n");

      // A fresh contract is required for a second init to even run - delete
      // it first so this test isolates "does --with-ci ever overwrite the
      // workflow", not "init refuses to run twice".
      rmSync(path.join(dir, ".cliguard", "contract.json"));
      const { status, output } = runCli(dir, ["init", FIXTURE, "--with-ci"]);

      expect(status).toBe(0);
      expect(output).toContain("already exists");
      expect(readFileSync(workflowPath, "utf8")).toBe("# hand-customized, do not touch\n");
    } finally {
      cleanup();
    }
  });

  it("check --against <ref> compares against a git ref's committed contract instead of the file on disk", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);
      commitContract(dir);

      // No local edits to contract.json at all - what a PR branch actually
      // looks like: the same baseline HEAD has, diffed against a target
      // CLI that now has a real BREAKING change.
      const { status, output } = runCli(dir, ["check", fixture.path, "--against", "HEAD"]);
      expect(status).toBe(1);
      expect(output).toContain("🔴");
      expect(output).toContain('Option "--target" was removed');
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --against <ref> --json works the same way as the file-based path", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      commitContract(dir);

      const { status, output } = runCli(dir, ["check", FIXTURE, "--against", "HEAD", "--json"]);
      expect(status).toBe(0);
      expect(JSON.parse(output)).toEqual({
        ok: true,
        changes: [],
        summary: { breaking: 0, acknowledgedBreaking: 0, additive: 0, patch: 0 },
        suggestedBump: null,
      });
    } finally {
      cleanup();
    }
  });

  it("check --against <ref> fails with a clear error for a ref that doesn't exist", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      commitContract(dir);

      const { status, output } = runCli(dir, ["check", FIXTURE, "--against", "no-such-ref"]);
      expect(status).toBe(1);
      expect(output).toContain("no-such-ref");
    } finally {
      cleanup();
    }
  });

  it("check --against <ref> fails with a clear error outside a git repository", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      // Deliberately no commitContract(dir) here - dir is a plain temp
      // directory, never a git repo.

      const { status, output } = runCli(dir, ["check", FIXTURE, "--against", "HEAD"]);
      expect(status).toBe(1);
      expect(output).toContain("couldn't read");
    } finally {
      cleanup();
    }
  });

  it("install-hook writes an executable pre-push hook that runs check on the entry", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      git(dir, ["init", "-q"]);
      const { status, output } = runCli(dir, ["install-hook", FIXTURE]);
      expect(status).toBe(0);
      expect(output).toContain("✅");

      const hookPath = path.join(dir, ".git", "hooks", "pre-push");
      expect(existsSync(hookPath)).toBe(true);
      const hook = readFileSync(hookPath, "utf8");
      expect(hook).toContain("#!/bin/sh");
      expect(hook).toContain("npx cliguard check");
      expect(hook).not.toContain("--adapter");
    } finally {
      cleanup();
    }
  });

  it("install-hook --hook pre-commit installs the other hook and includes a non-default adapter flag", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      git(dir, ["init", "-q"]);
      const { status } = runCli(dir, [
        "install-hook",
        FIXTURE,
        "--hook",
        "pre-commit",
        "--adapter",
        "yargs",
      ]);
      expect(status).toBe(0);

      const hook = readFileSync(path.join(dir, ".git", "hooks", "pre-commit"), "utf8");
      expect(hook).toContain("--adapter yargs");
      expect(existsSync(path.join(dir, ".git", "hooks", "pre-push"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("install-hook never overwrites an existing hook", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      git(dir, ["init", "-q"]);
      runCli(dir, ["install-hook", FIXTURE]);
      const hookPath = path.join(dir, ".git", "hooks", "pre-push");
      writeFileSync(hookPath, "#!/bin/sh\necho hand-customized\n");

      const { status, output } = runCli(dir, ["install-hook", FIXTURE]);
      expect(status).toBe(0);
      expect(output).toContain("already exists");
      expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\necho hand-customized\n");
    } finally {
      cleanup();
    }
  });

  it("install-hook rejects an unknown --hook name", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      git(dir, ["init", "-q"]);
      const { status, output } = runCli(dir, ["install-hook", FIXTURE, "--hook", "pre-merge"]);
      expect(status).toBe(1);
      expect(output).toContain("pre-commit");
      expect(output).toContain("pre-push");
    } finally {
      cleanup();
    }
  });

  it("install-hook fails with a clear error outside a git repository", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      // Deliberately no git init - dir is a plain temp directory.
      const { status, output } = runCli(dir, ["install-hook", FIXTURE]);
      expect(status).not.toBe(0);
      expect(output).toContain("not a git repository");
    } finally {
      cleanup();
    }
  });

  it("check --strict flags a positional argument reorder as BREAKING; without --strict it's silent", () => {
    const { dir, cleanup } = makeTempDir();
    const withCopyCommand = (source: string) =>
      source.replace(
        "module.exports = { program };",
        [
          'program.command("copy").argument("<src>", "source").argument("<dest>", "destination").action(() => {});',
          "",
          "module.exports = { program };",
        ].join("\n"),
      );
    const original = writeModifiedFixture(withCopyCommand);
    const reordered = writeModifiedFixture((source) =>
      withCopyCommand(source).replace(
        '.argument("<src>", "source").argument("<dest>", "destination")',
        '.argument("<dest>", "destination").argument("<src>", "source")',
      ),
    );
    try {
      runCli(dir, ["init", original.path]);

      const defaultResult = runCli(dir, ["check", reordered.path]);
      expect(defaultResult.status).toBe(0);
      expect(defaultResult.output).toContain("CLI contract is intact.");

      const strictResult = runCli(dir, ["check", reordered.path, "--strict"]);
      expect(strictResult.status).toBe(1);
      expect(strictResult.output).toContain("[strict]");
      expect(strictResult.output).toContain("Argument order changed");
    } finally {
      cleanup();
      original.cleanup();
      reordered.cleanup();
    }
  });

  it("doctor with no entry lists every registered adapter and its known limitations", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["doctor"]);
      expect(status).toBe(0);
      expect(output).toContain("commander:");
      expect(output).toContain("No known limitations.");
      expect(output).toContain("cac:");
      expect(output).toContain("yargs:");
      expect(output).toContain("no declarative");
      expect(output).toContain("fresh, isolated yargs instance");
    } finally {
      cleanup();
    }
  });

  it("doctor <entry> tests real extraction and reports a structural summary", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["doctor", FIXTURE]);
      expect(status).toBe(0);
      expect(output).toContain("Adapter: commander");
      expect(output).toContain("No known limitations.");
      expect(output).toContain("✅ Extraction succeeded");
      expect(output).toContain("command(s)");
      expect(output).toContain("option(s)");
      expect(output).toContain("argument(s)");
    } finally {
      cleanup();
    }
  });

  it("doctor <entry> --adapter cac reports cac's real, known limitations", () => {
    const { dir, cleanup } = makeTempDir();
    const cacFixture = path.join(__dirname, "..", "__fixtures__", "basic-cac-cli.js");
    try {
      const { status, output } = runCli(dir, ["doctor", cacFixture, "--adapter", "cac"]);
      expect(status).toBe(0);
      expect(output).toContain("Adapter: cac");
      expect(output).toContain("no declarative");
      expect(output).toContain("flat list, not a tree");
      expect(output).toContain("✅ Extraction succeeded");
    } finally {
      cleanup();
    }
  });

  it("doctor <entry> reports a real extraction failure instead of crashing", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["doctor", "./does-not-exist.js"]);
      expect(status).toBe(1);
      expect(output).toContain("❌ Extraction failed");
    } finally {
      cleanup();
    }
  });

  it("check --format junit prints valid-looking JUnit XML with a <failure> for a real BREAKING change", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--format", "junit"]);
      expect(status).toBe(1);
      expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(output).toContain("<testsuite");
      expect(output).toContain("<failure");
      expect(output).toContain("root -&gt; build -&gt; option[--target]");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --format gitlab-codequality prints a GitLab Code Quality JSON array with blocker severity", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, [
        "check",
        fixture.path,
        "--format",
        "gitlab-codequality",
      ]);
      expect(status).toBe(1);
      const issues = JSON.parse(output) as {
        severity: string;
        description: string;
        fingerprint: string;
      }[];
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe("blocker");
      expect(issues[0].description).toContain("root -> build -> option[--target]");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("check --format junit reports 0 failures and no <failure> when the contract is intact", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", FIXTURE, "--format", "junit"]);
      expect(status).toBe(0);
      expect(output).toContain('failures="0"');
      expect(output).not.toContain("<failure");
    } finally {
      cleanup();
    }
  });

  it("check --format rejects an unknown format name", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", FIXTURE, "--format", "yaml"]);
      expect(status).toBe(1);
      expect(output).toContain("unknown --format");
      expect(output).toContain("junit");
    } finally {
      cleanup();
    }
  });

  it("diff --format junit works the same way check --format junit does, on two contract files directly", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      const contractPath = path.join(dir, ".cliguard", "contract.json");

      const { status, output } = runCli(dir, [
        "diff",
        contractPath,
        contractPath,
        "--format",
        "junit",
      ]);
      expect(status).toBe(0);
      expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(output).toContain('tests="0"');
    } finally {
      cleanup();
    }
  });

  it("check --format rdjsonl prints one JSON diagnostic per line, ERROR severity for a real BREAKING change", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path, "--format", "rdjsonl"]);
      expect(status).toBe(1);
      const lines = output.trim().split("\n");
      expect(lines).toHaveLength(1);
      const diagnostic = JSON.parse(lines[0]) as { severity: string; code: { value: string } };
      expect(diagnostic.severity).toBe("ERROR");
      expect(diagnostic.code.value).toBe("root -> build -> option[--target]");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("a real cliguard.config.js ignores a matching BREAKING change entirely", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { ignore: ["root -> build -> option[--target]"] };\n',
      );

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("CLI contract is intact.");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("a real cliguard.config.js downgrades a matching BREAKING change to PATCH via severityOverrides", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { severityOverrides: [{ pattern: "root -> build -> option[--target]", severity: "PATCH" }] };\n',
      );

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(0);
      expect(output).toContain("🟡");
      expect(output).toContain("severity overridden to PATCH");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("a malformed cliguard.config.js fails with a clear error instead of crashing cryptically", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      writeFileSync(path.join(dir, "cliguard.config.js"), "not valid javascript {{{\n");

      const { status, output } = runCli(dir, ["check", FIXTURE]);
      expect(status).toBe(1);
      expect(output).toContain("failed to load");
      expect(output).toContain("cliguard.config.js");
    } finally {
      cleanup();
    }
  });

  it("with no cliguard.config.js present, check behaves exactly as before (unaffected)", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      runCli(dir, ["init", FIXTURE]);
      const { status, output } = runCli(dir, ["check", FIXTURE]);
      expect(status).toBe(0);
      expect(output).toContain("CLI contract is intact.");
    } finally {
      cleanup();
    }
  });

  it("a real [unstable]-marked option's removal reports as PATCH, not BREAKING", () => {
    const { dir, cleanup } = makeTempDir();
    // Marks --verbose unstable at the point it's declared, in the target
    // CLI's own source - not in a separate ignore list.
    const original = writeModifiedFixture((source) =>
      source.replace(
        '.option("--verbose", "verbose logging")',
        '.option("--verbose", "verbose logging [unstable]")',
      ),
    );
    const removed = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes('.option("--verbose"'))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", original.path]);

      const { status, output } = runCli(dir, ["check", removed.path]);
      expect(status).toBe(0);
      expect(output).toContain("🟡");
      expect(output).toContain("[unstable: exempt from breaking-change enforcement]");
      expect(output).not.toContain("🔴");
    } finally {
      cleanup();
      original.cleanup();
      removed.cleanup();
    }
  });

  it("an unmarked option's removal still reports as BREAKING, unaffected by the unstable-marker feature", () => {
    const { dir, cleanup } = makeTempDir();
    const fixture = writeModifiedFixture((source) =>
      source
        .split("\n")
        .filter((line) => !line.includes(".requiredOption("))
        .join("\n"),
    );
    try {
      runCli(dir, ["init", FIXTURE]);

      const { status, output } = runCli(dir, ["check", fixture.path]);
      expect(status).toBe(1);
      expect(output).toContain("🔴");
      expect(output).not.toContain("[unstable:");
    } finally {
      cleanup();
      fixture.cleanup();
    }
  });

  it("--version prints the version from package.json", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const { status, output } = runCli(dir, ["--version"]);
      expect(status).toBe(0);
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- reading the same package.json bin.ts itself reads, to assert against the real value rather than a hardcoded copy
      const packageJson = require("../../package.json") as { version: string };
      expect(output.trim()).toBe(packageJson.version);
    } finally {
      cleanup();
    }
  });
});
