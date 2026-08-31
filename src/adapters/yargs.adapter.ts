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

/**
 * The slice of yargs's own (semi-public, but real and stable since 15.x)
 * `getInternalMethods()`/`getOptions()` surface this adapter reads. Yargs
 * ships no `.d.ts` for `getInternalMethods()` itself, so this is typed by
 * hand against the actual runtime shape - verified against yargs 17.7.3's
 * own source (`yargs-factory.js`, `command.js`), not guessed.
 */
interface YargsOptions {
  readonly boolean: readonly string[];
  readonly string: readonly string[];
  readonly array: readonly string[];
  readonly number: readonly string[];
  readonly alias: Readonly<Record<string, readonly string[]>>;
  readonly default: Readonly<Record<string, unknown>>;
  readonly demandedOptions: Readonly<Record<string, unknown>>;
}

interface YargsPositional {
  readonly cmd: readonly [string];
  readonly variadic: boolean;
}

interface YargsCommandHandler {
  readonly description: string | false;
  readonly builder:
    ((yargs: YargsInstance, helpOrVersionSet: boolean) => unknown) | Record<string, unknown>;
  readonly demanded: readonly YargsPositional[];
  readonly optional: readonly YargsPositional[];
}

interface YargsCommandInstance {
  readonly handlers: Readonly<Record<string, YargsCommandHandler>>;
  readonly aliasMap: Readonly<Record<string, string>>;
}

interface YargsUsageInstance {
  getDescriptions(): Readonly<Record<string, string>>;
}

interface YargsInternalMethods {
  getCommandInstance(): YargsCommandInstance;
  getUsageInstance(): YargsUsageInstance;
}

interface YargsInstance {
  readonly $0: string;
  getOptions(): YargsOptions;
  getInternalMethods(): YargsInternalMethods;
  exitProcess(enabled: boolean): YargsInstance;
  fail(fn: (msg: string, err: Error) => void): YargsInstance;
  option(key: string, config: unknown): YargsInstance;
  options(config: Record<string, unknown>): YargsInstance;
}

type YargsFactory = (args: readonly string[]) => YargsInstance;

const YARGS_STRING_MARKER = "__yargsString__:";

/**
 * Extracts a Contract from a target file that builds a yargs CLI. Never
 * parses --help output - every field comes straight from yargs's own
 * `getOptions()`/`getInternalMethods()` object graph, matching
 * CommanderAdapter/CacAdapter's approach.
 *
 * Yargs has no per-command object tree the way Commander does - every
 * `.option()` call (wherever it happens) mutates one shared options bag on
 * the instance, and a command's own options only get registered when its
 * `builder` function actually runs (normally deferred until that command
 * matches at real parse time). To read a command's options in isolation,
 * this adapter calls each command's `builder` against a **fresh, empty**
 * yargs instance rather than the shared one - the same thing yargs itself
 * does internally via `getInternalMethods().reset()` before running a
 * command's builder (verified in yargs's own `command.js`), just without
 * needing yargs to have actually matched and parsed real argv first.
 */
export class YargsAdapter implements CliAdapter {
  readonly id = "yargs";

