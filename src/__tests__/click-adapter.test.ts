import path from "path";

import { ClickAdapter } from "../adapters/click.adapter";

const FIXTURE = path.join(__dirname, "..", "__fixtures__", "basic-click-cli.py");

describe("ClickAdapter", () => {
  it("extracts the root group and a nested group from a real Click program", async () => {
    const adapter = new ClickAdapter();
    const contract = await adapter.extract(FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("click");
    expect(contract.root.name).toBe("cli");
    expect(contract.root.description).toBe("Sample root group");
    expect(contract.root.subcommands).toHaveLength(2);

    const build = contract.root.subcommands.find((c) => c.name === "build")!;
    expect(build.description).toBe("Build the project");

    const sub = contract.root.subcommands.find((c) => c.name === "sub")!;
    // Click groups nest arbitrarily deep, unlike CAC's flat command list.
    expect(sub.subcommands).toHaveLength(1);
    expect(sub.subcommands[0].name).toBe("deploy");
  });

  it("maps positional arguments, including required and variadic (nargs=-1)", async () => {
    const adapter = new ClickAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;

    expect(build.arguments).toEqual([
      { name: "target", required: true, variadic: false, description: "" },
      { name: "extra", required: false, variadic: true, description: "" },
    ]);
  });

  it("maps every option shape correctly: required, repeatable (multiple), flag, and choice-with-default", async () => {
    const adapter = new ClickAdapter();
    const contract = await adapter.extract(FIXTURE);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;
    const deploy = contract.root.subcommands
      .find((c) => c.name === "sub")!
      .subcommands.find((c) => c.name === "deploy")!;
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    expect(byName.output).toMatchObject({
      required: true,
      valueType: "string",
      aliases: ["-o"],
      defaultValue: null,
    });
    expect(byName.tag).toMatchObject({
      required: false,
      valueType: "string",
      variadic: true,
    });
    expect(contract.root.options[0]).toMatchObject({
      name: "verbose",
      valueType: "boolean",
      defaultValue: false,
    });
    // A Click Choice option still collapses to "string" - Contract only
    // distinguishes boolean vs. everything else (see the adapter's own
    // documented limitations).
    expect(deploy.options[0]).toMatchObject({
      name: "env",
      valueType: "string",
      defaultValue: "staging",
    });
  });

  it("picks the root group over its own nested subcommands when both are addressable module globals", async () => {
    // basic-click-cli.py has `cli`, `build`, `sub`, and `sub_deploy` all
    // bound at module level (Click's decorator returns the Command object
    // in place of the original function) - the extractor must pick `cli`
    // as the true root, not e.g. `build` just because it was found first.
    const adapter = new ClickAdapter();
    const contract = await adapter.extract(FIXTURE);
    expect(contract.root.name).toBe("cli");
  });

  it("throws a clear error when no Click command is defined in the target file", async () => {
    const adapter = new ClickAdapter();
    const notAClick = path.join(__dirname, "..", "__fixtures__", "not-a-click-cli.py");
    await expect(adapter.extract(notAClick)).rejects.toThrow(/no Click command found/);
  });

  it("throws a clear error, including the Python traceback, on a syntax error in the target file", async () => {
    const adapter = new ClickAdapter();
    const broken = path.join(__dirname, "..", "__fixtures__", "broken-syntax-click-cli.py");
    await expect(adapter.extract(broken)).rejects.toThrow(/SyntaxError/);
  });

  it("throws a clear error naming the file when it doesn't exist", async () => {
    const adapter = new ClickAdapter();
    const missing = path.join(__dirname, "..", "__fixtures__", "does-not-exist.py");
    await expect(adapter.extract(missing)).rejects.toThrow(/no such file/);
  });
});
