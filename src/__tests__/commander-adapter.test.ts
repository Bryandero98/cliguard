import path from "path";

import { CommanderAdapter } from "../adapters/commander.adapter";

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-cli.js");

describe("CommanderAdapter", () => {
  it("extracts the root command and a subcommand from a real Commander program", async () => {
    const adapter = new CommanderAdapter();
    const contract = await adapter.extract(FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("commander");
    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);

    const build = contract.root.subcommands[0];
    expect(build.name).toBe("build");
    expect(build.aliases).toEqual(["b"]);
  });

  it("maps positional arguments, including required and variadic", async () => {
    const adapter = new CommanderAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];

    expect(build.arguments).toEqual([
      { name: "entry", required: true, variadic: false, description: "entry file" },
      { name: "extra", required: false, variadic: true, description: "extra files" },
    ]);
  });

  it("maps every option shape correctly", async () => {
    const adapter = new CommanderAdapter();
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

  it("throws a clear error when no Command instance is exported", async () => {
    const adapter = new CommanderAdapter();
    const notACli = path.join(__dirname, "..", "__fixtures__", "not-a-cli.js");
    await expect(adapter.extract(notACli)).rejects.toThrow(/no Commander\.js Command instance/);
  });
});
