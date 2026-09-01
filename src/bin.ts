#!/usr/bin/env node
import { Command } from "commander";
import { relative, resolve } from "path";

import type { CliAdapter } from "./adapters/adapter.interface";
import { CacAdapter } from "./adapters/cac.adapter";
import { CommanderAdapter } from "./adapters/commander.adapter";
import { YargsAdapter } from "./adapters/yargs.adapter";
import { DiffEngine, type DiffResult } from "./core/diff.engine";
import {
  ciWorkflowExists,
  contractExists,
  getAcceptedBreaksDisplayPath,
  getCiWorkflowDisplayPath,
  getContractDisplayPath,
  readAcceptedBreaks,
  readContract,
  readContractFile,
  writeAcceptedBreaks,
  writeCiWorkflow,
  writeContract,
} from "./core/storage";
import { ChangeType, type AcceptedBreak } from "./core/types";

// Constructing an adapter here is cheap (no eager require of its
// framework - CacAdapter only loads `cac` lazily, inside extract()), so
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
  .option(
    "--with-ci",
    "also scaffold a GitHub Actions workflow that runs cliguard on every pull request",
    false,
  )
  .action(async (entry: string, options: { adapter: string; withCi: boolean }) => {
    if (contractExists()) {
      console.warn(`A contract already exists. Run "cliguard update" to overwrite it.`);
      process.exit(1);
    }

    const exitCode = await withSuppressedExit(async () => {
      const contract = await resolveAdapter(options.adapter).extract(entry);
      writeContract(contract);
      console.log(`✅ CLI contract initialized successfully at ${getContractDisplayPath()}.`);

      if (options.withCi) {
        if (ciWorkflowExists()) {
          console.log(`ℹ️  ${getCiWorkflowDisplayPath()} already exists - left it untouched.`);
        } else {
          const entryPath = relative(process.cwd(), resolve(entry)).split("\\").join("/");
          writeCiWorkflow(buildCiWorkflowYaml(entryPath, options.adapter));
          console.log(`✅ GitHub Actions workflow scaffolded at ${getCiWorkflowDisplayPath()}.`);
        }
      }

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
      const acceptedPaths = indexAcceptedBreaks(readAcceptedBreaks());
      const hasBreaking = diff.some(
        (change) => change.type === ChangeType.BREAKING && !acceptedPaths.has(change.path),
      );

      if (options.json) {
        console.log(JSON.stringify(toJsonResult(diff, acceptedPaths), null, 2));
        return hasBreaking ? 1 : 0;
      }

      if (diff.length === 0) {
        console.log("✅ CLI contract is intact.");
        return 0;
      }

      printDiff(diff, acceptedPaths);
      return hasBreaking ? 1 : 0;
    });
    process.exit(exitCode);
  });

program
  .command("accept")
  .description(
    "Record that a specific BREAKING change is intentional, so `check` stops failing CI for it",
  )
  .argument("<entry>", "path to the target CLI's entry file")
  .argument(
    "<changePath>",
    'the exact DiffResult path to accept, e.g. "root -> build -> option[--target]"',
  )
  .requiredOption("-r, --reason <text>", "why this break is intentional - shown in check output")
  .option(...adapterOption)
  .action(
    async (entry: string, changePath: string, options: { reason: string; adapter: string }) => {
      const exitCode = await withSuppressedExit(async () => {
        const reason = options.reason.trim();
        if (!reason) {
          console.error(
            "cliguard: --reason can't be blank - it's the audit trail for why this break is OK.",
          );
          return 1;
        }

        const oldContract = readContract();
        const newContract = await resolveAdapter(options.adapter).extract(entry);
        const diff = diffEngine.compare(oldContract, newContract);
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
        const remaining = readAcceptedBreaks().filter((accepted) => accepted.path !== changePath);
        const accepted: AcceptedBreak = {
          path: changePath,
          reason,
          acceptedAt: new Date().toISOString(),
        };
        writeAcceptedBreaks([...remaining, accepted]);

        console.log(`✅ Accepted: [${changePath}] ${match.message}`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Recorded in ${getAcceptedBreaksDisplayPath()} - commit this file.`);
        return 0;
      });
      process.exit(exitCode);
    },
  );

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
  .command("diff")
  .description("Compare two contract files directly, without running any CLI")
  .argument("<oldContract>", "path to the older contract JSON file")
  .argument("<newContract>", "path to the newer contract JSON file")
  .option("--json", "print a machine-readable JSON result instead of text", false)
  .action((oldPath: string, newPath: string, options: { json: boolean }) => {
    // No adapter, no target CLI ever loaded here - just two files off
    // disk - so none of withSuppressedExit's process.exit-race concerns
    // apply. A thrown Error (bad path, corrupt JSON) still surfaces via
    // this program's own top-level parseAsync().catch() below.
    const oldContract = readContractFile(oldPath);
    const newContract = readContractFile(newPath);
    const diff = diffEngine.compare(oldContract, newContract);
    const acceptedPaths = indexAcceptedBreaks(readAcceptedBreaks());
    const hasBreaking = diff.some(
      (change) => change.type === ChangeType.BREAKING && !acceptedPaths.has(change.path),
    );

    if (options.json) {
      console.log(JSON.stringify(toJsonResult(diff, acceptedPaths), null, 2));
      process.exit(hasBreaking ? 1 : 0);
    }

    if (diff.length === 0) {
      console.log("✅ Contracts are identical.");
      process.exit(0);
    }

    printDiff(diff, acceptedPaths);
    process.exit(hasBreaking ? 1 : 0);
  });

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

function toJsonResult(
  diff: readonly DiffResult[],
  acceptedPaths: ReadonlyMap<string, AcceptedBreak>,
): JsonCheckResult {
  const changes: JsonChangeResult[] = diff.map((entry) => {
    if (entry.type !== ChangeType.BREAKING) return entry;
    const accepted = acceptedPaths.get(entry.path);
    return accepted ? { ...entry, acknowledged: true, reason: accepted.reason } : entry;
  });

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
