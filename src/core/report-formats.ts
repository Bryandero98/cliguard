import { createHash } from "crypto";

import { ChangeType } from "./types";

/** The same annotated shape `check --json`/`diff --json` already produce - a BREAKING entry matched by `cliguard accept` gains `acknowledged`/`reason`. */
export interface ReportChange {
  readonly type: ChangeType;
  readonly path: string;
  readonly message: string;
  readonly acknowledged?: boolean;
  readonly reason?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * One <testsuite> named "cliguard", one <testcase> per changed path - the
 * same shape ESLint/ruff's own JUnit reporters use, understood natively by
 * Jenkins, CircleCI, Azure DevOps, and GitLab's own "JUnit report" widget.
 * Only an unacknowledged BREAKING entry gets a <failure> child; ADDITIVE,
 * PATCH, and an acknowledged BREAKING all report as a passing testcase,
 * matching exactly which entries fail `check`'s own exit code.
 *
 * DiffResult.path can itself contain `<`/`>` (an argument path looks like
 * "root -> build -> argument[<file>]") - every value here goes through
 * escapeXml, not just the message, or this would emit invalid XML on the
 * very first CLI that has a positional argument.
 */
export function toJUnitXml(changes: readonly ReportChange[]): string {
  const failures = changes.filter(
    (change) => change.type === ChangeType.BREAKING && !change.acknowledged,
  ).length;

  const testcases = changes.map((change) => {
    const name = escapeXml(change.path);
    const message = escapeXml(change.message);
    const isFailure = change.type === ChangeType.BREAKING && !change.acknowledged;

    if (!isFailure) {
      return (
        `    <testcase name="${name}" classname="cliguard">\n` +
        `      <system-out>${message}</system-out>\n` +
        `    </testcase>`
      );
    }

    return (
      `    <testcase name="${name}" classname="cliguard">\n` +
      `      <failure message="${message}" type="BREAKING">${message}</failure>\n` +
      `    </testcase>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="cliguard" tests="${changes.length}" failures="${failures}">\n` +
    (testcases.length > 0 ? `${testcases.join("\n")}\n` : "") +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

type GitLabSeverity = "info" | "minor" | "major" | "critical" | "blocker";

function severityFor(change: ReportChange): GitLabSeverity {
  if (change.type === ChangeType.BREAKING) return change.acknowledged ? "info" : "blocker";
  if (change.type === ChangeType.PATCH) return "minor";
  return "info"; // ADDITIVE
}

/**
 * GitLab's Code Quality report format (`artifacts: reports: codequality`),
 * surfaced as inline annotations on a merge request. The format is
 * inherently file+line shaped - a cliguard change has neither, so every
 * entry points at the committed contract file (line 1) and puts the real
 * location in the description instead. A best-effort mapping, not a
 * perfect fit for what GitLab expects, but it gets cliguard's diff into
 * GitLab's own MR widget with zero extra infra on GitLab's side.
 */
export function toGitLabCodeQuality(
  changes: readonly ReportChange[],
  contractPath: string,
): string {
  const issues = changes.map((change) => ({
    description: `[${change.type}] ${change.path}: ${change.message}`,
    check_name: `cliguard/${change.type.toLowerCase()}`,
    fingerprint: createHash("md5").update(`${change.path}|${change.message}`).digest("hex"),
    severity: severityFor(change),
    location: { path: contractPath, lines: { begin: 1 } },
  }));

  return JSON.stringify(issues, null, 2);
}

type RdjsonlSeverity = "ERROR" | "WARNING" | "INFO";

function rdjsonlSeverityFor(change: ReportChange): RdjsonlSeverity {
  if (change.type === ChangeType.BREAKING) return change.acknowledged ? "INFO" : "ERROR";
  if (change.type === ChangeType.PATCH) return "WARNING";
  return "INFO"; // ADDITIVE
}

/**
 * reviewdog's own Diagnostic Format, one JSON object per line (rdjsonl) -
 * NOT a JSON array, reviewdog reads it as a stream. Piping this into
 * `reviewdog -f=rdjsonl -reporter=<...>` hands off posting the diff to
 * whichever platform reviewdog already has a reporter for (GitHub,
 * GitLab, Bitbucket, a local checkstyle-style report), instead of
 * cliguard maintaining a bespoke reporter per platform itself. Same
 * file+line limitation and same fallback (the contract file, line 1) as
 * `toGitLabCodeQuality` - reviewdog's format is just as file-shaped.
 */
export function toRdjsonl(changes: readonly ReportChange[], contractPath: string): string {
  return changes
    .map((change) =>
      JSON.stringify({
        message: `[${change.type}] ${change.message}`,
        location: { path: contractPath, range: { start: { line: 1, column: 1 } } },
        severity: rdjsonlSeverityFor(change),
        code: { value: change.path },
      }),
    )
    .join("\n");
}
