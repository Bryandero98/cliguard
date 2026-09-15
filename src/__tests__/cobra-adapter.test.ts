import path from "path";

import { CobraAdapter } from "../adapters/cobra.adapter";

// Points at the PoC example CLI, not a fixture under __fixtures__ - see
// examples/cobra-dump's own doc comments for why it lives there instead
// (it's a real, separately buildable Go module, not a JS/Python snippet).
// Requires a `go` toolchain on PATH; extract() runs it via `go run`.
const EXAMPLE_DIR = path.join(__dirname, "..", "..", "examples", "cobra-dump");

describe("CobraAdapter (PoC - see issue #9)", () => {
  it("extracts the root command and its build subcommand from a real Cobra CLI", async () => {
    const adapter = new CobraAdapter();
    const contract = await adapter.extract(EXAMPLE_DIR);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("cobra");
    expect(contract.root.name).toBe("greet");
    expect(contract.root.description).toBe("A tiny example CLI");
    expect(contract.root.subcommands).toHaveLength(1);

    const build = contract.root.subcommands[0];
    expect(build.name).toBe("build");
    expect(build.aliases).toEqual(["b"]);
  });

  it("never surfaces Cobra's own auto-registered completion/help commands, or the dump command itself", async () => {
    const adapter = new CobraAdapter();
    const contract = await adapter.extract(EXAMPLE_DIR);

    const names = contract.root.subcommands.map((c) => c.name);
    expect(names).not.toContain("completion");
    expect(names).not.toContain("help");
    expect(names).not.toContain("__cliguard_dump__");
  });

  it("maps a required string flag, a boolean flag, and a repeatable (slice) flag correctly", async () => {
    const adapter = new CobraAdapter();
    const contract = await adapter.extract(EXAMPLE_DIR);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    expect(byName.target).toMatchObject({
      required: true,
      valueType: "string",
      aliases: ["-t"],
      variadic: false,
      defaultValue: null,
    });
    // Cobra/pflag has no built-in env var binding - always undefined, see
    // the adapter's own documented limitations.
    expect(byName.target.envVar).toBeUndefined();
    expect(byName.verbose).toMatchObject({
      required: false,
      valueType: "boolean",
      defaultValue: false,
    });
    expect(byName.tag).toMatchObject({
      required: false,
      valueType: "string",
      variadic: true,
    });
  });

  it("reports no arguments - Cobra's Args validators carry no per-argument metadata (documented limitation)", async () => {
    const adapter = new CobraAdapter();
    const contract = await adapter.extract(EXAMPLE_DIR);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;
    expect(build.arguments).toEqual([]);
  });

  it("throws a clear error naming the path when the entry doesn't exist", async () => {
    const adapter = new CobraAdapter();
    const missing = path.join(__dirname, "..", "..", "examples", "does-not-exist");
    await expect(adapter.extract(missing)).rejects.toThrow(/no such file or directory/);
  });
});
