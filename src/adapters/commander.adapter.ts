import { Command, type Option } from "commander";

import type {
  ArgumentContract,
  CommandContract,
  Contract,
  OptionContract,
  OptionValueType,
} from "../core/types";
import type { CliAdapter } from "./adapter.interface";
import { captureConstructions } from "./construction-capture";
import { loadModule } from "./load-module";

/**
 * Commander doesn't expose positional arguments the same way across major
 * versions: v7+ has the public `registeredArguments`, older versions only
 * have the private `_args`. Both hold the same shape at runtime, so we read
 * whichever exists rather than forcing a minimum Commander version.
 */
interface CommanderArgumentLike {
  name(): string;
  required: boolean;
  variadic: boolean;
  description?: string;
}

/**
 * Extracts a Contract from a target file that exports a Commander.js
 * `Command` instance. Never parses --help output - every field comes
 * straight from Commander's own object graph (`.options`, `.commands`,
 * `.registeredArguments`), so a change here can only ever be a mapping bug,
 * never a text-format regression.
 */
export class CommanderAdapter implements CliAdapter {
  readonly id = "commander";

  async extract(entryPath: string): Promise<Contract> {
    const program = await this.loadCommand(entryPath);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.mapCommand(program),
    };
  }

  private async loadCommand(entryPath: string): Promise<Command> {
    // Patched *before* the target loads, so a `new Command()` or
    // `createCommand()` call anywhere in its own top-level code gets
    // captured as a side effect of loadModule() below - even if the
    // target never exports the result anywhere. See
    // construction-capture.ts for why this is safe and what it can't
    // reach.
    const captured = captureConstructions("commander", entryPath, "Command", ["createCommand"]);

    const { viaImport, viaRequire } = await loadModule(entryPath);
    const command =
      this.findCommand(viaImport.moduleExports) ??
      this.findCommand(viaRequire.moduleExports) ??
      this.pickBestCandidate(captured);
    if (command) return command;

    // Neither attempt's exports contained a Command, and nothing was
    // captured during construction either. One load attempt failing on
    // its own is normal and expected (an ESM-only file can't require(),
    // a CJS one may reject a bare import() on an older Node) - the
    // interesting case is when the file simply never loaded at all (a
    // syntax error, a missing dependency inside it), which the generic
    // "no Command instance found" message below would otherwise
    // misrepresent as "loaded fine, wrong export shape." Surface both
    // real reasons so the actual cause - a broken file vs. a genuinely
    // missing export - is never a guess.
    throw new Error(
      `cliguard: no Commander.js Command instance found in "${entryPath}". ` +
        "Export it as `export default program`, `module.exports = program`, " +
        "or a named export (e.g. `export const program = new Command()`). If the file " +
        "builds its Command inside a function that only runs when something calls it " +
        "(never at the top level), point cliguard at a small wrapper file that calls " +
        "that function and exports the result instead - see the README's " +
        '"Entry files that build the CLI lazily" section.\n' +
        `  import() failed: ${viaImport.error ?? "module loaded, but exported no Command instance"}\n` +
        `  require() failed: ${viaRequire.error ?? "module loaded, but exported no Command instance"}`,
    );
  }

  /** Among every Command captured during construction, the one that looks most like the real, fully-built root program - flags on this file's own top-level code sometimes constructing more than one incidentally. */
  private pickBestCandidate(candidates: readonly unknown[]): Command | undefined {
    const valid = candidates.filter((candidate): candidate is Command =>
      this.looksLikeCommand(candidate),
    );
    if (valid.length === 0) return undefined;

    return valid.reduce((best, candidate) =>
      candidate.options.length + candidate.commands.length >
      best.options.length + best.commands.length
        ? candidate
        : best,
    );
  }

  /** Handles `export default`, `module.exports = program`, and named exports. */
  private findCommand(moduleExports: unknown): Command | undefined {
    if (this.looksLikeCommand(moduleExports)) {
      return moduleExports;
    }

    if (moduleExports && typeof moduleExports === "object") {
      const exportsObject = moduleExports as Record<string, unknown>;

      if (this.looksLikeCommand(exportsObject.default)) {
        return exportsObject.default;
      }

      for (const value of Object.values(exportsObject)) {
        if (this.looksLikeCommand(value)) return value;
      }
    }

    return undefined;
  }

  /**
   * Structural check, not `instanceof Command`. The target CLI almost
   * always has its own separate install of `commander` - a different
   * copy than the one this adapter imports, even at the identical
   * version - because `npx cliguard` installs cliguard (and its pinned
   * `commander`) into its own isolated location, unrelated to the target
   * project's `node_modules`. Node gives every resolved copy of a
   * package its own class identity ("dual package hazard"), so
   * `instanceof` fails by construction in that - extremely common - case.
   * Verified against a real external consumer project via `npx cliguard`
   * with its own separate `commander` install, both at a different major
   * version and at the identical version to this package's own
   * `^12.1.0` - `instanceof` failed in both; this doesn't.
   */
  private looksLikeCommand(value: unknown): value is Command {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
      Array.isArray(candidate.options) &&
      Array.isArray(candidate.commands) &&
      typeof candidate.name === "function" &&
      typeof candidate.action === "function" &&
      typeof candidate.opts === "function"
    );
  }

  /** Recurses into `command.commands` so root and every subcommand at any depth go through the same mapping. */
  private mapCommand(command: Command): CommandContract {
    return {
      name: command.name(),
      description: command.description() ?? "",
      aliases: command.aliases(),
      options: command.options.map((option) => this.mapOption(option)),
      arguments: this.mapArguments(command),
      subcommands: command.commands.map((subcommand) => this.mapCommand(subcommand)),
    };
  }

  private mapOption(option: Option): OptionContract {
    return {
      flags: option.flags,
      name: option.name(),
      aliases: option.short ? [option.short] : [],
      description: option.description ?? "",
      required: option.mandatory ?? false,
      valueType: this.inferValueType(option.flags),
      variadic: option.variadic ?? false,
      defaultValue: option.defaultValue ?? null,
    };
  }

  /** `<value>` = required value, `[value]` = optional value, neither = boolean flag. Read from Commander's own flag declaration, not rendered --help text. */
  private inferValueType(flags: string): OptionValueType {
    return flags.includes("<") || flags.includes("[") ? "string" : "boolean";
  }

  private mapArguments(command: Command): ArgumentContract[] {
    const modern = (command as unknown as { registeredArguments?: CommanderArgumentLike[] })
      .registeredArguments;
    const legacy = (command as unknown as { _args?: CommanderArgumentLike[] })._args;
    const args = modern ?? legacy ?? [];

    return args.map((arg) => ({
      name: arg.name(),
      required: arg.required,
      variadic: arg.variadic,
      description: arg.description ?? "",
    }));
  }
}
