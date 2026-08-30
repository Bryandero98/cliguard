import { dirname, resolve } from "path";

import type {
  ArgumentContract,
  CommandContract,
  Contract,
  OptionContract,
  OptionValueType,
} from "../core/types";
import type { CliAdapter } from "./adapter.interface";
import { loadModule } from "./load-module";

interface YargsOptions {
  readonly key?: Record<string, boolean>;
  readonly alias?: Record<string, readonly string[]>;
  readonly default?: Record<string, unknown>;
  readonly demandedOptions?: Record<string, unknown>;
  readonly boolean?: readonly string[];
  readonly array?: readonly string[];
  readonly count?: readonly string[];
  readonly hiddenOptions?: readonly string[];
}

interface YargsUsageInstance {
  getDescriptions(): Record<string, string | undefined>;
}

interface YargsInternalMethods {
  getCommandInstance(): YargsCommandInstance;
  getUsageInstance(): YargsUsageInstance;
}

interface YargsLike {
  readonly $0?: string;
  getOptions(): YargsOptions;
  getInternalMethods(): YargsInternalMethods;
  command(...args: unknown[]): YargsLike;
  options(options: Record<string, unknown>): YargsLike;
  scriptName(name: string): YargsLike;
  parse(...args: unknown[]): unknown;
}

interface YargsCommandInstance {
  readonly handlers?: Record<string, YargsCommandHandler>;
  readonly aliasMap?: Record<string, string>;
}

interface YargsCommandHandler {
  readonly original: string;
  readonly description?: string | false;
  readonly builder?: YargsBuilder;
  readonly demanded?: readonly YargsPositional[];
  readonly optional?: readonly YargsPositional[];
}

type YargsBuilder = ((yargs: YargsLike) => unknown) | Record<string, unknown>;

interface YargsPositional {
  readonly cmd?: readonly string[];
  readonly variadic?: boolean;
}

type YargsFactory = (args?: readonly string[]) => YargsLike;

/**
 * Extracts a Contract from a target file that exports a Yargs instance.
 * Like the other adapters, this reads Yargs' command/options graph through
 * its own runtime objects and never parses rendered help text.
 */
export class YargsAdapter implements CliAdapter {
  readonly id = "yargs";

