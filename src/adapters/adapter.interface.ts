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
  /** Loads `entryPath` and extracts its full command surface as a Contract. */
  extract(entryPath: string): Promise<Contract>;
}
