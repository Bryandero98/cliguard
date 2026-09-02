#!/usr/bin/env node
import { Command } from "commander";
import { basename, relative, resolve } from "path";

import { adapters, resolveAdapter } from "./adapters/registry";
import { applyConfig, loadConfig, resolveTargets, type ResolvedTarget } from "./core/config";
import { DiffEngine, type DiffResult } from "./core/diff.engine";
import { renderMarkdownDocs } from "./core/docs";
import { toGitLabCodeQuality, toJUnitXml, toRdjsonl } from "./core/report-formats";
import {
  ciWorkflowExists,
  contractExists,
  getAcceptedBreaksDisplayPath,
  getCiWorkflowDisplayPath,
  getContractDisplayPath,
  getDeprecationsDisplayPath,
  getHookDisplayPath,
  hookExists,
  readAcceptedBreaks,
  readContract,
  readContractAtRef,
  readContractFile,
  readDeprecations,
  readTextFileIfExists,
  writeAcceptedBreaks,
  writeCiWorkflow,
  writeContract,
  writeDeprecations,
  writeHook,
} from "./core/storage";
import {
  ChangeType,
  type AcceptedBreak,
  type CommandContract,
  type Deprecation,
} from "./core/types";

const diffEngine = new DiffEngine();

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json has no type declarations to import against; require() is the simplest correct read here
const packageJson = require("../package.json") as { version: string };

const program = new Command();
program
  .name("cliguard")
  .description(
    "Snapshot-tests your CLI's contract so you never ship a breaking change by accident.",
  )
  .version(packageJson.version);

const adapterOption = [
  "-a, --adapter <name>",
  "CLI framework adapter to use",
  "commander",
] as const;

const ENTRY_ARGUMENT_DESCRIPTION =
  "path to the target CLI's entry file, or a configured cliguard.config.js target's name - " +
  "omit to run every configured target (see cliguard.config.js's targets)";

