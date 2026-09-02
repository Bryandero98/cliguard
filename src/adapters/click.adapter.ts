import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

import type { ArgumentContract, CommandContract, Contract, OptionContract } from "../core/types";
import type { CliAdapter } from "./adapter.interface";

/**
 * Piped into `python -` (via stdin) rather than shipped as a separate .py
 * file - keeps the extractor inside cliguard's own compiled dist/ output
 * with zero extra packaging step, and guarantees the exact script that ran
 * in this session's live testing is the one that ships.
 *
 * Verified live against a real Click CLI (group + nested group + required/
 * repeatable/choice options + required/variadic arguments) before being
 * embedded here - see the class doc comment below for what each design
 * choice below is actually working around.
 */
const EXTRACT_SCRIPT = `
import sys, os, json, importlib.util


def main():
    if len(sys.argv) < 2:
        print("cliguard: internal error: no entry path given to extractor", file=sys.stderr)
        sys.exit(1)
    entry_path = sys.argv[1]

    try:
        import click
    except ImportError:
        print(
            "cliguard: the 'click' package is not installed in this Python environment. "
            "Install it in the same environment cliguard's Python is running from "
            "(e.g. \`pip install click\`).",
            file=sys.stderr,
        )
        sys.exit(1)

    module_name = "__cliguard_target__"
    spec = importlib.util.spec_from_file_location(module_name, entry_path)
    if spec is None or spec.loader is None:
        print(f'cliguard: could not load "{entry_path}" as a Python module.', file=sys.stderr)
        sys.exit(1)

    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    sys.path.insert(0, os.path.dirname(os.path.abspath(entry_path)))
    try:
        spec.loader.exec_module(module)
    except Exception:
        import traceback

        print(
            f'cliguard: error importing "{entry_path}":\\n' + traceback.format_exc(),
            file=sys.stderr,
        )
        sys.exit(1)

    candidates = [
        (name, value) for name, value in vars(module).items() if isinstance(value, click.Command)
    ]

    if not candidates:
        print(
            f'cliguard: no Click command found in "{entry_path}". '
            "Define one at module level with @click.command() or @click.group() "
            "(e.g. \`@click.group()\\\\ndef cli(): ...\`).",
            file=sys.stderr,
        )
        sys.exit(1)

    def subtree_size(cmd):
        size = 1
        if isinstance(cmd, click.Group):
            for sub in cmd.commands.values():
                size += subtree_size(sub)
        return size

    preferred_names = {"cli", "main", "app", "entry_point", "cmd"}

    def score(item):
        name, cmd = item
        return (subtree_size(cmd), 1 if name in preferred_names else 0)

    best_name, best_cmd = max(candidates, key=score)

    def safe_default(value):
        try:
            json.dumps(value)
            return value
        except TypeError:
            return None

    def resolve_default(p):
        # A flag's own default across Click versions is either a plain
        # bool (older/most versions: False when unset) or an internal
        # not-JSON-serializable sentinel (newer versions, when no
        # default= was passed) - caught live via CI running a different
        # pip-installed Click version than local testing used. Either
        # way the real, version-stable answer for "what value does the
        # caller get if they never pass this flag" is False, unless an
        # explicit bool default (e.g. default=True) was actually set.
        if p.is_flag and not isinstance(p.default, bool):
            return False
        return safe_default(p.default)

    def dump_param(p):
        if isinstance(p, click.Argument):
            return {
                "type": "Argument",
                "name": p.name,
                "required": bool(p.required),
                "nargs": p.nargs,
            }
        return {
            "type": "Option",
            "name": p.name,
            "opts": list(p.opts),
            "secondary_opts": list(p.secondary_opts),
            "required": bool(p.required),
            "is_flag": bool(p.is_flag),
            "multiple": bool(p.multiple),
            "default": resolve_default(p),
            "help": p.help,
        }

    def dump_command(cmd, name):
        result = {
            "name": name,
            "help": cmd.help,
            "short_help": cmd.get_short_help_str(),
            "params": [dump_param(p) for p in cmd.params],
        }
        if isinstance(cmd, click.Group):
            result["commands"] = {
                sub_name: dump_command(sub_cmd, sub_name) for sub_name, sub_cmd in cmd.commands.items()
            }
        return result

    print(json.dumps(dump_command(best_cmd, best_cmd.name or best_name)))


if __name__ == "__main__":
    main()
`;

interface ClickParamJson {
  readonly type: "Option" | "Argument";
  readonly name: string;
  readonly required: boolean;
  // Option-only fields:
  readonly opts?: readonly string[];
  readonly secondary_opts?: readonly string[];
  readonly is_flag?: boolean;
  readonly multiple?: boolean;
  readonly default?: unknown;
  readonly help?: string | null;
  // Argument-only field:
  readonly nargs?: number;
}

interface ClickCommandJson {
  readonly name: string;
  readonly help: string | null;
  readonly short_help: string;
  readonly params: readonly ClickParamJson[];
  readonly commands?: Readonly<Record<string, ClickCommandJson>>;
}