  async extract(entryPath: string): Promise<Contract> {
    const cli = await this.loadYargs(entryPath);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.mapRoot(cli, entryPath),
    };
  }

  private async loadYargs(entryPath: string): Promise<YargsLike> {
    const captured = this.captureYargsConstructions(entryPath);

    const { viaImport, viaRequire } = await loadModule(entryPath);
    const cli =
      this.findYargs(viaImport.moduleExports) ??
      this.findYargs(viaRequire.moduleExports) ??
      this.pickBestCandidate(captured);
    if (cli) return cli;

    throw new Error(
      `cliguard: no Yargs instance found in "${entryPath}". ` +
        "Export it as `export default cli`, `module.exports = cli`, " +
        "or a named export (e.g. `export const cli = yargs([])`). If the file builds its " +
        "Yargs instance inside a function that only runs when something calls it (never " +
        "at the top level), point cliguard at a small wrapper file that calls that " +
        "function and exports the result instead - see the README's \"Entry files that " +
        'build the CLI lazily" section.\n' +
        `  import() failed: ${viaImport.error ?? "module loaded, but exported no Yargs instance"}\n` +
        `  require() failed: ${viaRequire.error ?? "module loaded, but exported no Yargs instance"}`,
    );
  }

  private findYargs(moduleExports: unknown): YargsLike | undefined {
    if (this.looksLikeYargs(moduleExports)) {
      return moduleExports;
    }

    if (moduleExports && typeof moduleExports === "object") {
      const exportsObject = moduleExports as Record<string, unknown>;

      if (this.looksLikeYargs(exportsObject.default)) {
        return exportsObject.default;
      }

      for (const value of Object.values(exportsObject)) {
        if (this.looksLikeYargs(value)) return value;
      }
    }

    return undefined;
  }

  private looksLikeYargs(value: unknown): value is YargsLike {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.getOptions === "function" &&
      typeof candidate.getInternalMethods === "function" &&
      typeof candidate.command === "function" &&
      typeof candidate.parse === "function"
    );
  }

  private pickBestCandidate(candidates: readonly unknown[]): YargsLike | undefined {
    const valid = candidates
      .filter((candidate): candidate is YargsLike => this.looksLikeYargs(candidate))
      .filter((candidate) => this.scoreYargs(candidate) > 0);
    if (valid.length === 0) return undefined;

    return valid.reduce((best, candidate) =>
      this.scoreYargs(candidate) > this.scoreYargs(best) ? candidate : best,
    );
  }

  private scoreYargs(cli: YargsLike): number {
    return this.commandHandlers(cli).length + this.optionNames(cli.getOptions(), new Set()).length;
  }

  private captureYargsConstructions(entryPath: string): unknown[] {
    const captured: unknown[] = [];
    this.patchYargsSingleton(entryPath, captured);
    this.patchYargsFactory(entryPath, captured);
    return captured;
  }

  private patchYargsSingleton(entryPath: string, captured: unknown[]): void {
    let resolvedPath: string;
    let realSingleton: unknown;
    try {
      const targetDir = dirname(resolve(process.cwd(), entryPath));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolves the target project's own optional peer dependency
      resolvedPath = require.resolve("yargs", { paths: [targetDir] });
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- preloads the singleton so the target receives this patched export
      realSingleton = require(resolvedPath) as unknown;
    } catch {
      return;
    }

    const record = (): void => {
      if (!captured.includes(realSingleton)) captured.push(realSingleton);
    };
    const proxied = new Proxy(realSingleton as object, {
      get(target, prop, receiver) {
        if (prop === "argv" || prop === "parse" || prop === "scriptName" || prop === "command") {
          record();
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
      apply(target, thisArg, args) {
        record();
        return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
      },
    });

    const cachedModule = require.cache[resolvedPath];
    if (cachedModule) cachedModule.exports = proxied;
  }

  private patchYargsFactory(entryPath: string, captured: unknown[]): void {
    let resolvedPath: string;
    let realFactory: unknown;
    try {
      const targetDir = dirname(resolve(process.cwd(), entryPath));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolves the target project's own optional peer dependency
      resolvedPath = require.resolve("yargs/yargs", { paths: [targetDir] });
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- patching the target-resolved CJS factory for construction capture
      realFactory = require(resolvedPath) as unknown;
    } catch {
      return;
    }

    if (typeof realFactory !== "function") return;

    const wrappedFactory = ((...args: unknown[]) => {
      const instance = (realFactory as (...a: unknown[]) => unknown)(...args);
      if (instance && typeof instance === "object") captured.push(instance);
      return instance;
    }) as YargsFactory & Record<string, unknown>;

    Object.assign(wrappedFactory, realFactory);
    const cachedModule = require.cache[resolvedPath];
    if (cachedModule) cachedModule.exports = wrappedFactory;
  }

  private mapRoot(cli: YargsLike, entryPath: string): CommandContract {
    const defaultCommand = this.defaultCommand(cli);
    const rootArgs = defaultCommand ? this.mapArguments(defaultCommand, cli) : [];

    return {
      name: cli.$0 ?? "",
      description: this.description(defaultCommand?.description),
      aliases: [],
      options: this.mapOptions(cli, new Set(rootArgs.map((arg) => arg.name))),
      arguments: rootArgs,
      subcommands: this.commandHandlers(cli).map(([name, command]) =>
        this.mapCommand(name, command, cli, entryPath),
      ),
    };
  }

  private mapCommand(
    name: string,
    command: YargsCommandHandler,
    parent: YargsLike,
    entryPath: string,
  ): CommandContract {
    const child = this.buildChildYargs(command, entryPath);
    const args = this.mapArguments(command, child);

    return {
      name,
      description: this.description(command.description),
      aliases: this.commandAliases(parent, name),
      options: this.mapOptions(child, new Set(args.map((arg) => arg.name))),
      arguments: args,
      subcommands: this.commandHandlers(child).map(([childName, childCommand]) =>
        this.mapCommand(childName, childCommand, child, entryPath),
      ),
    };
  }

  private buildChildYargs(command: YargsCommandHandler, entryPath: string): YargsLike {
    const child = this.createYargs(entryPath);
    const { builder } = command;

    if (typeof builder === "function") {
      const built = builder(child);
      return this.looksLikeYargs(built) ? built : child;
    }

    if (builder && typeof builder === "object") {
      child.options(builder);
    }

    return child;
  }

  private createYargs(entryPath: string): YargsLike {
    const targetDir = dirname(resolve(process.cwd(), entryPath));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- creates a child parser from the target project's yargs version
    const factory = require(require.resolve("yargs/yargs", { paths: [targetDir] })) as YargsFactory;
    return factory([]).scriptName("");
  }

  private defaultCommand(cli: YargsLike): YargsCommandHandler | undefined {
    return cli.getInternalMethods().getCommandInstance().handlers?.$0;
  }

  private commandHandlers(cli: YargsLike): Array<[string, YargsCommandHandler]> {
    const command = cli.getInternalMethods().getCommandInstance();
    return Object.entries(command.handlers ?? {}).filter(([name]) => name !== "$0");
  }

  private commandAliases(cli: YargsLike, commandName: string): string[] {
    const aliasMap = cli.getInternalMethods().getCommandInstance().aliasMap ?? {};
    return Object.entries(aliasMap)
      .filter(([, target]) => target === commandName)
      .map(([alias]) => alias);
  }

  private mapArguments(command: YargsCommandHandler, cli: YargsLike): ArgumentContract[] {
    const descriptions = cli.getInternalMethods().getUsageInstance().getDescriptions();
    const demanded = command.demanded ?? [];
    const optional = command.optional ?? [];

    return [
      ...demanded.map((arg) => this.mapArgument(arg, true, descriptions)),
      ...optional.map((arg) => this.mapArgument(arg, false, descriptions)),
    ];
  }

  private mapArgument(
    arg: YargsPositional,
    required: boolean,
    descriptions: Record<string, string | undefined>,
  ): ArgumentContract {
    const name = arg.cmd?.[0] ?? "";

    return {
      name,
      required,
      variadic: arg.variadic ?? false,
      description: this.description(descriptions[name]),
    };
  }

  private mapOptions(cli: YargsLike, argumentNames: ReadonlySet<string>): OptionContract[] {
    const options = cli.getOptions();
    const descriptions = cli.getInternalMethods().getUsageInstance().getDescriptions();

    return this.optionNames(options, argumentNames).map((name) => ({
      flags: this.optionFlags(name, options),
      name,
      aliases: (options.alias?.[name] ?? []).map((alias) => this.dashPrefix(alias)),
      description: this.description(descriptions[name]),
      required: Object.prototype.hasOwnProperty.call(options.demandedOptions ?? {}, name),
      valueType: this.optionValueType(name, options),
      variadic: this.optionMatches(name, options, options.array ?? []),
      defaultValue: options.default?.[name] ?? null,
    }));
  }

  private optionNames(options: YargsOptions, argumentNames: ReadonlySet<string>): string[] {
    const aliases = new Set(Object.values(options.alias ?? {}).flat());
    const hidden = new Set(options.hiddenOptions ?? []);
    return Object.keys(options.key ?? {})
      .filter((name) => !aliases.has(name))
      .filter((name) => !argumentNames.has(name))
      .filter((name) => name !== "help" && name !== "version")
      .filter((name) => !hidden.has(name));
  }

  private optionFlags(name: string, options: YargsOptions): string {
    const names = [
      ...(options.alias?.[name] ?? []).map((alias) => this.dashPrefix(alias)),
      `--${name}`,
    ];
    return this.optionValueType(name, options) === "boolean"
      ? names.join(", ")
      : `${names.join(", ")} <value>`;
  }

  private optionValueType(name: string, options: YargsOptions): OptionValueType {
    return this.optionMatches(name, options, [...(options.boolean ?? []), ...(options.count ?? [])])
      ? "boolean"
      : "string";
  }

  private optionMatches(
    name: string,
    options: YargsOptions,
    candidates: readonly string[],
  ): boolean {
    const names = [name, ...(options.alias?.[name] ?? [])];
    return names.some((candidate) => candidates.includes(candidate));
  }

  private dashPrefix(name: string): string {
    return name.length === 1 ? `-${name}` : `--${name}`;
  }

  private description(value: string | false | undefined): string {
    return typeof value === "string" ? value.replace(/^__yargsString__:/, "") : "";
  }
}
