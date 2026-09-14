import { spawnSync } from "child_process";
import { existsSync, statSync } from "fs";
import { dirname, extname, resolve } from "path";

import type {
  ArgumentContract,
  CommandContract,
  Contract,
  OptionContract,
  OptionValueType,
} from "../core/types";
import type { CliAdapter } from "./adapter.interface";

/** The dump subcommand every Cobra target CLI must expose - see examples/cobra-dump/clidump/dump.go. */
const DUMP_SUBCOMMAND = "__cliguard_dump__";

interface CobraFlagJson {
  readonly name: string;
  readonly shorthand: string;
  readonly usage: string;
  readonly defValue: string;
  /** pflag's own `Value.Type()`, e.g. "string", "bool", "stringSlice". */
  readonly valueType: string;
  readonly required: boolean;
}

interface CobraCommandJson {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly short: string;
  readonly flags: readonly CobraFlagJson[];
  readonly subcommands: readonly CobraCommandJson[];
}

/**
 * **Proof of concept, not a shipped integration** - see issue #9. Unlike
 * every other adapter, cliguard can't `require()`/`import()` a compiled Go
 * binary into Node, so a Cobra CLI has to expose its own command tree
 * itself: a hidden `__cliguard_dump__` subcommand
 * (examples/cobra-dump/clidump/dump.go's `NewDumpCommand`) prints it as
 * JSON on stdout, and this adapter runs that subcommand as a subprocess
 * and parses the output - no different in spirit from how ClickAdapter
 * already shells out to a real Python interpreter instead of introspecting
 * in-process.
 *
 * A real `cliguard-go` package doesn't exist yet (see the issue) - the
 * target CLI's own author would today have to vendor a copy of
 * examples/cobra-dump/clidump/dump.go directly and wire in
 * `rootCmd.AddCommand(clidump.NewDumpCommand(rootCmd))` themselves. This
 * adapter only proves the rest of the pattern (subprocess -> JSON ->
 * Contract) actually works end to end against a real Cobra CLI.
 *
 * `entryPath` is either:
 * - a compiled Cobra binary - run directly as `<entryPath> __cliguard_dump__`.
 * - a `.go` file or a directory - run via `go run . __cliguard_dump__`
 *   (requires a `go` toolchain on PATH), which is how the example CLI
 *   under examples/cobra-dump is exercised without a separate build step.
 */
export class CobraAdapter implements CliAdapter {
  readonly id = "cobra";
  readonly limitations: readonly string[] = [
    "Proof of concept (see issue #9): there is no published `cliguard-go` package yet - the target CLI's own author must vendor an equivalent of examples/cobra-dump/clidump/dump.go and wire in `rootCmd.AddCommand(clidump.NewDumpCommand(rootCmd))` themselves, unlike every other adapter which needs zero changes to the target (Click included).",
    "ArgumentContract is always [] - Cobra's Args validators (cobra.ExactArgs(1), cobra.MinimumNArgs(1), ...) carry no per-argument name or description, unlike Commander's .argument('<file>', ...).",
    "CommandContract.description comes from Cobra's Short text only - Long is never read.",
    'OptionContract.valueType collapses every pflag type (string, int, stringSlice, ...) to "boolean" vs "string", the same simplification CacAdapter/YargsAdapter/ClickAdapter already make.',
    "defaultValue is parsed from pflag's own DefValue string representation - correct for primitives and slices, but a flag whose default is itself a JSON-looking string could round-trip wrong.",
    "A .go entry is run via `go run . <dump-subcommand>`, requiring a `go` toolchain on PATH - a compiled binary entry has no such requirement, matching how a real published cliguard-go integration would be used.",
  ];

  async extract(entryPath: string): Promise<Contract> {
    const absolutePath = resolve(process.cwd(), entryPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`cliguard: no such file or directory: "${absolutePath}".`);
    }

    const json = this.runDump(absolutePath);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.mapCommand(json),
    };
  }

  private runDump(absolutePath: string): CobraCommandJson {
    const isDirectory = statSync(absolutePath).isDirectory();
    const isGoSource = isDirectory || extname(absolutePath) === ".go";

    const result = isGoSource
      ? spawnSync("go", ["run", ".", DUMP_SUBCOMMAND], {
          cwd: isDirectory ? absolutePath : dirname(absolutePath),
          encoding: "utf8",
        })
      : spawnSync(absolutePath, [DUMP_SUBCOMMAND], { encoding: "utf8" });

    if (result.error) {
      throw new Error(
        `cliguard: failed to run the Cobra target at "${absolutePath}": ${result.error.message}` +
          (isGoSource ? ' - is a Go toolchain ("go") installed and on PATH?' : ""),
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `cliguard: the Cobra target at "${absolutePath}" exited with code ${result.status} ` +
          `running "${DUMP_SUBCOMMAND}" - does it call rootCmd.AddCommand(clidump.NewDumpCommand(rootCmd))? ` +
          `(see examples/cobra-dump)\n${result.stderr.trim()}`,
      );
    }
    try {
      return JSON.parse(result.stdout) as CobraCommandJson;
    } catch {
      throw new Error(
        `cliguard: internal error - the Cobra dump command's output wasn't valid JSON:\n${result.stdout}`,
      );
    }
  }

  private mapCommand(json: CobraCommandJson): CommandContract {
    return {
      name: json.name,
      description: json.short,
      aliases: json.aliases,
      options: json.flags.map((flag) => this.mapOption(flag)),
      // See class limitations: Cobra's Args validators carry no per-argument metadata.
      arguments: [] as readonly ArgumentContract[],
      subcommands: json.subcommands.map((sub) => this.mapCommand(sub)),
    };
  }

  private mapOption(flag: CobraFlagJson): OptionContract {
    const valueType: OptionValueType = flag.valueType === "bool" ? "boolean" : "string";
    const isBoolean = valueType === "boolean";
    const flags =
      (flag.shorthand ? `-${flag.shorthand}, ` : "") +
      `--${flag.name}` +
      (isBoolean ? "" : ` <${flag.name}>`);

    return {
      flags,
      name: flag.name,
      aliases: flag.shorthand ? [`-${flag.shorthand}`] : [],
      description: flag.usage,
      required: flag.required,
      valueType,
      variadic: /slice|array/i.test(flag.valueType),
      defaultValue: this.parseDefault(flag.defValue, valueType),
    };
  }

  private parseDefault(raw: string, valueType: OptionValueType): unknown {
    if (raw === "") return null;
    if (valueType === "boolean") return raw === "true";
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
