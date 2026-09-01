import {
  ChangeType,
  type ArgumentContract,
  type CommandContract,
  type Contract,
  type OptionContract,
} from "./types";

export interface DiffResult {
  readonly type: ChangeType;
  /** Where in the command tree the change happened, e.g. "root -> build -> option[--target]". */
  readonly path: string;
  /** Human-readable description of exactly what changed. */
  readonly message: string;
  /** True only for "a command/option/argument was removed" - lets `cliguard deprecate` reclassify exactly this kind of BREAKING change, never any other kind at the same path. */
  readonly removal?: true;
}

interface Named {
  readonly name: string;
}

export interface CompareOptions {
  /**
   * Enables extra rules for changes that are currently silent (no diff
   * entry at all) but can still break an existing caller - today, only a
   * pure reorder of a command's positional arguments (same names, same
   * required/variadic shape, different sequence), which the default,
   * name-indexed comparison can't see since it never looks at position.
   * Off by default so existing callers/CI configs keep today's behavior
   * exactly - this is opt-in stricter enforcement, not a bug fix.
   */
  readonly strict?: boolean;
}

/**
 * Compares two Contracts and returns every difference between them,
 * classified as BREAKING, ADDITIVE, or PATCH. Purely structural: it only
 * ever reads the Contract shape from `core/types.ts`, never a specific
 * adapter, so it works identically regardless of which framework produced
 * either contract. `capturedAt` is intentionally never read.
 */
export class DiffEngine {
  compare(
    oldContract: Contract,
    newContract: Contract,
    options: CompareOptions = {},
  ): DiffResult[] {
    const results: DiffResult[] = [];

    if (oldContract.adapter !== newContract.adapter) {
      results.push({
        type: ChangeType.BREAKING,
        path: "contract",
        message: `Contract adapter changed from "${oldContract.adapter}" to "${newContract.adapter}" - the two snapshots are not comparable.`,
      });
    }

    if (oldContract.contractVersion !== newContract.contractVersion) {
      results.push({
        type: ChangeType.BREAKING,
        path: "contract",
        message: `Contract format version changed from ${oldContract.contractVersion} to ${newContract.contractVersion}.`,
      });
    }

    results.push(...this.compareCommands(oldContract.root, newContract.root, "root", options));

    return results;
  }

  /**
   * Every valid DiffResult.path reachable from a Contract's root - the
   * same path shapes `compareCommands`/`compareOptions`/`compareArguments`
   * build ("root", "root -> build", "root -> build -> option[--target]",
   * "root -> build -> argument[<file>]"). Used by `cliguard deprecate` to
   * validate a path actually exists in the current contract before
   * recording it, without duplicating the path-building logic here.
   */
  collectPaths(contract: Contract): Set<string> {
    const paths = new Set<string>();
    this.walkCommand(contract.root, "root", paths);
    return paths;
  }

  private walkCommand(cmd: CommandContract, path: string, paths: Set<string>): void {
    paths.add(path);
    for (const option of cmd.options) {
      paths.add(`${path} -> option[--${option.name}]`);
    }
    for (const arg of cmd.arguments) {
      paths.add(`${path} -> argument[<${arg.name}>]`);
    }
    for (const sub of cmd.subcommands) {
      this.walkCommand(sub, `${path} -> ${this.commandLabel(sub.name)}`, paths);
    }
  }

  private compareCommands(
    oldCmd: CommandContract,
    newCmd: CommandContract,
    path: string,
    options: CompareOptions,
  ): DiffResult[] {
    const results: DiffResult[] = [];

    if (oldCmd.description !== newCmd.description) {
      results.push({
        type: ChangeType.PATCH,
        path,
        message: `Description changed for command "${this.commandLabel(oldCmd.name)}".`,
      });
    }

    results.push(
      ...this.compareAliases(
        oldCmd.aliases,
        newCmd.aliases,
        path,
        `command "${this.commandLabel(oldCmd.name)}"`,
      ),
    );

    results.push(...this.compareOptions(oldCmd.options, newCmd.options, path));
    results.push(...this.compareArguments(oldCmd.arguments, newCmd.arguments, path, options));
    results.push(...this.compareSubcommands(oldCmd.subcommands, newCmd.subcommands, path, options));

    return results;
  }

