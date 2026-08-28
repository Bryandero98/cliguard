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

  it("finds a Command that's never exported, via the construction-capture fallback", async () => {
    const adapter = new CommanderAdapter();
    const unexported = path.join(__dirname, "..", "__fixtures__", "unexported-eager-cli.js");
    const contract = await adapter.extract(unexported);

    expect(contract.root.name).toBe("mycli");
    expect(contract.root.subcommands).toHaveLength(1);
    expect(contract.root.subcommands[0].name).toBe("build");
    expect(contract.root.subcommands[0].options[0]).toMatchObject({
      name: "target",
      required: true,
    });
  });

  it("throws a clear error when no Command instance is exported", async () => {
    const adapter = new CommanderAdapter();
    const notACli = path.join(__dirname, "..", "__fixtures__", "not-a-cli.js");
    await expect(adapter.extract(notACli)).rejects.toThrow(/no Commander\.js Command instance/);
  });

  it("throws a distinct, non-misleading error when the entry file doesn't exist", async () => {
    const adapter = new CommanderAdapter();
    const missing = path.join(__dirname, "..", "__fixtures__", "does-not-exist.js");
    await expect(adapter.extract(missing)).rejects.toThrow(/no such file/);
    // Must NOT be mistaken for "loaded fine, wrong export shape" - that's
    // a different failure with a different fix (add an export), while
    // this one's fix is a path typo.
    await expect(adapter.extract(missing)).rejects.not.toThrow(/Command instance found/);
  });

  it("surfaces the real syntax error instead of the generic 'no Command instance' message", async () => {
    const adapter = new CommanderAdapter();
    const broken = path.join(__dirname, "..", "__fixtures__", "broken-syntax-cli.js");
    // The real cause (a syntax error) must be visible, not swallowed in
    // favor of the generic message - the fix for "your file has a typo"
    // and "you forgot to export the program" are completely different,
    // and only one of the two is knowable from a caught-and-discarded
    // error.
    await expect(adapter.extract(broken)).rejects.toThrow(/SyntaxError/);
  });

  // Genuine-ESM target CLIs (esm-cli.mjs, esm-top-level-await-cli.mjs) are
  // covered in esm-target-cli.e2e.test.ts, not here: loading them needs a
  // real dynamic import(), and Jest's own VM sandbox intercepts that
  // in-process ("A dynamic import callback was invoked without
  // --experimental-vm-modules") in a way that has nothing to do with
  // whether the adapter itself works. Spawning the built CLI as a real
  // subprocess sidesteps Jest's sandbox and tests the actual shipped
  // artifact instead.
});
