// A genuine ESM Commander.js program - `export default`, no `require`/
// `module.exports` anywhere. Loading this only ever works through a real
// dynamic `import()`; `require()` cannot load it on any Node version.
import { Command } from "commander";

const program = new Command();
program.name("esmcli").description("ESM CLI");

program.command("deploy").option("-e, --env <name>", "target environment");

export default program;
