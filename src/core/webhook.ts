import { execFileSync } from "child_process";

import type { DiffResult } from "./diff.engine";

/** The same three fields DiffResult carries on the wire - `removal` is an internal detail (used by `cliguard deprecate`), not part of the v1 webhook payload. */
export interface WebhookChange {
  readonly type: string;
  readonly path: string;
  readonly message: string;
}

export interface WebhookPayload {
  /** The entry file (or config target name) `check` ran against. */
  readonly entry: string;
  /** `git config --get remote.origin.url`, or null outside a git repo / with no origin configured. */
  readonly repo: string | null;
  /** `git rev-parse HEAD`, or null outside a git repository. */
  readonly commit: string | null;
  readonly changes: readonly WebhookChange[];
}

/** Best-effort: a plain temp dir, a shallow clone with no origin, or no git at all should never fail the payload - just leaves the field null. */
function gitValue(args: readonly string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function buildWebhookPayload(entry: string, changes: readonly DiffResult[]): WebhookPayload {
  return {
    entry,
    repo: gitValue(["config", "--get", "remote.origin.url"]),
    commit: gitValue(["rev-parse", "HEAD"]),
    changes: changes.map(({ type, path, message }) => ({ type, path, message })),
  };
}

/**
 * POSTs a check result to a configurable webhook URL - v1 of the "SaaS
 * integration" building block from the README's roadmap (issue #3): just
 * the POST itself, no receiving service or dashboard. Uses Node's native
 * `fetch` (18+) - no new dependency. Throws on a network error or a non-2xx
 * response so the caller (bin.ts) decides how to surface that; it never
 * affects `check`'s own exit code, which reflects the CLI contract diff,
 * not whether a webhook happened to be reachable.
 */
export async function postWebhook(url: string, payload: WebhookPayload): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      // Never lets an unreachable/slow webhook host hang `check` - 5s is
      // generous for a same-request JSON POST, and a timeout is reported
      // through the same catch below as any other network failure.
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new Error(
      `cliguard: webhook POST to "${url}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`cliguard: webhook POST to "${url}" failed with status ${response.status}.`);
  }
}