/**
 * Extracts a Contract from a target Python file that defines a Click
 * command or group at module level. Unlike every other adapter, this one
 * can't load the target in-process (a Python object graph is unreachable
 * from Node) - instead it pipes a small extractor script into `python -`
 * as a subprocess, and that script does the actual introspection using
 * Click's own object model (`.params`, `.commands`, `click.Option`/
 * `click.Argument`), then prints one JSON object on stdout. Never parses
 * `--help` output.
 *
 * The target file is imported (not executed as `__main__`), so its own
 * `if __name__ == "__main__": cli()` guard never fires - only the
 * module-level `@click.command()`/`@click.group()` decorations run, which
 * is all that's needed to build the command tree. When more than one
 * module-level Click command exists (e.g. both the root group and its own
 * decorated subcommand functions are separately addressable module
 * globals), the one whose own subtree (itself plus every nested
 * subcommand) is largest wins - a real subcommand's subtree is always a
 * strict subset of its parent group's, so the true root always scores
 * highest.
 */
export class ClickAdapter implements CliAdapter {
  readonly id = "click";
  readonly limitations: readonly string[] = [
    "CommandContract.aliases is always [] - Click's base Group/Command has no built-in alias concept (unlike Commander's .alias()).",
    'ArgumentContract.description is always "" - Click\'s click.Argument carries no help/description field, only click.Option does.',
    'OptionContract.valueType collapses every non-flag Click option (string, int, float, choice, path, ...) to "string" - Contract only distinguishes boolean vs. everything else, matching how CacAdapter/YargsAdapter already collapse their own richer type systems.',
    "A --flag/--no-flag paired boolean toggle surfaces as one OptionContract, same as a plain is_flag option - the negative form is only visible informationally inside `flags`, not as a separate field.",
    "Requires a `python3` or `python` on PATH with `click` installed in that same environment - unlike the JS adapters, which only need the target's own node_modules.",
  ];

  async extract(entryPath: string): Promise<Contract> {
    const absolutePath = resolve(process.cwd(), entryPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`cliguard: no such file: "${absolutePath}".`);
    }

    const root = this.mapCommand(await this.runExtractor(absolutePath));

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root,
    };
  }

  private async runExtractor(absolutePath: string): Promise<ClickCommandJson> {
    for (const pythonExe of ["python3", "python"]) {
      const result = spawnSync(pythonExe, ["-", absolutePath], {
        input: EXTRACT_SCRIPT,
        encoding: "utf8",
      });

      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      if (result.status !== 0) {
        throw new Error(
          `cliguard: failed to extract a Click contract from "${absolutePath}":\n` +
            (result.stderr.trim() || `${pythonExe} exited with code ${result.status}`),
        );
      }

      try {
        return JSON.parse(result.stdout) as ClickCommandJson;
      } catch {
        throw new Error(
          `cliguard: internal error - the Click extractor's output wasn't valid JSON:\n${result.stdout}`,
        );
      }
    }

    throw new Error(
      "cliguard: no Python interpreter found (tried `python3` and `python`). " +
        "The click adapter needs Python 3 with `click` installed on PATH to introspect a Click CLI.",
    );
  }

  private mapCommand(json: ClickCommandJson): CommandContract {
    return {
      name: json.name,
      // See class limitations: Click has no per-command alias concept.
      description: json.help ?? json.short_help ?? "",
      aliases: [],
      options: json.params
        .filter(
          (param): param is ClickParamJson & { readonly type: "Option" } => param.type === "Option",
        )
        .map((param) => this.mapOption(param)),
      arguments: json.params
        .filter(
          (param): param is ClickParamJson & { readonly type: "Argument" } =>
            param.type === "Argument",
        )
        .map((param) => this.mapArgument(param)),
      subcommands: json.commands
        ? Object.values(json.commands).map((sub) => this.mapCommand(sub))
        : [],
    };
  }

  private mapOption(param: ClickParamJson & { readonly type: "Option" }): OptionContract {
    const opts = [...(param.opts ?? []), ...(param.secondary_opts ?? [])];
    const primary =
      opts.find((flag) => this.normalizeFlag(flag) === param.name) ??
      opts.find((flag) => flag.startsWith("--")) ??
      opts[0];

    return {
      flags: opts.join(", "),
      name: param.name,
      aliases: opts.filter((flag) => flag !== primary),
      description: param.help ?? "",
      required: param.required,
      valueType: param.is_flag ? "boolean" : "string",
      variadic: param.multiple ?? false,
      defaultValue: param.default ?? null,
    };
  }

  private mapArgument(param: ClickParamJson & { readonly type: "Argument" }): ArgumentContract {
    return {
      name: param.name,
      required: param.required,
      variadic: (param.nargs ?? 1) === -1,
      // See class limitations: click.Argument has no help/description field.
      description: "",
    };
  }

  /** "--dry-run" -> "dry_run", "-v" -> "v" - Click's own name-inference rule, used to find which raw flag is the option's primary/canonical form. */
  private normalizeFlag(flag: string): string {
    return flag.replace(/^-+/, "").replace(/-/g, "_");
  }
}
