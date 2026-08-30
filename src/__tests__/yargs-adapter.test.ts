import path from "path";

import { YargsAdapter } from "../adapters/yargs.adapter";

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-yargs-cli.js");

describe("YargsAdapter", () => {
  it("extracts the root and a subcommand from a real Yargs program", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("yargs");
    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);

    const build = contract.root.subcommands[0];
    expect(build.name).toBe("build");
    expect(build.description).toBe("Build the project");
    expect(build.aliases).toEqual(["b"]);
  });

  it("maps positional arguments, including required and variadic (Yargs' [name..] syntax)", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];

    expect(build.arguments).toEqual([
      { name: "entry", required: true, variadic: false, description: "entry file" },
      { name: "extra", required: false, variadic: true, description: "extra files" },
    ]);
  });

  it("maps every option shape correctly", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    expect(byName.output).toMatchObject({
      valueType: "string",
      required: false,
      variadic: false,
      defaultValue: "dist/out.js",
      aliases: ["-o"],
    });
    expect(byName.target).toMatchObject({
      valueType: "string",
      required: true,
      defaultValue: null,
    });
    expect(byName.verbose).toMatchObject({
      valueType: "boolean",
      required: false,
      defaultValue: null,
    });
  });

  it("finds a Yargs instance that's never exported, via the construction-capture fallback", async () => {
    const adapter = new YargsAdapter();
    const unexported = path.join(__dirname, "..", "__fixtures__", "unexported-eager-yargs-cli.js");
    const contract = await adapter.extract(unexported);

    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);
    expect(contract.root.subcommands[0].name).toBe("build");
    expect(contract.root.subcommands[0].options[0]).toMatchObject({
      name: "target",
      required: true,
    });
  });

  it("throws a clear error when no Yargs instance is exported", async () => {
    const adapter = new YargsAdapter();
    const notAYargs = path.join(__dirname, "..", "__fixtures__", "not-a-cli.js");
    await expect(adapter.extract(notAYargs)).rejects.toThrow(/no Yargs instance/);
  });
});