/** Shared by init/check/update/accept: resolves what to run against, or prints resolveTargets's own error and exits 1 - identical failure shape across all four. */
function resolveTargetsOrExit(entry: string | undefined, cliAdapter: string): ResolvedTarget[] {
  try {
    return resolveTargets(entry, loadConfig(), cliAdapter);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Runs `action` once per resolved target, printing a `== <name> ==` banner
 * between them only when there's more than one - a single classic target
 * (the common case: no cliguard.config.js, or one that matched no target
 * name) prints exactly as it always has, with no banner at all. The
 * overall exit code is 1 if ANY target's own action returned non-zero,
 * matching `check`'s existing "any BREAKING change fails the build"
 * semantics extended across targets instead of options/arguments.
 */
async function runAcrossTargets(
  targets: readonly ResolvedTarget[],
  action: (target: ResolvedTarget) => Promise<number>,
): Promise<number> {
  let exitCode = 0;
  for (const target of targets) {
    if (targets.length > 1) console.log(`\n== ${target.namespace} ==`);
    const code = await action(target);
    if (code !== 0) exitCode = 1;
  }
  return exitCode;
}

const REPORT_FORMATS = ["text", "json", "junit", "gitlab-codequality", "rdjsonl"] as const;
type ReportFormat = (typeof REPORT_FORMATS)[number];

/** `--json` is a shorthand kept for backward compatibility - equivalent to `--format json` when no explicit `--format` is given. Returns null for an unrecognized `--format` value, distinct from every valid one including "text". */
function resolveFormat(explicit: string | undefined, jsonFlag: boolean): ReportFormat | null {
  const format = explicit ?? (jsonFlag ? "json" : "text");
  return (REPORT_FORMATS as readonly string[]).includes(format) ? (format as ReportFormat) : null;
}

/** Renders every format except "text" (which each command still prints itself, since its "nothing changed" message differs between `check` and `diff`). */
function formatReport(
  diff: readonly DiffResult[],
  acceptedPaths: ReadonlyMap<string, AcceptedBreak>,
  format: Exclude<ReportFormat, "text">,
  contractPath: string,
): string {
  if (format === "json") {
    return JSON.stringify(toJsonResult(diff, acceptedPaths), null, 2);
  }
  const annotated = annotateChanges(diff, acceptedPaths);
  switch (format) {
    case "junit":
      return toJUnitXml(annotated);
    case "gitlab-codequality":
      return toGitLabCodeQuality(annotated, contractPath);
    case "rdjsonl":
      return toRdjsonl(annotated, contractPath);
  }
}

program
  .command("init")
  .description("Capture the current CLI surface as the committed contract")
  .argument("[entry]", ENTRY_ARGUMENT_DESCRIPTION)
  .option(...adapterOption)
  .option(
    "--with-ci",
    "also scaffold a GitHub Actions workflow that runs cliguard on every pull request",
    false,
  )
  .action(async (entry: string | undefined, options: { adapter: string; withCi: boolean }) => {
    const targets = resolveTargetsOrExit(entry, options.adapter);
    if (options.withCi && targets.length > 1) {
      console.error(
        "cliguard: --with-ci supports a single target at a time - run " +
          "`cliguard init <name> --with-ci` for one target, or write the workflow by hand " +
          "for a multi-target project.",
      );
      process.exit(1);
    }

    const exitCode = await runAcrossTargets(targets, (target) =>
      withSuppressedExit(async () => {
        if (contractExists(target.namespace)) {
          const suffix = target.namespace ? ` ${target.namespace}` : "";
          console.warn(`A contract already exists. Run "cliguard update${suffix}" to overwrite it.`);
          return 1;
        }

        const contract = await resolveAdapter(target.adapter).extract(target.entry);
        writeContract(contract, target.namespace);
        console.log(
          `✅ CLI contract initialized successfully at ${getContractDisplayPath(target.namespace)}.`,
        );

        if (options.withCi) {
          if (ciWorkflowExists()) {
            console.log(`ℹ️  ${getCiWorkflowDisplayPath()} already exists - left it untouched.`);
          } else {
            const entryPath = relative(process.cwd(), resolve(target.entry)).split("\\").join("/");
            writeCiWorkflow(buildCiWorkflowYaml(entryPath, target.adapter));
            console.log(`✅ GitHub Actions workflow scaffolded at ${getCiWorkflowDisplayPath()}.`);
          }
        }

        return 0;
      }),
    );
    process.exit(exitCode);
  });

program
  .command("check")
  .description("Compare the current CLI surface against the committed contract")
  .argument("[entry]", ENTRY_ARGUMENT_DESCRIPTION)
  .option(...adapterOption)
  .option(
    "--json",
    "print a machine-readable JSON result instead of text (shorthand for --format json)",
    false,
  )
  .option("--format <format>", `output format: ${REPORT_FORMATS.join(", ")}`)
  .option(
    "--against <ref>",
    "compare against a git ref's committed contract (e.g. origin/main, a tag, a commit sha) instead of the .cliguard/contract.json on disk",
  )
  .option(
    "--strict",
    "enable extra rules for currently-silent risky changes (e.g. a positional argument reorder)",
    false,
  )
  .action(
    async (
      entry: string | undefined,
      options: {
        adapter: string;
        json: boolean;
        format?: string;
        against?: string;
        strict: boolean;
      },
    ) => {
      const targets = resolveTargetsOrExit(entry, options.adapter);

      const exitCode = await runAcrossTargets(targets, (target) =>
        withSuppressedExit(async () => {
          const format = resolveFormat(options.format, options.json);
          if (!format) {
            console.error(
              `cliguard: unknown --format "${options.format}". Use ${REPORT_FORMATS.join(", ")}.`,
            );
            return 1;
          }

          const oldContract = options.against
            ? readContractAtRef(options.against, target.namespace)
            : readContract(target.namespace);
          const newContract = await resolveAdapter(target.adapter).extract(target.entry);
          const diff = applyDeprecations(
            diffEngine.applyUnstableMarkers(
              applyConfig(
                diffEngine.compare(oldContract, newContract, { strict: options.strict }),
                loadConfig(),
              ),
              oldContract,
              newContract,
            ),
            indexDeprecations(readDeprecations(target.namespace)),
          );
          const acceptedPaths = indexAcceptedBreaks(readAcceptedBreaks(target.namespace));
          const hasBreaking = diff.some(
            (change) => change.type === ChangeType.BREAKING && !acceptedPaths.has(change.path),
          );

          if (format !== "text") {
            console.log(
              formatReport(diff, acceptedPaths, format, getContractDisplayPath(target.namespace)),
            );
            return hasBreaking ? 1 : 0;
          }

          if (diff.length === 0) {
            console.log("✅ CLI contract is intact.");
            return 0;
          }

          printDiff(diff, acceptedPaths);
          return hasBreaking ? 1 : 0;
        }),
      );
      process.exit(exitCode);
    },
  );

program
  .command("accept")
  .description(
    "Record that a specific BREAKING change is intentional, so `check` stops failing CI for it",
  )
  .argument(
    "<entry>",
    "path to the target CLI's entry file, or a configured cliguard.config.js target's name - " +
      "always required here (unlike check/init/update): accepting a change is inherently a " +
      "one-target operation, so there's no sensible \"omit to run every target\" mode",
  )
  .argument(
    "<changePath>",
    'the exact DiffResult path to accept, e.g. "root -> build -> option[--target]"',
  )
  .requiredOption("-r, --reason <text>", "why this break is intentional - shown in check output")
  .option(...adapterOption)
  .option(
    "--strict",
    "match against the same --strict rules used to find this change (e.g. a positional argument reorder) - required to accept one, since it's otherwise invisible to the default comparison",
    false,
  )
  .action(
    async (
      entry: string,
      changePath: string,
      options: { reason: string; adapter: string; strict: boolean },
    ) => {
      const targets = resolveTargetsOrExit(entry, options.adapter);

      const exitCode = await runAcrossTargets(targets, (target) =>
        withSuppressedExit(async () => {
          const reason = options.reason.trim();
          if (!reason) {
            console.error(
              "cliguard: --reason can't be blank - it's the audit trail for why this break is OK.",
            );
            return 1;
          }

          const oldContract = readContract(target.namespace);
          const newContract = await resolveAdapter(target.adapter).extract(target.entry);
          const diff = applyDeprecations(
            diffEngine.applyUnstableMarkers(
              applyConfig(
                diffEngine.compare(oldContract, newContract, { strict: options.strict }),
                loadConfig(),
              ),
              oldContract,
              newContract,
            ),
            indexDeprecations(readDeprecations(target.namespace)),
          );
          const match = diff.find(
            (change) => change.type === ChangeType.BREAKING && change.path === changePath,
          );

          if (!match) {
            const breaking = diff.filter((change) => change.type === ChangeType.BREAKING);
            console.error(
              `cliguard: no current BREAKING change at path "${changePath}".` +
                (breaking.length === 0
                  ? " There are no BREAKING changes right now - nothing to accept."
                  : ` Currently breaking:\n${breaking.map((change) => `  - ${change.path}`).join("\n")}`),
            );
            return 1;
          }

          // Replaces any earlier acceptance at the same path rather than
          // accumulating duplicates - re-running `accept` updates the reason.
          const remaining = readAcceptedBreaks(target.namespace).filter(
            (accepted) => accepted.path !== changePath,
          );
          const accepted: AcceptedBreak = {
            path: changePath,
            reason,
            acceptedAt: new Date().toISOString(),
          };
          writeAcceptedBreaks([...remaining, accepted], target.namespace);

          console.log(`✅ Accepted: [${changePath}] ${match.message}`);
          console.log(`   Reason: ${reason}`);
          console.log(
            `   Recorded in ${getAcceptedBreaksDisplayPath(target.namespace)} - commit this file.`,
          );
          return 0;
        }),
      );
      process.exit(exitCode);
    },
  );

program
  .command("deprecate")
  .description(
    "Schedule a command/option/argument for removal ahead of time, so that removal counts as PATCH instead of BREAKING",
  )
  .argument("<entry>", "path to the target CLI's entry file")
  .argument(
    "<path>",
    'the exact Contract path to deprecate, e.g. "root -> build -> option[--target]" - still present today, not yet removed',
  )
  .requiredOption(
    "--remove-by <versionOrDate>",
    'when this is expected to actually go away (e.g. "2.0.0" or "2026-12-01") - informational, never enforced by cliguard itself',
  )
  .option("-r, --reason <text>", "why this is being deprecated - shown once it's removed")
  .option(...adapterOption)
  .action(
    async (
      entry: string,
      path: string,
      options: { removeBy: string; reason?: string; adapter: string },
    ) => {
      const exitCode = await withSuppressedExit(async () => {
        const contract = await resolveAdapter(options.adapter).extract(entry);
        const validPaths = diffEngine.collectPaths(contract);

        if (!validPaths.has(path)) {
          console.error(
            `cliguard: no such path "${path}" in the current contract - it may already be ` +
              "removed, or never existed. Run `cliguard preview <entry>` to see the current contract.",
          );
          return 1;
        }

        // Replaces any earlier deprecation at the same path rather than
        // accumulating duplicates - re-running `deprecate` updates the
        // remove-by/reason, same as `accept` does for its own reason.
        const remaining = readDeprecations().filter((existing) => existing.path !== path);
        const deprecation: Deprecation = {
          path,
          removeBy: options.removeBy,
          reason: options.reason,
          deprecatedAt: new Date().toISOString(),
        };
        writeDeprecations([...remaining, deprecation]);

        console.log(`✅ Deprecated: [${path}]`);
        console.log(`   Remove by: ${options.removeBy}`);
        if (options.reason) console.log(`   Reason: ${options.reason}`);
        console.log(
          `   Recorded in ${getDeprecationsDisplayPath()} - commit this file. ` +
            "Its eventual removal will count as PATCH, not BREAKING.",
        );
        return 0;
      });
      process.exit(exitCode);
    },
  );

program
  .command("update")
  .description("Overwrite the committed contract with the CLI's current surface")
  .argument("[entry]", ENTRY_ARGUMENT_DESCRIPTION)
  .option(...adapterOption)
  .action(async (entry: string | undefined, options: { adapter: string }) => {
    const targets = resolveTargetsOrExit(entry, options.adapter);

    const exitCode = await runAcrossTargets(targets, (target) =>
      withSuppressedExit(async () => {
        const contract = await resolveAdapter(target.adapter).extract(target.entry);
        writeContract(contract, target.namespace);
        console.log("🔄 CLI contract updated successfully.");
        return 0;
      }),
    );
    process.exit(exitCode);
  });

program
  .command("preview")
  .description(
    "Extract the current CLI's contract and print it, without writing .cliguard/contract.json",
  )
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .action(async (entry: string, options: { adapter: string }) => {
    const exitCode = await withSuppressedExit(async () => {
      const contract = await resolveAdapter(options.adapter).extract(entry);
      console.log(JSON.stringify(contract, null, 2));
      return 0;
    });
    process.exit(exitCode);
  });

program
  .command("docs")
  .description(
    "Generate Markdown CLI reference docs from the current contract - guaranteed to match the real CLI surface, since it's the same model `check` fails CI over",
  )
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .option(
    "--check <path>",
    "compare against a committed docs file instead of printing - exits 1 if it's stale",
  )
  .action(async (entry: string, options: { adapter: string; check?: string }) => {
    const exitCode = await withSuppressedExit(async () => {
      const contract = await resolveAdapter(options.adapter).extract(entry);
      const markdown = renderMarkdownDocs(contract, basename(entry));

      if (!options.check) {
        // process.stdout.write, not console.log - markdown already ends
        // in exactly one trailing newline, and console.log would add a
        // second one, so a file saved via `> CLI.md` would never again
        // match itself under `--check` (the mismatch this comment is
        // replacing was caught by a live round-trip test, not review).
        process.stdout.write(markdown);
        return 0;
      }

      const committed = readTextFileIfExists(options.check);
      if (committed === null) {
        console.error(
          `cliguard: no such file: "${options.check}". Run \`cliguard docs ${entry} > ${options.check}\` first.`,
        );
        return 1;
      }
      if (committed === markdown) {
        console.log(`✅ ${options.check} matches the current CLI surface.`);
        return 0;
      }
      console.error(
        `cliguard: "${options.check}" is stale - it no longer matches the current CLI surface. ` +
          `Regenerate with \`cliguard docs ${entry} > ${options.check}\`.`,
      );
      return 1;
    });
    process.exit(exitCode);
  });

program
  .command("doctor")
  .description(
    "Show every adapter's known limitations, or sanity-check one against a real entry file",
  )
  .argument("[entry]", "optional: path to a target CLI's entry file to actually test extraction")
  .option(...adapterOption)
  .action(async (entry: string | undefined, options: { adapter: string }) => {
    if (!entry) {
      printAdapterLimitations();
      process.exit(0);
    }

    const exitCode = await withSuppressedExit(async () => {
      const adapter = resolveAdapter(options.adapter);
      console.log(`Adapter: ${adapter.id}`);
      if (adapter.limitations.length === 0) {
        console.log("  No known limitations.");
      } else {
        for (const limitation of adapter.limitations) {
          console.log(`  ⚠️  ${limitation}`);
        }
      }
      console.log("");

      try {
        const contract = await adapter.extract(entry);
        const summary = summarizeCommand(contract.root);
        console.log(
          `✅ Extraction succeeded: ${summary.commands} command(s), ` +
            `${summary.options} option(s), ${summary.arguments} argument(s).`,
        );
        return 0;
      } catch (error) {
        console.error(
          `❌ Extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 1;
      }
    });
    process.exit(exitCode);
  });

const HOOK_NAMES = ["pre-commit", "pre-push"] as const;
type HookName = (typeof HOOK_NAMES)[number];

program
  .command("install-hook")
  .description(
    "Install a git hook that runs `cliguard check` automatically, catching a breaking change before it ever reaches CI",
  )
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .option("--hook <name>", `which git hook to install: ${HOOK_NAMES.join(" or ")}`, "pre-push")
  .action((entry: string, options: { adapter: string; hook: string }) => {
    if (!isHookName(options.hook)) {
      console.error(
        `cliguard: --hook must be one of ${HOOK_NAMES.join(", ")} - got "${options.hook}".`,
      );
      process.exit(1);
    }

    if (hookExists(options.hook)) {
      console.log(`ℹ️  ${getHookDisplayPath(options.hook)} already exists - left it untouched.`);
      process.exit(0);
    }

    const entryPath = relative(process.cwd(), resolve(entry)).split("\\").join("/");
    writeHook(options.hook, buildHookScript(entryPath, options.adapter));
    console.log(`✅ Git hook installed at ${getHookDisplayPath(options.hook)}.`);
    process.exit(0);
  });

program
  .command("diff")
  .description("Compare two contract files directly, without running any CLI")
  .argument("<oldContract>", "path to the older contract JSON file")
  .argument("<newContract>", "path to the newer contract JSON file")
  .option(
    "--json",
    "print a machine-readable JSON result instead of text (shorthand for --format json)",
    false,
  )
  .option("--format <format>", `output format: ${REPORT_FORMATS.join(", ")}`)
  .option(
    "--strict",
    "enable extra rules for currently-silent risky changes (e.g. a positional argument reorder)",
    false,
  )
  .action(
    (
      oldPath: string,
      newPath: string,
      options: { json: boolean; format?: string; strict: boolean },
    ) => {
      // No adapter, no target CLI ever loaded here - just two files off
      // disk - so none of withSuppressedExit's process.exit-race concerns
      // apply. A thrown Error (bad path, corrupt JSON) still surfaces via
      // this program's own top-level parseAsync().catch() below.
      const format = resolveFormat(options.format, options.json);
      if (!format) {
        console.error(
          `cliguard: unknown --format "${options.format}". Use ${REPORT_FORMATS.join(", ")}.`,
        );
        process.exit(1);
      }

      const oldContract = readContractFile(oldPath);
      const newContract = readContractFile(newPath);
      const diff = applyDeprecations(
        diffEngine.applyUnstableMarkers(
          applyConfig(
            diffEngine.compare(oldContract, newContract, { strict: options.strict }),
            loadConfig(),
          ),
          oldContract,
          newContract,
        ),
        indexDeprecations(readDeprecations()),
      );
      const acceptedPaths = indexAcceptedBreaks(readAcceptedBreaks());
      const hasBreaking = diff.some(
        (change) => change.type === ChangeType.BREAKING && !acceptedPaths.has(change.path),
      );

      if (format !== "text") {
        console.log(formatReport(diff, acceptedPaths, format, newPath));
        process.exit(hasBreaking ? 1 : 0);
      }

      if (diff.length === 0) {
        console.log("✅ Contracts are identical.");
        process.exit(0);
      }

      printDiff(diff, acceptedPaths);
      process.exit(hasBreaking ? 1 : 0);
    },
  );

/**
 * The same workflow the README's "CI integration" section documents by
 * hand - generated here so `init --with-ci` never drifts from it. `entry`
 * is expected already normalized (forward slashes, relative to cwd); the
 * adapter line is only emitted for a non-default adapter, matching the
 * Action's own `adapter` input default of "commander".
 */
function buildCiWorkflowYaml(entryPath: string, adapter: string): string {
  const lines = [
    "# Generated by `cliguard init --with-ci` - edit freely, cliguard won't touch this file again.",
    "name: CLI contract",
    "on: [pull_request]",
    "permissions:",
    "  pull-requests: write # needed for the PR comment",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 22.x }",
    "      - run: npm ci",
    "      - uses: Bryandero98/cliguard@v1",
    "        with:",
    `          entry: ./${entryPath}`,
  ];
  if (adapter !== "commander") {
    lines.push(`          adapter: ${adapter}`);
  }
  return lines.join("\n") + "\n";
}

function printAdapterLimitations(): void {
  console.log("Registered adapters and their known limitations:\n");
  for (const adapter of Object.values(adapters)) {
    console.log(adapter.id + ":");
    if (adapter.limitations.length === 0) {
      console.log("  No known limitations.");
    } else {
      for (const limitation of adapter.limitations) {
        console.log(`  ⚠️  ${limitation}`);
      }
    }
    console.log("");
  }
}

interface ContractSummary {
  readonly commands: number;
  readonly options: number;
  readonly arguments: number;
}

function summarizeCommand(cmd: CommandContract): ContractSummary {
  let commands = 1;
  let options = cmd.options.length;
  let args = cmd.arguments.length;
  for (const sub of cmd.subcommands) {
    const subSummary = summarizeCommand(sub);
    commands += subSummary.commands;
    options += subSummary.options;
    args += subSummary.arguments;
  }
  return { commands, options, arguments: args };
}

function isHookName(value: string): value is HookName {
  return (HOOK_NAMES as readonly string[]).includes(value);
}

/**
 * A minimal POSIX-sh script - Git for Windows runs hooks through its own
 * bundled sh.exe via the shebang, same as any other platform, so one
 * script body works everywhere without a separate Windows path.
 */
function buildHookScript(entryPath: string, adapter: string): string {
  const adapterFlag = adapter === "commander" ? "" : ` --adapter ${adapter}`;
  return [
    "#!/bin/sh",
    "# Installed by `cliguard install-hook` - edit freely, cliguard won't touch this file again.",
    `npx cliguard check "${entryPath}"${adapterFlag}`,
    "",
  ].join("\n");
}

/**
 * Runs `action` with `process.exit` neutralized, restoring the real one
 * the instant `action` settles - then the caller calls the *real*
 * `process.exit` immediately with cliguard's own, correct code.
 *
 * Why this exists: the fallback in commander.adapter.ts /
 * cac.adapter.ts's construction-capture lets a target CLI's own
 * top-level code run further than a plain export lookup ever did - real
 * targets often call `.parse()`/`.run()` for real as a side effect of
 * being loaded, sometimes asynchronously (an `await` inside their own
 * main function, a dangling `.catch()` continuation still in flight).
 * Node's `process.exit()` is immediate and unconditional - if that
 * dangling target code calls it (even with an unrelated code, even
 * *after* cliguard already computed the right answer), it kills this
 * process with the target's exit code, not cliguard's. Restoring the
 * real `process.exit` and calling it ourselves right away, synchronously,
 * the moment `action` resolves closes the race: Node's exit is immediate
 * and single-threaded, so nothing queued after that point - including
 * whatever the target's own code was about to do - ever runs.
 */
async function withSuppressedExit<T>(action: () => Promise<T>): Promise<T> {
  const realExit = process.exit.bind(process);
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- deliberately a no-op: see doc comment above
  process.exit = (() => undefined) as unknown as typeof process.exit;
  try {
    return await action();
  } finally {
    process.exit = realExit;
  }
}

/** A version bump under semver that this diff implies, or null if nothing changed. */
type SuggestedBump = "major" | "minor" | "patch" | null;

function indexAcceptedBreaks(
  accepted: readonly AcceptedBreak[],
): ReadonlyMap<string, AcceptedBreak> {
  return new Map(accepted.map((entry) => [entry.path, entry]));
}

function indexDeprecations(deprecations: readonly Deprecation[]): ReadonlyMap<string, Deprecation> {
  return new Map(deprecations.map((entry) => [entry.path, entry]));
}

/**
 * Reclassifies a BREAKING removal at a deprecated path as PATCH, folding
 * the deprecation's own record into the message - a scheduled, announced
 * removal is no longer a surprise to whoever's relying on the flag, so it
 * shouldn't fail the build the way an unannounced one still does. Only
 * ever touches entries with `removal: true` (see DiffResult) - a
 * *different* kind of BREAKING change at the same path (e.g. a default
 * value change on an option that also happens to be deprecated) is left
 * alone, since deprecating a removal says nothing about other changes.
 */
function applyDeprecations(
  diff: readonly DiffResult[],
  deprecations: ReadonlyMap<string, Deprecation>,
): DiffResult[] {
  return diff.map((entry) => {
    if (entry.type !== ChangeType.BREAKING || !entry.removal) return entry;
    const deprecation = deprecations.get(entry.path);
    if (!deprecation) return entry;

    return {
      type: ChangeType.PATCH,
      path: entry.path,
      message:
        `${entry.message} Deprecated ${deprecation.deprecatedAt.slice(0, 10)}, ` +
        `scheduled removal by ${deprecation.removeBy}` +
        (deprecation.reason ? ` (${deprecation.reason})` : "") +
        " - this removal was expected.",
    };
  });
}

interface JsonChangeResult extends DiffResult {
  /** Present (and true) only on a BREAKING entry matched by `cliguard accept`. */
  readonly acknowledged?: true;
  /** The reason recorded for the acceptance - present exactly when `acknowledged` is. */
  readonly reason?: string;
}

interface JsonCheckResult {
  readonly ok: boolean;
  readonly changes: readonly JsonChangeResult[];
  readonly summary: {
    readonly breaking: number;
    readonly acknowledgedBreaking: number;
    readonly additive: number;
    readonly patch: number;
  };
  readonly suggestedBump: SuggestedBump;
}

/** A BREAKING entry matched by `cliguard accept` gains `acknowledged: true` and its recorded `reason`; every other entry passes through unchanged. Shared by --json, --format junit, and --format gitlab-codequality so all three agree on what "acknowledged" means. */
function annotateChanges(
  diff: readonly DiffResult[],
  acceptedPaths: ReadonlyMap<string, AcceptedBreak>,
): JsonChangeResult[] {
  return diff.map((entry) => {
    if (entry.type !== ChangeType.BREAKING) return entry;
    const accepted = acceptedPaths.get(entry.path);
    return accepted ? { ...entry, acknowledged: true, reason: accepted.reason } : entry;
  });
}

function toJsonResult(
  diff: readonly DiffResult[],
  acceptedPaths: ReadonlyMap<string, AcceptedBreak>,
): JsonCheckResult {
  const changes = annotateChanges(diff, acceptedPaths);

  const summary = {
    breaking: changes.filter(
      (change) => change.type === ChangeType.BREAKING && !change.acknowledged,
    ).length,
    acknowledgedBreaking: changes.filter(
      (change) => change.type === ChangeType.BREAKING && change.acknowledged,
    ).length,
    additive: diff.filter((entry) => entry.type === ChangeType.ADDITIVE).length,
    patch: diff.filter((entry) => entry.type === ChangeType.PATCH).length,
  };
  const suggestedBump: SuggestedBump =
    summary.breaking > 0
      ? "major"
      : summary.additive > 0
        ? "minor"
        : summary.patch > 0
          ? "patch"
          : null;

  return { ok: summary.breaking === 0, changes, summary, suggestedBump };
}

function printDiff(
  diff: readonly DiffResult[],
  acceptedPaths: ReadonlyMap<string, AcceptedBreak>,
): void {
  for (const entry of diff) {
    const accepted = entry.type === ChangeType.BREAKING ? acceptedPaths.get(entry.path) : undefined;
    if (accepted) {
      console.log(`🟣 [${entry.path}] ${entry.message} (acknowledged: ${accepted.reason})`);
    } else {
      console.log(`${emojiFor(entry.type)} [${entry.path}] ${entry.message}`);
    }
  }
}

function emojiFor(type: ChangeType): string {
  switch (type) {
    case ChangeType.BREAKING:
      return "🔴";
    case ChangeType.PATCH:
      return "🟡";
    case ChangeType.ADDITIVE:
      return "🟢";
    default:
      return "⚪";
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
