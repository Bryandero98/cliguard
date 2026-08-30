#!/usr/bin/env node
import { Command } from "commander";

import type { CliAdapter } from "./adapters/adapter.interface";
import { CacAdapter } from "./adapters/cac.adapter";
import { CommanderAdapter } from "./adapters/commander.adapter";
import { YargsAdapter } from "./adapters/yargs.adapter";
import { DiffEngine, type DiffResult } from "./core/diff.engine";
import {
  contractExists,
  getContractDisplayPath,
  readContract,
  writeContract,
} from "./core/storage";
import { ChangeType } from "./core/types";

// Constructing an adapter here is cheap (no eager require of its
// framework - optional adapters load their frameworks lazily, inside extract()), so
// every adapter is always registered regardless of which one a given
// invocation actually uses.
const adapters: Readonly<Record<string, CliAdapter>> = {
  commander: new CommanderAdapter(),
  cac: new CacAdapter(),
  yargs: new YargsAdapter(),
};

function resolveAdapter(name: string): CliAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(
      `cliguard: unknown adapter "${name}". Available: ${Object.keys(adapters).join(", ")}.`,
    );
  }
  return adapter;
}

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

program
  .command("init")
  .description("Capture the current CLI surface as the committed contract")
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .action(async (entry: string, options: { adapter: string }) => {
    if (contractExists()) {
      console.warn(`A contract already exists. Run "cliguard update" to overwrite it.`);
      process.exit(1);
    }

    const exitCode = await withSuppressedExit(async () => {
      const contract = await resolveAdapter(options.adapter).extract(entry);
      writeContract(contract);
      console.log(`✅ CLI contract initialized successfully at ${getContractDisplayPath()}.`);
      return 0;
    });
    process.exit(exitCode);
  });

program
  .command("check")
  .description("Compare the current CLI surface against the committed contract")
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .option("--json", "print a machine-readable JSON result instead of text", false)
  .action(async (entry: string, options: { adapter: string; json: boolean }) => {
    const exitCode = await withSuppressedExit(async () => {
      const oldContract = readContract();
      const newContract = await resolveAdapter(options.adapter).extract(entry);
      const diff = diffEngine.compare(oldContract, newContract);
      const hasBreaking = diff.some((entry) => entry.type === ChangeType.BREAKING);

      if (options.json) {
        console.log(JSON.stringify(toJsonResult(diff), null, 2));
        return hasBreaking ? 1 : 0;
      }

      if (diff.length === 0) {
        console.log("✅ CLI contract is intact.");
        return 0;
      }

      printDiff(diff);
      return hasBreaking ? 1 : 0;
    });
    process.exit(exitCode);
  });

program
  .command("update")
  .description("Overwrite the committed contract with the CLI's current surface")
  .argument("<entry>", "path to the target CLI's entry file")
  .option(...adapterOption)
  .action(async (entry: string, options: { adapter: string }) => {
    const exitCode = await withSuppressedExit(async () => {
      const contract = await resolveAdapter(options.adapter).extract(entry);
      writeContract(contract);
      console.log("🔄 CLI contract updated successfully.");
      return 0;
    });
    process.exit(exitCode);
  });

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

interface JsonCheckResult {
  readonly ok: boolean;
  readonly changes: readonly DiffResult[];
  readonly summary: {
    readonly breaking: number;
    readonly additive: number;
    readonly patch: number;
  };
  readonly suggestedBump: SuggestedBump;
}

function toJsonResult(diff: readonly DiffResult[]): JsonCheckResult {
  const summary = {
    breaking: diff.filter((entry) => entry.type === ChangeType.BREAKING).length,
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

  return { ok: summary.breaking === 0, changes: diff, summary, suggestedBump };
}

function printDiff(diff: readonly DiffResult[]): void {
  for (const entry of diff) {
    console.log(`${emojiFor(entry.type)} [${entry.path}] ${entry.message}`);
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
