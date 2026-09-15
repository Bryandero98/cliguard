import { existsSync, readFileSync } from "fs";
import path from "path";

import { OclifAdapter } from "../adapters/oclif.adapter";

const MANIFEST_FIXTURE = path.join(__dirname, "..", "__fixtures__", "oclif-manifest.json");
const CACHED_PROJECT_DIR = path.join(__dirname, "..", "__fixtures__", "oclif-project");
const CACHED_MANIFEST_PATH = path.join(CACHED_PROJECT_DIR, "oclif.manifest.json");

describe("OclifAdapter", () => {
  it("extracts a Contract straight from a real oclif manifest JSON file (no subprocess)", async () => {
    const adapter = new OclifAdapter();
    const contract = await adapter.extract(MANIFEST_FIXTURE);

    expect(contract.contractVersion).toBe(1);
    expect(contract.adapter).toBe("oclif");
    // pluginName from the manifest's own commands, since the fixture is a
    // bare .json file with no sibling package.json to prefer instead.
    expect(contract.root.name).toBe("mycli");
  });

  it("rebuilds a nested tree from oclif's flat, colon-separated command ids, synthesizing an empty topic node for one with no command of its own", async () => {
    const adapter = new OclifAdapter();
    const contract = await adapter.extract(MANIFEST_FIXTURE);

    const build = contract.root.subcommands.find((c) => c.name === "build");
    expect(build).toBeDefined();
    expect(build!.description).toBe("Build the project");
    expect(build!.aliases).toEqual(["b"]);

    // "config" itself is never a real command in the fixture - only
    // "config:get" and "config:set" are - so it must appear as an empty
    // synthetic node purely to hold both as children.
    const config = contract.root.subcommands.find((c) => c.name === "config");
    expect(config).toBeDefined();
    expect(config!.description).toBe("");
    expect(config!.subcommands.map((c) => c.name).sort()).toEqual(["get", "set"]);

    const configGet = config!.subcommands.find((c) => c.name === "get")!;
    expect(configGet.description).toBe("Get a config value");
    expect(configGet.arguments).toEqual([
      { name: "key", required: true, variadic: false, description: "config key" },
    ]);
  });

  it("maps every flag shape correctly: short alias, default, boolean, repeatable, and an env var binding", async () => {
    const adapter = new OclifAdapter();
    const contract = await adapter.extract(MANIFEST_FIXTURE);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;
    const byName = Object.fromEntries(build.options.map((o) => [o.name, o]));

    expect(byName.output).toMatchObject({
      aliases: ["-o"],
      valueType: "string",
      required: false,
      defaultValue: "dist/out.js",
    });
    expect(byName.target).toMatchObject({
      aliases: ["-t"],
      valueType: "string",
      required: true,
      defaultValue: null,
    });
    expect(byName.verbose).toMatchObject({
      valueType: "boolean",
      required: false,
      defaultValue: null,
    });
    expect(byName.tag).toMatchObject({
      valueType: "string",
      variadic: true,
    });
    // oclif's own `env:` flag option - the same environment-variable
    // binding Commander/Click adapters surface via OptionContract.envVar.
    expect(byName["api-key"]).toMatchObject({ envVar: "API_KEY" });
    expect(byName.output.envVar).toBeUndefined();
  });

  it("maps positional arguments, including required ones, and always reports variadic: false (documented limitation)", async () => {
    const adapter = new OclifAdapter();
    const contract = await adapter.extract(MANIFEST_FIXTURE);
    const build = contract.root.subcommands.find((c) => c.name === "build")!;

    expect(build.arguments).toEqual([
      { name: "entry", required: true, variadic: false, description: "entry file" },
    ]);
  });

  it("reads an already-committed oclif.manifest.json directly, without ever shelling out to `oclif manifest`", async () => {
    // Deliberately no `oclif`/`@oclif/core` installed anywhere near this
    // fixture directory - if this ever tried to actually run `npx oclif
    // manifest .` here, that subprocess would fail (no such package
    // resolvable), which would fail this test too. Passing means the
    // cached-file branch was taken, exactly as intended for a project
    // that already commits its own manifest.
    expect(existsSync(CACHED_MANIFEST_PATH)).toBe(true);
    const before = readFileSync(CACHED_MANIFEST_PATH, "utf8");

    const adapter = new OclifAdapter();
    const contract = await adapter.extract(CACHED_PROJECT_DIR);

    expect(contract.root.name).toBe("mycli"); // from the fixture's own package.json
    expect(contract.root.subcommands).toHaveLength(1);
    expect(contract.root.subcommands[0].name).toBe("greet");
    expect(contract.root.subcommands[0].options[0]).toMatchObject({
      name: "name",
      defaultValue: "world",
    });

    // Never touched, since it was never this adapter's own to clean up.
    expect(readFileSync(CACHED_MANIFEST_PATH, "utf8")).toBe(before);
  });

  it("throws a clear error naming the path when the entry doesn't exist", async () => {
    const adapter = new OclifAdapter();
    const missing = path.join(__dirname, "..", "__fixtures__", "does-not-exist-oclif");
    await expect(adapter.extract(missing)).rejects.toThrow(/no such file or directory/);
  });

  it("throws a clear error when the target directory has no manifest and can't generate one (no oclif devDependency)", async () => {
    const adapter = new OclifAdapter();
    // Any real directory with no oclif.manifest.json and no "oclif"
    // package resolvable from it - `--no-install` guarantees this fails
    // fast and fully offline instead of ever reaching the network.
    const noOclifDir = path.join(__dirname, "..", "__fixtures__");
    await expect(adapter.extract(noOclifDir)).rejects.toThrow(/oclif manifest/);
  }, 20000);

  it("cleans up the manifest it generates itself, leaving no trace in a project that never committed one", async () => {
    // Same "no oclif installed" directory as above - generation is
    // expected to fail, but the important assertion is that no
    // oclif.manifest.json is ever left behind by the attempt.
    const dir = path.join(__dirname, "..", "__fixtures__");
    const strayManifest = path.join(dir, "oclif.manifest.json");
    const adapter = new OclifAdapter();

    await expect(adapter.extract(dir)).rejects.toThrow();
    expect(existsSync(strayManifest)).toBe(false);
  }, 20000);
});
