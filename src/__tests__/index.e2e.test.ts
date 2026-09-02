import path from "path";

// Deliberately requires the COMPILED package the way a real consumer
// would - `require("cliguard")` resolves through `main` in package.json,
// not a relative import of src/index.ts - so this catches a wrong
// main/types/exports entry in package.json, not just a TypeScript-level
// mistake in index.ts itself. `pretest` (see package.json) always runs
// `npm run build` first, so dist/ is guaranteed fresh here.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: must go through the real package entry, not a relative src import
const cliguard = require("../../") as typeof import("../index");

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-cli.js");

describe('programmatic API (require("cliguard"))', () => {
  it("extractContract extracts a real contract from the compiled package entry", async () => {
    const contract = await cliguard.extractContract(FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("commander");
    expect(contract.root.subcommands.some((cmd) => cmd.name === "build")).toBe(true);
  });

  it("extractContract rejects an unknown adapter name with a clear error", async () => {
    await expect(cliguard.extractContract(FIXTURE, "nope")).rejects.toThrow(
      'unknown adapter "nope"',
    );
  });

  it("compareContracts reports a real BREAKING change end to end, without any subprocess", async () => {
    const oldContract = await cliguard.extractContract(FIXTURE);
    const newContract: import("../index").Contract = {
      ...oldContract,
      root: {
        ...oldContract.root,
        subcommands: oldContract.root.subcommands.filter((cmd) => cmd.name !== "build"),
      },
    };

    const diff = cliguard.compareContracts(oldContract, newContract);

    expect(diff).toContainEqual(
      expect.objectContaining({
        type: cliguard.ChangeType.BREAKING,
        path: "root -> build",
        removal: true,
      }),
    );
  });

  it("compareContracts respects the strict option the same way the CLI's --strict does", () => {
    const base: import("../index").Contract = {
      contractVersion: 1,
      adapter: "commander",
      capturedAt: "2026-01-01T00:00:00.000Z",
      root: {
        name: "mycli",
        description: "",
        aliases: [],
        options: [],
        subcommands: [],
        arguments: [
          { name: "src", required: true, variadic: false, description: "" },
          { name: "dest", required: true, variadic: false, description: "" },
        ],
      },
    };
    const reordered: import("../index").Contract = {
      ...base,
      root: {
        ...base.root,
        arguments: [...base.root.arguments].reverse(),
      },
    };

    expect(cliguard.compareContracts(base, reordered)).toEqual([]);
    expect(cliguard.compareContracts(base, reordered, { strict: true })).toContainEqual(
      expect.objectContaining({ type: cliguard.ChangeType.BREAKING }),
    );
  });

  it("listAdapters reports every adapter the CLI's --adapter flag also accepts", () => {
    expect(cliguard.listAdapters().sort()).toEqual(["cac", "click", "commander", "yargs"]);
  });

  it("toJUnitXml is usable directly against compareContracts's own output", async () => {
    const oldContract = await cliguard.extractContract(FIXTURE);
    const diff = cliguard.compareContracts(oldContract, oldContract);

    expect(cliguard.toJUnitXml(diff)).toContain('tests="0"');
  });

  it("renderMarkdownDocs is usable directly against extractContract's own output", async () => {
    const contract = await cliguard.extractContract(FIXTURE);

    const markdown = cliguard.renderMarkdownDocs(contract, "fallback");

    expect(markdown).toContain("## `build <entry> [extra...]`");
  });
});
