/**
 * Framework-agnostic representation of a CLI's public surface. Every
 * adapter (Commander today, Yargs/Clap/Cobra later) normalizes whatever
 * that framework exposes internally into exactly these shapes - the
 * diff engine and the `.cliguard/contract.json` file on disk never know
 * which framework produced a Contract.
 */

/** How a captured option carries its value, as declared by the framework - never guessed from parsing text. */
export type OptionValueType = "boolean" | "string";

export interface OptionContract {
  /** Raw flag declaration as the framework received it, e.g. "-o, --output <path>". Informational only - never diffed directly. */
  readonly flags: string;
  /** Normalized long-form name with no leading dashes, e.g. "output". This is the diff key. */
  readonly name: string;
  /** Short forms / synonyms, e.g. ["-o"]. Order is not significant. */
  readonly aliases: readonly string[];
  readonly description: string;
  /** True for a mandatory option (e.g. Commander's requiredOption). */
  readonly required: boolean;
  readonly valueType: OptionValueType;
  /** True if the option can be passed more than once / collects multiple values. */
  readonly variadic: boolean;
  /** JSON-serializable default, or null if the framework declared none. */
  readonly defaultValue: unknown;
}

export interface ArgumentContract {
  /** Positional argument name, e.g. "file" from "<file>" or "[file]". */
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly description: string;
}

export interface CommandContract {
  readonly name: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly options: readonly OptionContract[];
  readonly arguments: readonly ArgumentContract[];
  readonly subcommands: readonly CommandContract[];
}

/**
 * The full committed shape of `.cliguard/contract.json`. `contractVersion`
 * is this *format's* own schema version (bumped only if we change what a
 * Contract can express), never the target CLI's version.
 */
export interface Contract {
  readonly contractVersion: 1;
  /** Identifier of the adapter that produced this contract, e.g. "commander". */
  readonly adapter: string;
  /** ISO-8601 capture timestamp. Informational only - excluded from diffing. */
  readonly capturedAt: string;
  readonly root: CommandContract;
}

/**
 * A specific BREAKING change the maintainer has deliberately accepted -
 * written by `cliguard accept` and committed to `.cliguard/accepted-breaks.json`
 * so the decision is auditable in the repo, not a silent CLI flag. `check`
 * matches these against a diff's `DiffResult.path` and stops counting a
 * match toward its exit code, while still showing it in the output.
 */
export interface AcceptedBreak {
  /** Must equal the DiffResult.path of the breaking change being accepted, e.g. "root -> build -> option[--target]". */
  readonly path: string;
  /** Why this break is intentional - required, never blank, shown alongside the change. */
  readonly reason: string;
  /** ISO-8601 timestamp of when `cliguard accept` recorded this. */
  readonly acceptedAt: string;
}

/**
 * A command/option/argument the maintainer has scheduled for removal ahead
 * of time - written by `cliguard deprecate` and committed to
 * `.cliguard/deprecations.json`. Unlike `AcceptedBreak` (which forgives a
 * break that already happened), this is recorded *before* the removal:
 * `check`/`diff` reclassify a matching BREAKING removal as PATCH instead
 * of failing the build, but only because the deprecation was announced in
 * advance - removing something with no prior `deprecate` still fails.
 */
export interface Deprecation {
  /** Must equal the DiffResult.path of the eventual removal, e.g. "root -> build -> option[--target]". */
  readonly path: string;
  /** When this is expected to actually go away - a version ("2.0.0") or a date. Informational, never enforced by cliguard itself. */
  readonly removeBy: string;
  /** Why this is being deprecated - optional, shown alongside the change once it's removed. */
  readonly reason?: string;
  /** ISO-8601 timestamp of when `cliguard deprecate` recorded this. */
  readonly deprecatedAt: string;
}

/** Severity of a single detected difference between two contracts. */
export enum ChangeType {
  /** Removes or narrows something a caller may already depend on. */
  BREAKING = "BREAKING",
  /** Purely additive - existing callers are unaffected. */
  ADDITIVE = "ADDITIVE",
  /** Cosmetic only (help text, alias reordering with no collision). */
  PATCH = "PATCH",
  /** No difference at all. Not expected to appear in a diff result list. */
  NONE = "NONE",
}
