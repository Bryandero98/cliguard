import { resolve } from "path";

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

    const viaImport = await this.tryLoad(() => import(absolutePath));
    if (viaImport) return viaImport;

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate fallback for target CLIs that aren't import()-able
    const viaRequire = await this.tryLoad(() => Promise.resolve(require(absolutePath) as unknown));
    if (viaRequire) return viaRequire;

    throw new Error(
      `cliguard: no Commander.js Command instance found in "${entryPath}". ` +
        "Export it as `export default program`, `module.exports = program`, " +
        "or a named export (e.g. `export const program = new Command()`).",
    );
  }

  private async tryLoad(load: () => Promise<unknown>): Promise<Command | undefined> {
    let moduleExports: unknown;
    try {
      moduleExports = await load();
    } catch {
      return undefined;
    }
    return this.findCommand(moduleExports);
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
