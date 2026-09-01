import type { Contract } from "../core/types";

/**
 * Everything the diff engine and the `cliguard` CLI commands need from a
 * framework adapter. Each adapter owns exactly one framework's introspection
 * details; nothing outside `src/adapters/` should ever import a framework
 * package (`commander`, `cac`, eventually `yargs`) directly.
 */
export interface CliAdapter {
  /** Adapter identifier stored in `Contract.adapter`, e.g. "commander". */
  readonly id: string;
  /**
   * Real, framework-shape limitations on what this adapter can populate in
   * a Contract - not bugs, just things the target framework itself has no
   * concept of (documented in more depth in each adapter's own doc
   * comment). Empty for an adapter with no such gaps. Surfaced by
   * `cliguard doctor` so a user hits this in a one-line summary instead of
   * only discovering it by reading adapter source or being surprised by a
   * `required` that's silently always `false`.
   */
  readonly limitations: readonly string[];
  /** Loads `entryPath` and extracts its full command surface as a Contract. */
  extract(entryPath: string): Promise<Contract>;
}
