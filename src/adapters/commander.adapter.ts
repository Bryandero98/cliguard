import { existsSync } from "fs";
import { resolve } from "path";
import { pathToFileURL } from "url";

import { Command, type Option } from "commander";

import type {
  ArgumentContract,
  CommandContract,
  Contract,
  OptionContract,
  OptionValueType,
} from "../core/types";
import type { CliAdapter } from "./adapter.interface";

/**
 * A genuine dynamic `import()`, immune to TypeScript's own rewriting.
 * This project builds with `module: "commonjs"` (required for the CLI's
 * own require()-based entrypoint), and under that setting tsc rewrites a
 * literal `import()` expression into `Promise.resolve().then(() =>
 * require(...))` - so a plain `import(absolutePath)` below would compile
 * to `require()` in disguise, never a real ESM load, no matter how the
 * source reads. That silently breaks on any target CLI that's genuine
 * ESM with no synchronous CommonJS-compatible form (e.g. one with a
 * top-level `await`) on any Node version that doesn't support requiring
 * an ESM graph. Constructing the function from a string hides the
 * `import()` call from tsc's static analysis, so this is Node's actual
 * dynamic import at runtime.
 */
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

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

  /** Tries `import()` first, then falls back to `require()` for entry points that don't support ESM dynamic import. */
  private async loadCommand(entryPath: string): Promise<Command> {
    // A relative entryPath (as typed on the command line) must resolve
    // against the caller's cwd, not against this file's own location -
    // both import() and require() would otherwise resolve it relative to
    // dist/, silently loading the wrong (or no) file.
    const absolutePath = resolve(process.cwd(), entryPath);

    // Checked up front so the error below can tell "the file doesn't
    // exist" apart from "it exists but doesn't export a Command" - both
    // import() and require() otherwise fail the same opaque way for a
    // missing file, and the generic message ("no Command instance
    // found") reads as if the file loaded fine and just exported the
    // wrong thing, which is actively misleading when it never loaded at
    // all. Exact-path only, by design: entryPath is documented as a path
    // to a specific entry file, not a resolvable module specifier, so
    // this never has to account for extension-less or directory-index
    // resolution.
    if (!existsSync(absolutePath)) {
      throw new Error(`cliguard: no such file: "${absolutePath}".`);
    }

    // Dynamic import() requires a file:// URL for an absolute filesystem
    // path on Windows - a raw "C:\foo\bar.js" parses as a URL with scheme
    // "c:" and throws ERR_UNSUPPORTED_ESM_URL_SCHEME. pathToFileURL is a
    // no-op in effect on POSIX (still produces a valid file:// URL there).
    const viaImport = await this.tryLoad(() => dynamicImport(pathToFileURL(absolutePath).href));
    if (viaImport.command) return viaImport.command;

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fallback for target CLIs that aren't import()-able
    const viaRequire = await this.tryLoad(() => Promise.resolve(require(absolutePath) as unknown));
    if (viaRequire.command) return viaRequire.command;

    // Both attempts failed. One of them failing on its own is normal and
    // expected (an ESM-only file can't require(), a CJS one may reject a
    // bare import() on an older Node) - the interesting case is when the
    // file simply never loaded at all (a syntax error, a missing
    // dependency inside it), which the generic "no Command instance
    // found" message below would otherwise misrepresent as "loaded fine,
    // wrong export shape." Surface both real errors so the actual cause
    // - a broken file vs. a genuinely missing export - is never a guess.
    throw new Error(
      `cliguard: no Commander.js Command instance found in "${entryPath}". ` +
        "Export it as `export default program`, `module.exports = program`, " +
        "or a named export (e.g. `export const program = new Command()`).\n" +
        `  import() failed: ${viaImport.error}\n` +
        `  require() failed: ${viaRequire.error}`,
    );
  }

  private async tryLoad(
    load: () => Promise<unknown>,
  ): Promise<{ command: Command | undefined; error: unknown }> {
    let moduleExports: unknown;
    try {
      moduleExports = await load();
    } catch (error) {
      return { command: undefined, error };
    }
    return {
      command: this.findCommand(moduleExports),
      error: "module loaded, but exported no Command instance",
    };
  }

  /** Handles `export default`, `module.exports = program`, and named exports. */
  private findCommand(moduleExports: unknown): Command | undefined {
    if (moduleExports instanceof Command) {
      return moduleExports;
    }

    if (moduleExports && typeof moduleExports === "object") {
      const exportsObject = moduleExports as Record<string, unknown>;

      if (exportsObject.default instanceof Command) {
        return exportsObject.default;
      }

      for (const value of Object.values(exportsObject)) {
        if (value instanceof Command) return value;
      }
    }

    return undefined;
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
