// A real Commander.js program used as test input for CommanderAdapter -
// exercises named-export resolution, subcommands, aliases, positional
// arguments (required + variadic), and every option shape (boolean,
// string, required, with a default).
const { Command } = require("commander");

const program = new Command();
program.name("mycli").description("Example CLI").version("1.0.0");

program
  .command("build")
  .alias("b")
  .description("Build the project")
  .argument("<entry>", "entry file")
  .argument("[extra...]", "extra files")
  .option("-o, --output <path>", "output file path", "dist/out.js")
  .requiredOption("-t, --target <target>", "build target")
  .option("--verbose", "verbose logging")
  .action(() => {});

module.exports = { program };
