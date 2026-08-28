// A real Commander.js program that never exports its Command instance
// anywhere - the pattern most real CLIs actually use, since they have no
// reason to export it themselves. Constructed eagerly at the top level
// (not deferred inside a function), so the adapter's automatic
// construction-capture fallback should still find it.
const { Command } = require("commander");

const program = new Command();
program.name("mycli").description("Example CLI").version("1.0.0");

program
  .command("build")
  .description("Build the project")
  .requiredOption("-t, --target <target>", "build target")
  .action(() => {});

module.exports = { hello: "world" };
