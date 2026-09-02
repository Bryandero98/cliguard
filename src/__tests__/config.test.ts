import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import {
  applyConfig,
  configExists,
  loadConfig,
  resolveTargets,
  type CliguardConfig,
} from "../core/config";
import type { DiffResult } from "../core/diff.engine";
import { ChangeType } from "../core/types";

// resolveConfigPath() (inside config.ts) reads process.cwd() fresh on
// every call rather than caching it at import time, so - unlike
// storage.test.ts's CONTRACT_PATH - a plain chdir() around each test is
// enough; no jest.isolateModules needed here.
function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "cliguard-config-"));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    run(dir);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function change(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    type: ChangeType.BREAKING,
    path: "root -> option[--target]",
    message: "removed",
    ...overrides,
  };
}

describe("applyConfig", () => {
  it("returns the diff unchanged when the config has neither ignore nor severityOverrides", () => {
    const diff = [change()];
    expect(applyConfig(diff, {})).toEqual(diff);
  });

  it("drops a change whose path matches an ignore glob entirely", () => {
    const diff = [
      change({ path: "root -> option[--debug]" }),
      change({ path: "root -> option[--target]" }),
    ];
    const config: CliguardConfig = { ignore: ["root -> option[--debug]"] };

    expect(applyConfig(diff, config)).toEqual([diff[1]]);
  });

  it("supports a single * wildcard in an ignore glob", () => {
    const diff = [change({ path: "root -> debug -> option[--verbose]" })];
    const config: CliguardConfig = { ignore: ["root -> * -> option[--verbose]"] };

    expect(applyConfig(diff, config)).toEqual([]);
  });

  it("supports a real RegExp in ignore, not just a glob string", () => {
    const diff = [
      change({ path: "root -> option[--debug-x]" }),
      change({ path: "root -> option[--other]" }),
    ];
    const config: CliguardConfig = { ignore: [/--debug-.*/] };

    expect(applyConfig(diff, config)).toEqual([diff[1]]);
  });

  it("reclassifies a matching change's severity, annotating the message", () => {
    const diff = [change({ path: "root -> option[--alias]" })];
    const config: CliguardConfig = {
      severityOverrides: [{ pattern: "root -> option[--alias]", severity: ChangeType.PATCH }],
    };

    const [result] = applyConfig(diff, config);

    expect(result.type).toBe(ChangeType.PATCH);
    expect(result.message).toContain("severity overridden to PATCH");
  });

  it("leaves a change untouched when no severityOverrides pattern matches it", () => {
    const diff = [change()];
    const config: CliguardConfig = {
      severityOverrides: [{ pattern: "root -> option[--unrelated]", severity: ChangeType.PATCH }],
    };

    expect(applyConfig(diff, config)).toEqual(diff);
  });

  it("applies ignore before severityOverrides, so an ignored path never gets reclassified either", () => {
    const diff = [change({ path: "root -> option[--debug]" })];
    const config: CliguardConfig = {
      ignore: ["root -> option[--debug]"],
      severityOverrides: [{ pattern: "root -> option[--debug]", severity: ChangeType.PATCH }],
    };

    expect(applyConfig(diff, config)).toEqual([]);
  });
});

describe("loadConfig / configExists", () => {
  it("returns {} and false when no config file exists", () => {
    withTempDir(() => {
      expect(configExists()).toBe(false);
      expect(loadConfig()).toEqual({});
    });
  });

  it("loads a real cliguard.config.js off disk", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { ignore: ["root -> option[--debug]"] };\n',
      );

      expect(configExists()).toBe(true);
      expect(loadConfig()).toEqual({ ignore: ["root -> option[--debug]"] });
    });
  });

  it("also loads cliguard.config.cjs", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "cliguard.config.cjs"), "module.exports = { ignore: [] };\n");

      expect(loadConfig()).toEqual({ ignore: [] });
    });
  });

  it("throws a clear error when the config file has a real syntax error", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "cliguard.config.js"), "this is not valid javascript {{{\n");

      expect(() => loadConfig()).toThrow("failed to load");
    });
  });

  it("throws a clear error when severityOverrides has an invalid severity value", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { severityOverrides: [{ pattern: "x", severity: "NOT_REAL" }] };\n',
      );

      expect(() => loadConfig()).toThrow("severityOverrides");
    });
  });

  it("throws a clear error when the config doesn't export an object at all", () => {
    withTempDir((dir) => {
      writeFileSync(path.join(dir, "cliguard.config.js"), "module.exports = 42;\n");

      expect(() => loadConfig()).toThrow("must export an object");
    });
  });

  it("loads a real targets array off disk", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { targets: [{ name: "a", entry: "bin/a.js" }] };\n',
      );

      expect(loadConfig()).toEqual({ targets: [{ name: "a", entry: "bin/a.js" }] });
    });
  });

  it("throws a clear error when a targets entry is missing name or entry", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { targets: [{ name: "a" }] };\n',
      );

      expect(() => loadConfig()).toThrow('"targets" entries must look like');
    });
  });

  it("throws a clear error when two targets share the same name", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "cliguard.config.js"),
        'module.exports = { targets: [{ name: "a", entry: "x.js" }, { name: "a", entry: "y.js" }] };\n',
      );

      expect(() => loadConfig()).toThrow('more than one entry named "a"');
    });
  });
});

describe("resolveTargets", () => {
  const config: CliguardConfig = {
    targets: [
      { name: "cli-a", entry: "packages/cli-a/bin/index.js", adapter: "yargs" },
      { name: "cli-b", entry: "packages/cli-b/bin/index.js" },
    ],
  };

  it("treats an explicit entry that matches no target's name as a literal file path - today's behavior, unaffected by config", () => {
    expect(resolveTargets("./bin/cli.js", config, "commander")).toEqual([
      { namespace: null, entry: "./bin/cli.js", adapter: "commander" },
    ]);
  });

  it("treats an explicit entry as a literal path even when targets is configured but empty/absent - a project with no targets is completely unaffected", () => {
    expect(resolveTargets("./bin/cli.js", {}, "commander")).toEqual([
      { namespace: null, entry: "./bin/cli.js", adapter: "commander" },
    ]);
  });

  it("resolves a single named target when the entry matches a configured target's name, using that target's own adapter", () => {
    expect(resolveTargets("cli-a", config, "commander")).toEqual([
      { namespace: "cli-a", entry: "packages/cli-a/bin/index.js", adapter: "yargs" },
    ]);
  });

  it("defaults a matched target's adapter to commander when the target doesn't specify one", () => {
    expect(resolveTargets("cli-b", config, "commander")).toEqual([
      { namespace: "cli-b", entry: "packages/cli-b/bin/index.js", adapter: "commander" },
    ]);
  });

  it("resolves every configured target when entry is omitted", () => {
    expect(resolveTargets(undefined, config, "commander")).toEqual([
      { namespace: "cli-a", entry: "packages/cli-a/bin/index.js", adapter: "yargs" },
      { namespace: "cli-b", entry: "packages/cli-b/bin/index.js", adapter: "commander" },
    ]);
  });

  it("throws when entry is omitted and no targets are configured - nothing to run", () => {
    expect(() => resolveTargets(undefined, {}, "commander")).toThrow(
      "no entry given and no targets configured",
    );
  });
});
