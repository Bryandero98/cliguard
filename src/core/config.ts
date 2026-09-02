import { existsSync } from "fs";
import { join, relative } from "path";

import type { DiffResult } from "./diff.engine";
import { ChangeType } from "./types";

export interface SeverityOverride {
  readonly pattern: string | RegExp;
  readonly severity: ChangeType;
}

export interface ConfigTarget {
  /** Unique within the config; namespaces this target's contract/accepted-breaks/deprecations under `.cliguard/<name>/` instead of `.cliguard/`, and is what `cliguard check <name>` matches against to run just this one target. */
  readonly name: string;
  readonly entry: string;
  /** Defaults to "commander", same as the CLI's own `--adapter` default. */
  readonly adapter?: string;
}

export interface CliguardConfig {
  /** A change whose DiffResult.path matches any of these is dropped from the report entirely - never shown, never counted, never fails the build. */
  readonly ignore?: readonly (string | RegExp)[];
  /** A change whose DiffResult.path matches `pattern` gets reclassified to `severity` - the first matching entry wins. */
  readonly severityOverrides?: readonly SeverityOverride[];
  /** A monorepo's CLI entry points - `init`/`check`/`update`/`accept` run against every target when no entry is given on the command line, or against just one by passing its `name` in place of an entry path. An explicit file-path entry always keeps working exactly as it does today, config or no config - see resolveTargets. */
  readonly targets?: readonly ConfigTarget[];
}

const CANDIDATE_NAMES = ["cliguard.config.js", "cliguard.config.cjs"];

function resolveConfigPath(): string | null {
  for (const name of CANDIDATE_NAMES) {
    const path = join(process.cwd(), name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Display-only path of whichever config file was actually found, or the first candidate name if none was - only meaningful in an error message alongside `configExists()`. */
export function getConfigDisplayPath(): string {
  const path = resolveConfigPath();
  return path ? relative(process.cwd(), path).split("\\").join("/") : CANDIDATE_NAMES[0];
}

export function configExists(): boolean {
  return resolveConfigPath() !== null;
}

const VALID_SEVERITIES: readonly string[] = [
  ChangeType.BREAKING,
  ChangeType.ADDITIVE,
  ChangeType.PATCH,
];

function validateConfig(raw: unknown, displayPath: string): CliguardConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`cliguard: ${displayPath} must export an object (module.exports = {...}).`);
  }
  const config = raw as Record<string, unknown>;

  if (config.ignore !== undefined) {
    if (
      !Array.isArray(config.ignore) ||
      !config.ignore.every((entry) => typeof entry === "string" || entry instanceof RegExp)
    ) {
      throw new Error(`cliguard: ${displayPath}'s "ignore" must be an array of strings/RegExp.`);
    }
  }

  if (config.severityOverrides !== undefined) {
    if (!Array.isArray(config.severityOverrides)) {
      throw new Error(`cliguard: ${displayPath}'s "severityOverrides" must be an array.`);
    }
    for (const entry of config.severityOverrides as unknown[]) {
      const override = entry as Partial<SeverityOverride>;
      const patternOk = typeof override.pattern === "string" || override.pattern instanceof RegExp;
      const severityOk =
        typeof override.severity === "string" && VALID_SEVERITIES.includes(override.severity);
      if (!patternOk || !severityOk) {
        throw new Error(
          `cliguard: ${displayPath}'s "severityOverrides" entries must look like ` +
            `{ pattern: string | RegExp, severity: "BREAKING" | "ADDITIVE" | "PATCH" } - got ${JSON.stringify(entry)}.`,
        );
      }
    }
  }

  if (config.targets !== undefined) {
    if (!Array.isArray(config.targets)) {
      throw new Error(`cliguard: ${displayPath}'s "targets" must be an array.`);
    }
    const seenNames = new Set<string>();
    for (const entry of config.targets as unknown[]) {
      const target = entry as Partial<ConfigTarget>;
      const nameOk = typeof target.name === "string" && target.name.length > 0;
      const entryOk = typeof target.entry === "string" && target.entry.length > 0;
      const adapterOk = target.adapter === undefined || typeof target.adapter === "string";
      if (!nameOk || !entryOk || !adapterOk) {
        throw new Error(
          `cliguard: ${displayPath}'s "targets" entries must look like ` +
            `{ name: string, entry: string, adapter?: string } - got ${JSON.stringify(entry)}.`,
        );
      }
      if (seenNames.has(target.name as string)) {
        throw new Error(
          `cliguard: ${displayPath}'s "targets" has more than one entry named "${target.name}" - ` +
            "names must be unique, since each one gets its own .cliguard/<name>/ directory.",
        );
      }
      seenNames.add(target.name as string);
    }
  }

  return config as CliguardConfig;
}

