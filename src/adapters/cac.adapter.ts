import type { CAC, Command as CacCommand } from "cac";

// cac's own package doesn't export the `Option` class as a named export
// (only CAC, Command, and the cac() factory are) - derived here via
// indexed access on Command['options'] instead of importing it directly.
type CacOption = CacCommand["options"][number];

import type { CommandContract, Contract, OptionContract, OptionValueType } from "../core/types";
import type { CliAdapter } from "./adapter.interface";
import { loadModule } from "./load-module";

/**
 * Extracts a Contract from a target file that exports a `cac()` `CAC`
 * instance. Never parses --help output - every field comes straight from
 * CAC's own object graph (`.commands`, `.globalCommand`, `.options`,
 * `.args`), matching CommanderAdapter's approach.
 *
 * Two real shape differences from Commander, not bugs:
 * - CAC has no declarative "this option must be passed" concept (unlike
 *   Commander's `requiredOption`) - `checkOptionValue` (cac's own source)
 *   only validates the *value* of an option that was actually passed, so
 *   `OptionContract.required` is always `false` here.
 * - CAC's commands are a flat list off the root `CAC` instance, not a
 *   tree - there's no nested sub-subcommand concept to recurse into, so
 *   every mapped command's own `subcommands` is always `[]`.
 */
export class CacAdapter implements CliAdapter {
  readonly id = "cac";

  async extract(entryPath: string): Promise<Contract> {
    const cli = await this.loadCac(entryPath);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.mapRoot(cli),
    };
  }

  private async loadCac(entryPath: string): Promise<CAC> {
    const { viaImport, viaRequire } = await loadModule(entryPath);
    const cli = this.findCac(viaImport.moduleExports) ?? this.findCac(viaRequire.moduleExports);
    if (cli) return cli;

    // See CommanderAdapter's identical block for why both real errors -
    // not a swallowed, generic guess - matter here.
    throw new Error(
      `cliguard: no CAC instance found in "${entryPath}". ` +
        "Export it as `export default cli`, `module.exports = cli`, " +
        "or a named export (e.g. `export const cli = cac()`).\n" +
        `  import() failed: ${viaImport.error ?? "module loaded, but exported no CAC instance"}\n` +
        `  require() failed: ${viaRequire.error ?? "module loaded, but exported no CAC instance"}`,
    );
  }

  /** Handles `export default`, `module.exports = cli`, and named exports. */
  private findCac(moduleExports: unknown): CAC | undefined {
    if (this.looksLikeCac(moduleExports)) {
      return moduleExports;
    }

    if (moduleExports && typeof moduleExports === "object") {
      const exportsObject = moduleExports as Record<string, unknown>;

      if (this.looksLikeCac(exportsObject.default)) {
        return exportsObject.default;
      }

      for (const value of Object.values(exportsObject)) {
        if (this.looksLikeCac(value)) return value;
      }
    }

    return undefined;
  }

  /**
   * Structural check, not `instanceof CAC` - see CommanderAdapter's
   * identical-purpose `looksLikeCommand` for why: the target project's
   * own `cac` install is almost always a separate copy from any `cac`
   * cliguard itself could resolve, even at the identical version, so
   * `instanceof` fails by construction. This also removes the only
   * reason this adapter ever needed `cac` installed in cliguard's own
   * environment - `require("cac")` from cliguard's own (often
   * `npx`-isolated) location previously gated every use of this adapter
   * behind a package cliguard could rarely actually see, even when the
   * target project had it. The target file's own `require("cac")` /
   * `import("cac")`, resolved from *its* location by `loadModule`, is
   * the only place `cac` needs to be installed now - and if it isn't,
   * that failure surfaces below via the real load error, same as any
   * other missing dependency.
   */
  private looksLikeCac(value: unknown): value is CAC {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
      Array.isArray(candidate.commands) &&
      typeof candidate.globalCommand === "object" &&
      candidate.globalCommand !== null &&
      typeof candidate.command === "function" &&
      typeof candidate.parse === "function"
    );
  }

  /**
   * CAC's root instance carries global options (`cli.option(...)`,
   * exposed via `globalCommand`) but no description of its own and no
   * positional arguments - those only exist on individual commands.
   */
  private mapRoot(cli: CAC): CommandContract {
    return {
      name: cli.name,
      description: "",
      aliases: [],
      options: cli.globalCommand.options.map((option) => this.mapOption(option)),
      arguments: [],
      subcommands: cli.commands.map((command) => this.mapCommand(command)),
    };
  }

  /** subcommands is always [] - CAC has no nested sub-subcommand concept to recurse into. */
  private mapCommand(command: CacCommand): CommandContract {
    return {
      name: command.name,
      description: command.description,
      aliases: command.aliasNames,
      options: command.options.map((option) => this.mapOption(option)),
      arguments: command.args.map((arg) => ({
        name: arg.value,
        required: arg.required,
        variadic: arg.variadic,
        // CAC's CommandArg carries no description field - a real
        // framework limitation (positional args are undocumented in
        // CAC's own model), not a mapping gap.
        description: "",
      })),
      subcommands: [],
    };
  }

  private mapOption(option: CacOption): OptionContract {
    return {
      flags: option.rawName,
      name: option.name,
      aliases: option.names
        .filter((name) => name !== option.name)
        .map((name) => this.dashPrefix(name)),
      description: option.description,
      // CAC has no declarative "must be passed" concept - see class doc.
      required: false,
      valueType: this.inferValueType(option),
      // CAC has no per-option variadic declaration (unlike positional
      // args, which do) - a repeated flag collects into an array at
      // parse time regardless of anything declared statically here.
      variadic: false,
      defaultValue: option.config.default ?? null,
    };
  }

  /** `-x` for a single-character name, `--xray` otherwise - CAC's own `.names` carries neither dash. */
  private dashPrefix(name: string): string {
    return name.length === 1 ? `-${name}` : `--${name}`;
  }

  /** `isBoolean` is CAC's own flag for a valueless option; anything else declared a value (`<x>` required or `[x]` optional). */
  private inferValueType(option: CacOption): OptionValueType {
    return option.isBoolean ? "boolean" : "string";
  }
}