  private compareSubcommands(
    oldSubs: readonly CommandContract[],
    newSubs: readonly CommandContract[],
    path: string,
    options: CompareOptions,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const oldByName = this.indexByName(oldSubs);
    const newByName = this.indexByName(newSubs);

    for (const [name, oldSub] of oldByName) {
      const childPath = `${path} -> ${this.commandLabel(name)}`;
      const newSub = newByName.get(name);

      if (!newSub) {
        results.push({
          type: ChangeType.BREAKING,
          path: childPath,
          message: `Command "${this.commandLabel(name)}" was removed.`,
          removal: true,
        });
        continue;
      }

      results.push(...this.compareCommands(oldSub, newSub, childPath, options));
    }

    for (const name of newByName.keys()) {
      if (oldByName.has(name)) continue;
      results.push({
        type: ChangeType.ADDITIVE,
        path: `${path} -> ${this.commandLabel(name)}`,
        message: `Command "${this.commandLabel(name)}" was added.`,
      });
    }

    return results;
  }

  /** CAC's default command (declared with no leading name, e.g. `cli.command("[...files]", ...)`) has name === "" - a blank path segment reads as a typo, not a real command. */
  private commandLabel(name: string): string {
    return name === "" ? "<default>" : name;
  }

  private compareOptions(
    oldOptions: readonly OptionContract[],
    newOptions: readonly OptionContract[],
    path: string,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const oldByName = this.indexByName(oldOptions);
    const newByName = this.indexByName(newOptions);

    for (const [name, oldOption] of oldByName) {
      const optionPath = `${path} -> option[--${name}]`;
      const newOption = newByName.get(name);

      if (!newOption) {
        results.push({
          type: ChangeType.BREAKING,
          path: optionPath,
          message: `Option "--${name}" was removed.`,
          removal: true,
        });
        continue;
      }

      results.push(...this.compareOption(oldOption, newOption, optionPath));
    }

    for (const [name, newOption] of newByName) {
      if (oldByName.has(name)) continue;

      const optionPath = `${path} -> option[--${name}]`;
      if (newOption.required) {
        results.push({
          type: ChangeType.BREAKING,
          path: optionPath,
          message: `New required option "--${name}" was added - existing invocations that don't pass it will now fail.`,
        });
      } else {
        results.push({
          type: ChangeType.ADDITIVE,
          path: optionPath,
          message: `New optional option "--${name}" was added.`,
        });
      }
    }

    return results;
  }

