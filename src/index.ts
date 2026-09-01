/**
 * Programmatic entry point - `import { extractContract, compareContracts } from "cliguard"`.
 * Everything here is the same code `bin.ts` itself calls; this file only
 * adds the two convenience wrappers (`extractContract`/`compareContracts`)
 * and re-exports the pieces a caller embedding cliguard in their own
 * build script, monorepo tooling, or bot would need - never a second
 * implementation of anything.
 */
import { adapters, resolveAdapter } from "./adapters/registry";
import { DiffEngine, type CompareOptions, type DiffResult } from "./core/diff.engine";
import type { Contract } from "./core/types";

export type { CliAdapter } from "./adapters/adapter.interface";
export { CacAdapter } from "./adapters/cac.adapter";
export { CommanderAdapter } from "./adapters/commander.adapter";
export { YargsAdapter } from "./adapters/yargs.adapter";
export { adapters, resolveAdapter } from "./adapters/registry";

export { applyConfig, configExists, loadConfig } from "./core/config";
export type { CliguardConfig, SeverityOverride } from "./core/config";
export { DiffEngine } from "./core/diff.engine";
export type { CompareOptions, DiffResult } from "./core/diff.engine";
export { renderMarkdownDocs } from "./core/docs";
export { toGitLabCodeQuality, toJUnitXml, toRdjsonl } from "./core/report-formats";
export type { ReportChange } from "./core/report-formats";
export {
  ChangeType,
  type AcceptedBreak,
  type ArgumentContract,
  type CommandContract,
  type Contract,
  type Deprecation,
  type OptionContract,
  type OptionValueType,
} from "./core/types";

const diffEngine = new DiffEngine();

/**
 * Loads `entryPath` and extracts its full command surface as a Contract -
 * the same extraction `cliguard init`/`check`/`update` run, without going
 * through a subprocess. `adapterName` defaults to "commander", matching
 * the CLI's own default.
 */
export async function extractContract(
  entryPath: string,
  adapterName = "commander",
): Promise<Contract> {
  // Deliberately `async` rather than returning resolveAdapter(...).extract(...)
  // directly - resolveAdapter throws synchronously on an unknown name, and
  // without `async` that throw would escape as a synchronous exception
  // instead of a rejected Promise, breaking the "this always returns a
  // Promise" contract the function's own return type promises.
  return resolveAdapter(adapterName).extract(entryPath);
}

/**
 * Compares two Contracts and returns every difference, classified
 * BREAKING/ADDITIVE/PATCH - the exact same comparison `cliguard check`/`diff`
 * run. Framework-agnostic: neither Contract needs to have come from
 * `extractContract`, so this also works against contracts read from disk
 * or a git ref by the caller's own code.
 */
export function compareContracts(
  oldContract: Contract,
  newContract: Contract,
  options?: CompareOptions,
): DiffResult[] {
  return diffEngine.compare(oldContract, newContract, options);
}

/** Every adapter name `extractContract`/the CLI's `--adapter` flag will accept, e.g. ["commander", "cac", "yargs"]. */
export function listAdapters(): string[] {
  return Object.keys(adapters);
}
