import path from "path";

import { YargsAdapter } from "../adapters/yargs.adapter";

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-yargs-cli.js");

describe("YargsAdapter", () => {
  it("extracts the root and a subcommand from a real yargs program", async () => {
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

  it("maps a genuinely global option onto the root, separate from any command", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);

    expect(contract.root.options).toEqual([
      expect.objectContaining({ name: "config", aliases: ["-c"], valueType: "string" }),
    ]);
  });

  it("maps positional arguments, including required and variadic", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];

    expect(build.arguments).toEqual([
      { name: "entry", required: true, variadic: false, description: "entry file" },
      { name: "extra", required: false, variadic: true, description: "extra files" },
    ]);
  });

  it("maps every option shape correctly, including yargs's own demandOption as required: true", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    expect(byName.output).toMatchObject({
      valueType: "string",
      required: false,
      defaultValue: "dist/out.js",
      aliases: ["-o"],
    });
    expect(byName.target).toMatchObject({
      valueType: "string",
      required: true,
      defaultValue: null,
      aliases: ["-t"],
    });
    expect(byName.verbose).toMatchObject({
      valueType: "boolean",
      required: false,
      defaultValue: null,
    });
  });

  it("never leaks a positional name, an alias's own key, or help/version into the options list", async () => {
    const adapter = new YargsAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands[0];
    const names = build.options.map((o) => o.name);

    expect(names).not.toContain("entry");
    expect(names).not.toContain("extra");
    expect(names).not.toContain("o");
    expect(names).not.toContain("t");
    expect(names).not.toContain("help");
    expect(names).not.toContain("version");
    expect(names.sort()).toEqual(["output", "target", "verbose"]);
  });

  it("finds a yargs instance that's never exported, via the construction-capture fallback (through require('yargs/yargs') called as a function)", async () => {
    const adapter = new YargsAdapter();
    const unexported = path.join(__dirname, "..", "__fixtures__", "unexported-eager-yargs-cli.js");
    const contract = await adapter.extract(unexported);

    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);
    expect(contract.root.subcommands[0].name).toBe("build");
    expect(contract.root.subcommands[0].options[0]).toMatchObject({ name: "target" });
  });

  it("throws a clear error when no yargs instance is exported", async () => {
    const adapter = new YargsAdapter();
    const notACli = path.join(__dirname, "..", "__fixtures__", "not-a-cli.js");
    await expect(adapter.extract(notACli)).rejects.toThrow(/no yargs instance/);
  });
});
