import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";

import { ensureDir, makeTempDir, runCli } from "../test-helpers/run-cli";

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
        summary: { breaking: 0, additive: 0, patch: 0 },
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
      expect(result.summary).toEqual({ breaking: 1, additive: 0, patch: 0 });
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
      expect(result.summary).toEqual({ breaking: 0, additive: 1, patch: 0 });
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
