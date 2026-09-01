import { existsSync } from "fs";
import { join, relative } from "path";

import type { DiffResult } from "./diff.engine";
import { ChangeType } from "./types";

export interface SeverityOverride {
  readonly pattern: string | RegExp;
  readonly severity: ChangeType;
}

export interface CliguardConfig {
  /** A change whose DiffResult.path matches any of these is dropped from the report entirely - never shown, never counted, never fails the build. */
  readonly ignore?: readonly (string | RegExp)[];
  /** A change whose DiffResult.path matches `pattern` gets reclassified to `severity` - the first matching entry wins. */
  readonly severityOverrides?: readonly SeverityOverride[];
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

  return config as CliguardConfig;
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