  async extract(entryPath: string): Promise<Contract> {
    const cli = await this.loadYargs(entryPath);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.mapRoot(cli),
    };
  }

  private async loadYargs(entryPath: string): Promise<YargsInstance> {
    // Patched *before* the target loads, so a `yargs(args)` or
    // `require("yargs/yargs")(args)` call anywhere in its own top-level
    // code gets captured as a side effect of loadModule() below - even if
    // the target never exports the result anywhere. See
    // captureYargsFactoryCalls's own doc for why this is safe.
    const captured = this.captureYargsFactoryCalls(entryPath);

    const { viaImport, viaRequire } = await loadModule(entryPath);
    const cli =
      this.findYargs(viaImport.moduleExports) ??
      this.findYargs(viaRequire.moduleExports) ??
      this.pickBestCandidate(captured);
    if (cli) return cli;

    // See CommanderAdapter's identical block for why both real load
    // errors - not a swallowed, generic guess - matter here.
    throw new Error(
      `cliguard: no yargs instance found in "${entryPath}". ` +
        "Export it as `export default cli`, `module.exports = cli`, " +
        "or a named export (e.g. `export const cli = yargs(hideBin(process.argv))`). If " +
        "the file builds its yargs instance inside a function that only runs when " +
        "something calls it (never at the top level), point cliguard at a small wrapper " +
        "file that calls that function and exports the result instead - see the README's " +
        '"Entry files that build the CLI lazily" section.\n' +
        `  import() failed: ${viaImport.error ?? "module loaded, but exported no yargs instance"}\n` +
        `  require() failed: ${viaRequire.error ?? "module loaded, but exported no yargs instance"}`,
    );
  }

  /**
   * Captures every instance produced by calling `require("yargs")` or
   * `require("yargs/yargs")` as a function, from the target's own
   * resolved copy of the package - real CLIs almost always reach yargs
   * through one of these two calls (`yargs(hideBin(process.argv))` or
   * `require("yargs/yargs")(args)`), usually without ever exporting the
   * result.
   *
   * Unlike commander/cac's `captureConstructions` (which patches a
   * *named property* on the required module, since `Command`/`cac` are
   * named exports), yargs's own package export *is itself* the callable
   * factory - `require("yargs")` returns a function directly, not a
   * container object with a factory property on it. So this replaces the
   * entire cached module's `.exports` with a `Proxy` around that
   * function, trapping `apply` instead of `construct`: the proxy is
   * still callable exactly like the original (and forwards every other
   * property read/write straight through, since no `get`/`set` trap is
   * defined - which is what makes `require("yargs")`'s other form, using
   * it directly as a pre-built singleton instance without ever calling
   * it, keep working unmodified). `require("yargs")` and
   * `require("yargs/yargs")` resolve to two different files
   * (`index.cjs` vs `yargs.cjs`), so both are patched independently -
   * whichever the target actually uses is the one that ever fires.
   */
  private captureYargsFactoryCalls(entryPath: string): unknown[] {
    const captured: unknown[] = [];
    const record = (instance: unknown): void => {
      if (instance && typeof instance === "object") captured.push(instance);
    };

    const targetDir = dirname(resolve(process.cwd(), entryPath));
    for (const packageName of ["yargs", "yargs/yargs"]) {
      let resolvedPath: string;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- resolving the target's own copy of a CJS package, not a static dependency of this file
        resolvedPath = require.resolve(packageName, { paths: [targetDir] });
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- ensures the module is loaded into require.cache before this patches it
        require(resolvedPath);
      } catch {
        // Not resolvable from the target's own location (e.g. the target
        // only uses one of the two import styles) - nothing to patch.
        continue;
      }

      const cacheEntry = require.cache[resolvedPath];
      const original = cacheEntry?.exports as unknown;
      if (!cacheEntry || typeof original !== "function") continue;

      cacheEntry.exports = new Proxy(original as (...args: unknown[]) => unknown, {
        apply(target, thisArg, args): unknown {
          const instance = Reflect.apply(target, thisArg, args);
          record(instance);
          return instance;
        },
      });
    }

    return captured;
  }

  /** Among every instance captured during construction, the one that looks most like the real, fully-built root program. */
  private pickBestCandidate(candidates: readonly unknown[]): YargsInstance | undefined {
    const valid = candidates.filter((candidate): candidate is YargsInstance =>
      this.looksLikeYargs(candidate),
    );
    if (valid.length === 0) return undefined;

    return valid.reduce((best, candidate) =>
      this.score(candidate) > this.score(best) ? candidate : best,
    );
  }

  private score(instance: YargsInstance): number {
    const options = instance.getOptions();
    const handlerCount = Object.keys(
      instance.getInternalMethods().getCommandInstance().handlers,
    ).length;
    return (
      handlerCount +
      options.boolean.length +
      options.string.length +
      options.array.length +
      options.number.length
    );
  }

  /** Handles `export default`, `module.exports = cli`, and named exports. */
  private findYargs(moduleExports: unknown): YargsInstance | undefined {
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

  /**
   * Structural check, not `instanceof` - see CommanderAdapter's
   * identical-purpose `looksLikeCommand` for why (the target's own
   * `yargs` install is almost always a separate copy from cliguard's).
   * `getInternalMethods` is fairly distinctive to yargs among CLI
   * frameworks, so it's included alongside the more generic
   * `command`/`option`/`getOptions` to keep this from ever
   * false-matching a Commander or CAC instance.
   */
  private looksLikeYargs(value: unknown): value is YargsInstance {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.command === "function" &&
      typeof candidate.option === "function" &&
      typeof candidate.getOptions === "function" &&
      typeof candidate.getInternalMethods === "function"
    );
  }

  private mapRoot(cli: YargsInstance): CommandContract {
    const commandInstance = cli.getInternalMethods().getCommandInstance();
    const options = cli.getOptions();
    const descriptions = cli.getInternalMethods().getUsageInstance().getDescriptions();

    return {
      name: cli.$0,
      description: "",
      aliases: [],
      options: this.mapOptions(options, descriptions, new Set()),
      arguments: [],
      subcommands: Object.entries(commandInstance.handlers).map(([name, handler]) =>
        this.mapCommand(name, handler, commandInstance.aliasMap),
      ),
    };
  }

  /**
   * Runs `handler.builder` against a fresh, empty yargs instance rather
   * than the shared one the target built - see this class's own doc
   * comment for why. A side effect worth calling out: every fresh
   * instance auto-registers its own `help`/`version` options (yargs's
   * own default, not something this specific command declared), so
   * those two names are always excluded below - matching
   * CommanderAdapter/CacAdapter, neither of which surfaces their
   * framework's built-in help/version as a regular option either.
   */
  private mapCommand(
    name: string,
    handler: YargsCommandHandler,
    parentAliasMap: Readonly<Record<string, string>>,
  ): CommandContract {
    const scoped = this.freshInstance();

    if (typeof handler.builder === "function") {
      handler.builder(scoped, false);
    } else if (handler.builder && typeof handler.builder === "object") {
      scoped.options(handler.builder);
    }

    const commandInstance = scoped.getInternalMethods().getCommandInstance();
    const options = scoped.getOptions();
    const descriptions = scoped.getInternalMethods().getUsageInstance().getDescriptions();
    const positionals = [...handler.demanded, ...handler.optional];
    const positionalNames = new Set(positionals.map((positional) => positional.cmd[0]));

    return {
      name,
      description: handler.description || "",
      aliases: Object.entries(parentAliasMap)
        .filter(([, canonical]) => canonical === name)
        .map(([alias]) => alias),
      options: this.mapOptions(options, descriptions, positionalNames),
      arguments: this.mapArguments(handler, descriptions),
      subcommands: Object.entries(commandInstance.handlers).map(([subName, subHandler]) =>
        this.mapCommand(subName, subHandler, commandInstance.aliasMap),
      ),
    };
  }

  private freshInstance(): YargsInstance {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- cliguard's own pinned copy, deliberately separate from the target's - this instance never touches the target's code, it's purely scratch space for reading one command's own builder output in isolation
    const factory = require("yargs/yargs") as YargsFactory;
    return factory([])
      .exitProcess(false)
      .fail(() => undefined);
  }

  private mapArguments(
    handler: YargsCommandHandler,
    descriptions: Readonly<Record<string, string>>,
  ): ArgumentContract[] {
    const required = handler.demanded.map((positional) => ({ positional, required: true }));
    const optional = handler.optional.map((positional) => ({ positional, required: false }));

    return [...required, ...optional].map(({ positional, required: isRequired }) => ({
      name: positional.cmd[0],
      required: isRequired,
      variadic: positional.variadic,
      description: this.describe(descriptions, positional.cmd[0]),
    }));
  }

  /**
   * Yargs stores an option's own name as a real entry in `options.string`
   * / `options.boolean` *and* separately re-registers every alias as its
   * own addressable entry in the same arrays (so `-o` shows up next to
   * `output`, not just inside `output`'s own alias list) - excluded here
   * via `aliasTargets` so each alias surfaces exactly once, nested under
   * its canonical option, matching CommanderAdapter/CacAdapter's shape.
   * Positional names go through this same shared bag too (`.positional()`
   * is implemented in terms of the same option-registration machinery
   * internally) - excluded via `positionalNames` so they surface only in
   * `arguments`, never duplicated into `options`.
   */
  private mapOptions(
    options: YargsOptions,
    descriptions: Readonly<Record<string, string>>,
    positionalNames: ReadonlySet<string>,
  ): OptionContract[] {
    const aliasTargets = new Set(Object.values(options.alias).flat());
    const allNames = new Set([
      ...options.boolean,
      ...options.string,
      ...options.array,
      ...options.number,
    ]);

    return [...allNames]
      .filter((name) => name !== "help" && name !== "version")
      .filter((name) => !positionalNames.has(name))
      .filter((name) => !aliasTargets.has(name))
      .map((name) => ({
        flags: [
          `--${name}`,
          ...(options.alias[name] ?? []).map((alias) => this.dashPrefix(alias)),
        ].join(", "),
        name,
        aliases: (options.alias[name] ?? []).map((alias) => this.dashPrefix(alias)),
        description: this.describe(descriptions, name),
        required: name in options.demandedOptions,
        valueType: this.inferValueType(options, name),
        variadic: options.array.includes(name),
        defaultValue: name in options.default ? options.default[name] : null,
      }));
  }

  private describe(descriptions: Readonly<Record<string, string>>, name: string): string {
    const raw = descriptions[name] ?? "";
    return raw.startsWith(YARGS_STRING_MARKER) ? raw.slice(YARGS_STRING_MARKER.length) : raw;
  }

  /** `-x` for a single-character name, `--xray` otherwise - yargs's own alias lists carry neither dash. */
  private dashPrefix(name: string): string {
    return name.length === 1 ? `-${name}` : `--${name}`;
  }

  /** Everything not declared `boolean`/`array`/`number` defaults to yargs's own "string" bucket - collapsed to this Contract's two-value OptionValueType the same way CacAdapter does. */
  private inferValueType(options: YargsOptions, name: string): OptionValueType {
    return options.boolean.includes(name) ? "boolean" : "string";
  }
}
