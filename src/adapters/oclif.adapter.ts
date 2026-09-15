import { spawnSync } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { dirname, extname, join, resolve } from "path";

import type {
  ArgumentContract,
  CommandContract,
  Contract,
  OptionContract,
  OptionValueType,
} from "../core/types";
import type { CliAdapter } from "./adapter.interface";

/** The file `oclif manifest` writes - see https://oclif.io, the CLI's own "manifest" plugin command. */
const MANIFEST_FILENAME = "oclif.manifest.json";

interface OclifFlagJson {
  readonly name: string;
  readonly char?: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: unknown;
  /** The env var that can also satisfy this flag - oclif's own `env:` flag option, verified live against a real manifest. */
  readonly env?: string;
  readonly multiple?: boolean;
  /** "option" = takes a value, "boolean" = valueless flag - verified live against oclif's own manifest generator (`@oclif/core`'s `Flags.string`/`Flags.boolean`/etc. all collapse to one of these two at manifest time). */
  readonly type: "option" | "boolean";
}

interface OclifArgJson {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

interface OclifCommandJson {
  readonly id: string;
  readonly description?: string | null;
  readonly aliases?: readonly string[];
  readonly flags?: Readonly<Record<string, OclifFlagJson>>;
  readonly args?: Readonly<Record<string, OclifArgJson>>;
  /** The target project's own package name - read here only as a fallback root name, see `inferRootName`. */
  readonly pluginName?: string;
}

interface OclifManifestJson {
  readonly commands: Readonly<Record<string, OclifCommandJson>>;
}

/** Mutable scratch shape used only while assembling the tree - converted to a real (readonly) CommandContract by `toCommandContract` once complete. */
interface MutableNode {
  name: string;
  description: string;
  aliases: string[];
  options: OptionContract[];
  arguments: ArgumentContract[];
  readonly children: Map<string, MutableNode>;
}

/**
 * Extracts a Contract from an oclif CLI project by reading its manifest -
 * `oclif.manifest.json`, the same structured JSON oclif's own `oclif
 * manifest` command produces (and which some oclif projects already commit,
 * e.g. to speed up their own startup/README generation). Unlike Cobra or
 * Click, no subprocess-based introspection script had to be written for
 * this adapter: oclif already ships a first-class command that dumps a
 * complete, versioned description of every command's flags and positional
 * arguments as JSON - this adapter only has to run it (when needed) and map
 * its shape onto `Contract`.
 *
 * `entryPath` is either:
 * - a path to an already-generated `oclif.manifest.json` file - read directly, no subprocess.
 * - a path to the oclif project's root directory (containing `package.json`)
 *   - if that directory already has its own `oclif.manifest.json` (common:
 *     some projects commit it, or a build step already produced it), that
 *     file is read as-is; otherwise this runs `npx oclif manifest .` there
 *     (requiring `oclif` installed as a devDependency) and removes the
 *     file it generated once done, leaving the project tree untouched.
 *
 * oclif's own command tree is flat, not nested the way Commander's is -
 * every command has one `id` with `:` separating topic levels (e.g.
 * `"config:get"`) rather than a real parent/child object graph. This
 * adapter rebuilds the nested `CommandContract` tree `Contract` expects by
 * splitting each id on `:`, synthesizing an empty topic node for any
 * intermediate segment that isn't itself a real command (e.g. `"config"`
 * when only `"config:get"` exists), matching how a real oclif CLI's own
 * `--help` groups things.
 */
export class OclifAdapter implements CliAdapter {
  readonly id = "oclif";
  readonly limitations: readonly string[] = [
    'CommandContract tree is rebuilt from oclif\'s flat, colon-separated command ids (e.g. "config:get") - an intermediate topic with no command of its own (e.g. "config" when only "config:get" exists) appears as an empty synthetic node purely to hold its children.',
    "ArgumentContract.variadic is always false - oclif's manifest carries no per-argument multiple-values concept; a command declaring `static strict = false` to accept unlimited extra positional args doesn't surface those extra args as a named argument at all.",
    'OptionContract.valueType collapses every oclif flag kind (string, integer, url, ...) to "boolean" vs "string", the same simplification every adapter besides Commander already makes.',
    "Requires generating (or reading an already-committed) oclif.manifest.json in the target project - when one doesn't already exist, this shells out to `npx oclif manifest .` (requiring `oclif` installed as a devDependency there) and removes the file it generated once done.",
    "A single-command oclif CLI (package.json's `oclif.default`) may not appear as a distinct entry in the manifest at all, depending on the oclif version - verify with `cliguard doctor` before relying on it for that shape of CLI.",
  ];

  async extract(entryPath: string): Promise<Contract> {
    const absolutePath = resolve(process.cwd(), entryPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`cliguard: no such file or directory: "${absolutePath}".`);
    }

    const manifest = this.loadManifest(absolutePath);
    const rootName = this.inferRootName(absolutePath, manifest);

    return {
      contractVersion: 1,
      adapter: this.id,
      capturedAt: new Date().toISOString(),
      root: this.buildTree(rootName, manifest),
    };
  }

