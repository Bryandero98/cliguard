import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import type { Contract } from "../core/types";

// storage.ts resolves CONTRACT_PATH once, from process.cwd() at import
// time (correct for a real CLI process - one cwd per invocation). To
// exercise it against a throwaway directory instead of this repo's own
// .cliguard/, each test chdir()s first and then requires a fresh copy of
// the module via jest.isolateModules, so CONTRACT_PATH is computed
// against the right cwd for that test.
function withFreshStorage<T>(
  dir: string,
  run: (storage: typeof import("../core/storage")) => T,
): T {
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    let result!: T;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate: needs a fresh module instance per test, not the cached one
      const storage = require("../core/storage") as typeof import("../core/storage");
      result = run(storage);
    });
    return result;
  } finally {
    // Must run even when `run` throws (several tests here assert a
    // throw) - on Windows, a process can't remove or rename its own
    // cwd, so leaving it pointed at the temp dir on an early return
    // makes afterEach's rmSync fail with EPERM. Verified live: this
    // exact failure happened before adding the finally.
    process.chdir(originalCwd);
  }
}

const SAMPLE_CONTRACT: Contract = {
  contractVersion: 1,
  adapter: "commander",
  capturedAt: "2026-01-01T00:00:00.000Z",
  root: {
    name: "mycli",
    description: "",
    aliases: [],
    options: [],
    arguments: [],
    subcommands: [],
  },
};

describe("storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "cliguard-storage-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("contractExists is false before anything is written", () => {
    const result = withFreshStorage(dir, (storage) => storage.contractExists());
    expect(result).toBe(false);
  });

  it("writeContract creates .cliguard/ if it doesn't exist yet", () => {
    withFreshStorage(dir, (storage) => storage.writeContract(SAMPLE_CONTRACT));

    const written = path.join(dir, ".cliguard", "contract.json");
    expect(existsSync(written)).toBe(true);
    expect(JSON.parse(readFileSync(written, "utf-8"))).toEqual(SAMPLE_CONTRACT);
  });

  it("readContract round-trips exactly what writeContract wrote", () => {
    const result = withFreshStorage(dir, (storage) => {
      storage.writeContract(SAMPLE_CONTRACT);
      return storage.readContract();
    });
    expect(result).toEqual(SAMPLE_CONTRACT);
  });

  it("readContract throws a clear, actionable error when no contract exists", () => {
    expect(() => withFreshStorage(dir, (storage) => storage.readContract())).toThrow(
      /no contract found.*cliguard init/,
    );
  });

  it("readContract throws a clear error naming the file when the contract is corrupt JSON", () => {
    // Regression test: a bare JSON.parse error ("Unexpected token...")
    // reads as an internal cliguard bug, not "your committed contract
    // file is corrupted" - verified live before this fix.
    mkdirSync(path.join(dir, ".cliguard"));
    writeFileSync(path.join(dir, ".cliguard", "contract.json"), "{ not valid json");

    expect(() => withFreshStorage(dir, (storage) => storage.readContract())).toThrow(
      /is not valid JSON.*cliguard update/,
    );
  });

  it("readContractFile reads a Contract from an arbitrary path, unrelated to the committed one", () => {
    const arbitraryPath = path.join(dir, "some-other-name.json");
    writeFileSync(arbitraryPath, JSON.stringify(SAMPLE_CONTRACT));

    const result = withFreshStorage(dir, (storage) => storage.readContractFile(arbitraryPath));
    expect(result).toEqual(SAMPLE_CONTRACT);
  });

  it("readContractFile throws a clear error naming the file when it doesn't exist", () => {
    const missing = path.join(dir, "missing.json");
    expect(() => withFreshStorage(dir, (storage) => storage.readContractFile(missing))).toThrow(
      /no such file/,
    );
  });

  it("readContractFile throws a clear error naming the file when it's corrupt JSON", () => {
    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not valid json");
    expect(() => withFreshStorage(dir, (storage) => storage.readContractFile(corrupt))).toThrow(
      /is not valid JSON/,
    );
  });
});