  private compareOption(
    oldOption: OptionContract,
    newOption: OptionContract,
    path: string,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const label = `Option "--${oldOption.name}"`;

    if (!oldOption.required && newOption.required) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} became required - existing invocations that don't pass it will now fail.`,
      });
    } else if (oldOption.required && !newOption.required) {
      results.push({
        type: ChangeType.PATCH,
        path,
        message: `${label} became optional - backward compatible.`,
      });
    }

    if (oldOption.valueType !== newOption.valueType) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} changed value type from "${oldOption.valueType}" to "${newOption.valueType}".`,
      });
    }

    if (oldOption.variadic !== newOption.variadic) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} ${newOption.variadic ? "became variadic" : "stopped being variadic"} - the number of values it accepts changed.`,
      });
    }

    if (!this.deepEqual(oldOption.defaultValue, newOption.defaultValue)) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} default value changed from ${JSON.stringify(oldOption.defaultValue)} to ${JSON.stringify(newOption.defaultValue)}.`,
      });
    }

    results.push(...this.compareAliases(oldOption.aliases, newOption.aliases, path, label));

    if (oldOption.description !== newOption.description) {
      results.push({
        type: ChangeType.PATCH,
        path,
        message: `${label} description changed.`,
      });
    }

    return results;
  }

  private compareArguments(
    oldArgs: readonly ArgumentContract[],
    newArgs: readonly ArgumentContract[],
    path: string,
    options: CompareOptions,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const oldByName = this.indexByName(oldArgs);
    const newByName = this.indexByName(newArgs);

    for (const [name, oldArg] of oldByName) {
      const argPath = `${path} -> argument[<${name}>]`;
      const newArg = newByName.get(name);

      if (!newArg) {
        results.push({
          type: ChangeType.BREAKING,
          path: argPath,
          message: `Argument "<${name}>" was removed.`,
          removal: true,
        });
        continue;
      }

      results.push(...this.compareArgument(oldArg, newArg, argPath));
    }

    for (const [name, newArg] of newByName) {
      if (oldByName.has(name)) continue;

      const argPath = `${path} -> argument[<${name}>]`;
      if (newArg.required) {
        results.push({
          type: ChangeType.BREAKING,
          path: argPath,
          message: `New required argument "<${name}>" was added - existing invocations that don't pass it will now fail.`,
        });
      } else {
        results.push({
          type: ChangeType.ADDITIVE,
          path: argPath,
          message: `New optional argument "<${name}>" was added.`,
        });
      }
    }

    if (options.strict) {
      results.push(...this.compareArgumentOrder(oldArgs, newArgs, path));
    }

    return results;
  }

  /**
   * `--strict`-only: positional arguments are matched by name everywhere
   * above, so a pure reorder (same names, same shape, different sequence)
   * produces no diff at all under the default rules - but position is
   * exactly what a caller passing values positionally relies on, so it's
   * a real, silent break. Only fires when the two argument lists are the
   * same *set* of names (any actual add/remove is already reported by the
   * per-name loop above; this would just be redundant noise on top of it).
   */
  private compareArgumentOrder(
    oldArgs: readonly ArgumentContract[],
    newArgs: readonly ArgumentContract[],
    path: string,
  ): DiffResult[] {
    if (oldArgs.length !== newArgs.length) return [];

    const oldNames = oldArgs.map((arg) => arg.name);
    const newNames = newArgs.map((arg) => arg.name);
    if (oldNames.join(" ") === newNames.join(" ")) return [];

    const sameSet =
      new Set(oldNames).size === new Set(newNames).size &&
      oldNames.every((name) => newNames.includes(name));
    if (!sameSet) return [];

    return [
      {
        type: ChangeType.BREAKING,
        path,
        message:
          `[strict] Argument order changed: was <${oldNames.join(">, <")}>, ` +
          `now <${newNames.join(">, <")}>. Existing positional invocations may now bind values to the wrong argument.`,
      },
    ];
  }

  private compareArgument(
    oldArg: ArgumentContract,
    newArg: ArgumentContract,
    path: string,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const label = `Argument "<${oldArg.name}>"`;

    if (!oldArg.required && newArg.required) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} became required - existing invocations that don't pass it will now fail.`,
      });
    } else if (oldArg.required && !newArg.required) {
      results.push({
        type: ChangeType.PATCH,
        path,
        message: `${label} became optional - backward compatible.`,
      });
    }

    if (oldArg.variadic !== newArg.variadic) {
      results.push({
        type: ChangeType.BREAKING,
        path,
        message: `${label} ${newArg.variadic ? "became variadic" : "stopped being variadic"} - the number of values it accepts changed.`,
      });
    }

    if (oldArg.description !== newArg.description) {
      results.push({
        type: ChangeType.PATCH,
        path,
        message: `${label} description changed.`,
      });
    }

    return results;
  }

  /** Shared by command aliases and option aliases - the rules are identical for both. */
  private compareAliases(
    oldAliases: readonly string[],
    newAliases: readonly string[],
    path: string,
    label: string,
  ): DiffResult[] {
    const results: DiffResult[] = [];
    const oldSet = new Set(oldAliases);
    const newSet = new Set(newAliases);

    for (const alias of oldSet) {
      if (!newSet.has(alias)) {
        results.push({
          type: ChangeType.BREAKING,
          path,
          message: `Alias "${alias}" was removed from ${label}.`,
        });
      }
    }

    for (const alias of newSet) {
      if (!oldSet.has(alias)) {
        results.push({
          type: ChangeType.PATCH,
          path,
          message: `Alias "${alias}" was added to ${label}.`,
        });
      }
    }

    return results;
  }

  private indexByName<T extends Named>(items: readonly T[]): Map<string, T> {
    return new Map(items.map((item) => [item.name, item]));
  }

  /** Deliberately simple: option/argument defaults are JSON-serializable primitives or arrays, never objects where key order would matter. */
  private deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