  private loadManifest(absolutePath: string): OclifManifestJson {
    if (extname(absolutePath) === ".json") {
      return this.parseManifestFile(absolutePath);
    }

    const manifestPath = join(absolutePath, MANIFEST_FILENAME);
    const alreadyExisted = existsSync(manifestPath);
    if (!alreadyExisted) {
      this.generateManifest(absolutePath);
    }

    try {
      return this.parseManifestFile(manifestPath);
    } finally {
      // Only clean up a manifest this adapter itself produced as a
      // side effect - one the target project already committed is left
      // exactly as it was found.
      if (!alreadyExisted) {
        try {
          rmSync(manifestPath, { force: true });
        } catch {
          // Best-effort cleanup - a stray oclif.manifest.json left behind
          // is a minor annoyance, never worth failing extraction over.
        }
      }
    }
  }

  private generateManifest(projectDir: string): void {
    // `shell: true` only on win32, where `npx` itself is a `.cmd` shim
    // that Node's spawnSync can't invoke directly (a well-known Windows
    // gotcha - verified live: without it this fails with EINVAL/ENOENT
    // regardless of PATH). Every argument here is a fixed literal, never
    // interpolated from `projectDir` or any other dynamic value - it's
    // passed via `cwd` instead - so shell mode carries no injection risk
    // despite Node's own generic deprecation warning about it.
    const result = spawnSync("npx", ["--no-install", "oclif", "manifest", "."], {
      cwd: projectDir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    if (result.error) {
      throw new Error(
        `cliguard: failed to run \`oclif manifest\` in "${projectDir}": ${result.error.message} - ` +
          'is "oclif" installed as a devDependency there?',
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `cliguard: \`oclif manifest\` exited with code ${result.status} in "${projectDir}" - ` +
          'is "oclif" installed as a devDependency, and does its package.json have a valid "oclif" field?\n' +
          (result.stderr.trim() || result.stdout.trim()),
      );
    }
  }

  private parseManifestFile(manifestPath: string): OclifManifestJson {
    if (!existsSync(manifestPath)) {
      throw new Error(
        `cliguard: no such file: "${manifestPath}" - expected an oclif manifest. Run ` +
          "`oclif manifest` in the plugin's root first, or point cliguard directly at that project directory.",
      );
    }
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (error) {
      throw new Error(
        `cliguard: could not read "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return JSON.parse(raw) as OclifManifestJson;
    } catch {
      throw new Error(`cliguard: internal error - "${manifestPath}" wasn't valid JSON.`);
    }
  }

  /** Prefers the target's own package.json "name" (the CLI's real identity); falls back to a command's own `pluginName`, then a generic default - a manifest with zero commands has neither. */
  private inferRootName(absolutePath: string, manifest: OclifManifestJson): string {
    const projectDir = extname(absolutePath) === ".json" ? dirname(absolutePath) : absolutePath;
    const packageJsonPath = join(projectDir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string };
        if (typeof pkg.name === "string" && pkg.name) return pkg.name;
      } catch {
        // Falls through to the manifest-derived name below - an unreadable
        // or malformed package.json alongside a perfectly good manifest
        // shouldn't block extraction entirely.
      }
    }

    const firstCommand = Object.values(manifest.commands)[0];
    return firstCommand?.pluginName ?? "cli";
  }

  private buildTree(rootName: string, manifest: OclifManifestJson): CommandContract {
    const root = this.makeNode(rootName);

    for (const [id, command] of Object.entries(manifest.commands)) {
      const segments = id.split(":").filter((segment) => segment.length > 0);

      let node = root;
      for (const segment of segments) {
        let child = node.children.get(segment);
        if (!child) {
          child = this.makeNode(segment);
          node.children.set(segment, child);
        }
        node = child;
      }

      // `segments` is empty for a single-command CLI's own id (`""`) -
      // its properties land directly on `root` in that case, same as any
      // other command lands on the node its own path resolves to.
      node.description = command.description ?? "";
      node.aliases = [...(command.aliases ?? [])];
      node.options = this.mapFlags(command.flags);
      node.arguments = this.mapArgs(command.args);
    }

    return this.toCommandContract(root);
  }

  private makeNode(name: string): MutableNode {
    return { name, description: "", aliases: [], options: [], arguments: [], children: new Map() };
  }

  private toCommandContract(node: MutableNode): CommandContract {
    return {
      name: node.name,
      description: node.description,
      aliases: node.aliases,
      options: node.options,
      arguments: node.arguments,
      subcommands: [...node.children.values()].map((child) => this.toCommandContract(child)),
    };
  }

  private mapFlags(flags: Readonly<Record<string, OclifFlagJson>> | undefined): OptionContract[] {
    return Object.entries(flags ?? {}).map(([name, flag]) => this.mapFlag(name, flag));
  }

  private mapFlag(name: string, flag: OclifFlagJson): OptionContract {
    const valueType: OptionValueType = flag.type === "boolean" ? "boolean" : "string";
    const long = `--${name}` + (valueType === "boolean" ? "" : ` <${name}>`);

    return {
      flags: flag.char ? `-${flag.char}, ${long}` : long,
      name,
      aliases: flag.char ? [`-${flag.char}`] : [],
      description: flag.description ?? "",
      required: flag.required ?? false,
      valueType,
      variadic: flag.multiple ?? false,
      defaultValue: flag.default ?? null,
      envVar: flag.env,
    };
  }

  private mapArgs(args: Readonly<Record<string, OclifArgJson>> | undefined): ArgumentContract[] {
    return Object.entries(args ?? {}).map(([name, arg]) => ({
      name,
      required: arg.required ?? false,
      // See class limitations: oclif's manifest has no per-argument
      // multiple-values concept.
      variadic: false,
      description: arg.description ?? "",
    }));
  }
}
