import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Loading a genuine ESM target CLI needs a real dynamic import(), which
// Jest's own VM sandbox intercepts when called in-process (see
// commander-adapter.test.ts). Spawning the built CLI as a real subprocess
// tests the actual artifact users run, with no sandbox in the way -
// this is also the closest thing to how cliguard is really invoked.
const BIN = path.join(__dirname, "..", "..", "dist", "bin.js");
const FIXTURES = path.join(__dirname, "..", "__fixtures__");

function runInFreshDir(args: string[]): { status: number; output: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cliguard-esm-e2e-"));
  try {
    execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: "utf8" });
    return { status: 0, output: "", dir };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}`, dir };
  }
}

describe("CommanderAdapter against a real dynamic import() (subprocess)", () => {
  it("extracts a genuine ESM target CLI (export default, no require/module.exports)", () => {
    const fixture = path.join(FIXTURES, "esm-cli.mjs");
    const { status, dir } = runInFreshDir(["init", fixture]);
    try {
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts an ESM target CLI with a top-level await (not require()-able on any Node version)", () => {
    const fixture = path.join(FIXTURES, "esm-top-level-await-cli.mjs");
    const { status, dir } = runInFreshDir(["init", fixture]);
    try {
      expect(status).toBe(0);
      const contract = JSON.parse(
        readFileSync(path.join(dir, ".cliguard", "contract.json"), "utf8"),
      ) as {
        root: { name: string };
      };
      expect(contract.root.name).toBe("tlacli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
