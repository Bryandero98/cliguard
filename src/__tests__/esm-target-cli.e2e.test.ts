import { readFileSync } from "fs";
import path from "path";

import { makeTempDir, runCli } from "../test-helpers/run-cli";

// Loading a genuine ESM target CLI needs a real dynamic import(), which
// Jest's own VM sandbox intercepts when called in-process (see
// commander-adapter.test.ts). Spawning the built CLI as a real subprocess
// tests the actual artifact users run, with no sandbox in the way -
// this is also the closest thing to how cliguard is really invoked.
const FIXTURES = path.join(__dirname, "..", "__fixtures__");

describe("CommanderAdapter against a real dynamic import() (subprocess)", () => {
  it("extracts a genuine ESM target CLI (export default, no require/module.exports)", () => {
    const fixture = path.join(FIXTURES, "esm-cli.mjs");
    const { dir, cleanup } = makeTempDir();
    try {
      const { status } = runCli(dir, ["init", fixture]);
      expect(status).toBe(0);
      const contract = JSON.parse(
        readFileSync(path.join(dir, ".cliguard", "contract.json"), "utf8"),
      ) as {
        root: { name: string; subcommands: { name: string }[] };
      };
      expect(contract.root.name).toBe("esmcli");
      expect(contract.root.subcommands).toHaveLength(1);
      expect(contract.root.subcommands[0].name).toBe("deploy");
    } finally {
      cleanup();
    }
  });

  it("extracts an ESM target CLI with a top-level await (not require()-able on any Node version)", () => {
    const fixture = path.join(FIXTURES, "esm-top-level-await-cli.mjs");
    const { dir, cleanup } = makeTempDir();
    try {
      const { status } = runCli(dir, ["init", fixture]);
      expect(status).toBe(0);
      const contract = JSON.parse(
        readFileSync(path.join(dir, ".cliguard", "contract.json"), "utf8"),
      ) as {
        root: { name: string };
      };
      expect(contract.root.name).toBe("tlacli");
    } finally {
      cleanup();
    }
  });
});
