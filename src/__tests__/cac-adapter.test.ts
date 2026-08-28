import path from "path";

import { CacAdapter } from "../adapters/cac.adapter";

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-cac-cli.js");

describe("CacAdapter", () => {
  it("extracts the root and a subcommand from a real CAC program", async () => {
    const adapter = new CacAdapter();
    const contract = await adapter.extract(FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("cac");
    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);

    const build = contract.root.subcommands[0];
    expect(build.name).toBe("build");
    expect(build.description).toBe("Build the project");
    expect(build.aliases).toEqual(["b"]);
    // CAC has no nested sub-subcommand concept - every mapped command's
    // own subcommands is always empty.
    expect(build.subcommands).toEqual([]);
  });

  it("maps positional arguments, including required and variadic (CAC's [...name] syntax)", async () => {
    const adapter = new CacAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];

    expect(build.arguments).toEqual([
      { name: "entry", required: true, variadic: false, description: "" },
      { name: "extra", required: false, variadic: true, description: "" },
    ]);
  });

  it("maps every option shape correctly, including CAC's always-false required", async () => {
    const adapter = new CacAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    // CAC has no declarative "this option must be passed" concept
    // (unlike Commander's requiredOption) - required is always false.
    expect(byName.output).toMatchObject({
      valueType: "string",
      required: false,
      defaultValue: "dist/out.js",
      aliases: ["-o"],
    });
    expect(byName.target).toMatchObject({
      valueType: "string",
      required: false,
      defaultValue: null,
    });
    expect(byName.verbose).toMatchObject({
      valueType: "boolean",
      required: false,
      defaultValue: null,
    });
  });

  it("finds a CAC instance that's never exported, via the construction-capture fallback (through the cac() factory)", async () => {
    const adapter = new CacAdapter();
    const unexported = path.join(__dirname, "..", "__fixtures__", "unexported-eager-cac-cli.js");
    const contract = await adapter.extract(unexported);

    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);
    expect(contract.root.subcommands[0].name).toBe("build");
    expect(contract.root.subcommands[0].options[0]).toMatchObject({ name: "target" });
  });

  it("throws a clear error when no CAC instance is exported", async () => {
    const adapter = new CacAdapter();
    const notACac = path.join(__dirname, "..", "__fixtures__", "not-a-cli.js");
    await expect(adapter.extract(notACac)).rejects.toThrow(/no CAC instance/);
  });
});