/** One target `init`/`check`/`update`/`accept` should run against - `namespace` is `null` for the classic single-CLI flow (no config, or an explicit file-path entry), and a target's own `name` when resolved from `cliguard.config.js`, namespacing that target's `.cliguard/` files under `.cliguard/<namespace>/`. */
export interface ResolvedTarget {
  readonly namespace: string | null;
  readonly entry: string;
  readonly adapter: string;
}

/**
 * Turns a command-line `[entry]` (now optional - see bin.ts) plus whatever
 * `cliguard.config.js` declared into the concrete list of targets a
 * command should run against:
 *
 * - `entry` given and it matches no configured target's `name`: exactly
 *   what happens today with zero config - one classic, unnamespaced
 *   target, using `entry` as a literal file path. This is deliberate and
 *   load-bearing: a project with no `targets` in its config (or no config
 *   at all) is completely unaffected by this feature.
 * - `entry` given and it DOES match a configured target's `name`: just
 *   that one target, namespaced.
 * - `entry` omitted and `targets` is configured: every configured target.
 * - `entry` omitted and no `targets` configured: throws - there's nothing
 *   to run against.
 */
export function resolveTargets(
  entry: string | undefined,
  config: CliguardConfig,
  cliAdapter: string,
): ResolvedTarget[] {
  const targets = config.targets ?? [];

  if (entry !== undefined) {
    const named = targets.find((target) => target.name === entry);
    if (named) {
      return [{ namespace: named.name, entry: named.entry, adapter: named.adapter ?? "commander" }];
    }
    return [{ namespace: null, entry, adapter: cliAdapter }];
  }

  if (targets.length > 0) {
    return targets.map((target) => ({
      namespace: target.name,
      entry: target.entry,
      adapter: target.adapter ?? "commander",
    }));
  }

  throw new Error(
    "cliguard: no entry given and no targets configured. Pass an entry file path, " +
      'or add `targets: [{ name, entry, adapter? }, ...]` to cliguard.config.js.',
  );
}

/** Returns `{}` (no policy applied) when no config file exists - a project with no `cliguard.config.js` behaves exactly as it always has. */
export function loadConfig(): CliguardConfig {
  const path = resolveConfigPath();
  if (!path) return {};

  const displayPath = getConfigDisplayPath();
  let raw: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a config file is plain CommonJS by design, same convention as eslint.config.js/jest.config.js
    raw = require(path);
  } catch (error) {
    throw new Error(
      `cliguard: failed to load ${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateConfig(raw, displayPath);
}

/** Glob-lite: `*` matches any run of characters, everything else is matched literally - just enough to write "root -> * -> option[--debug]" without a full glob dependency for one wildcard character. */
function matchesGlob(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function matches(pattern: string | RegExp, path: string): boolean {
  return pattern instanceof RegExp ? pattern.test(path) : matchesGlob(pattern, path);
}

/**
 * Applies project-wide policy before any per-instance override (`cliguard
 * accept`/`deprecate`) gets a chance to run - an ignored or downgraded
 * change simply isn't BREAKING by the time either of those look at it, so
 * there's nothing left to accept or deprecate for it.
 */
export function applyConfig(diff: readonly DiffResult[], config: CliguardConfig): DiffResult[] {
  const ignore = config.ignore ?? [];
  const overrides = config.severityOverrides ?? [];
  if (ignore.length === 0 && overrides.length === 0) return diff as DiffResult[];

  return diff
    .filter((entry) => !ignore.some((pattern) => matches(pattern, entry.path)))
    .map((entry) => {
      const override = overrides.find((candidate) => matches(candidate.pattern, entry.path));
      if (!override || override.severity === entry.type) return entry;
      return {
        ...entry,
        type: override.severity,
        message: `${entry.message} [config: severity overridden to ${override.severity}]`,
      };
    });
}
