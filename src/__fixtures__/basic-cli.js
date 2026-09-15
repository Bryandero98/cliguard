// A real Commander.js program used as test input for CommanderAdapter -
// exercises named-export resolution, subcommands, aliases, positional
// arguments (required + variadic), every option shape (boolean, string,
// required, with a default), and an option bound to an environment
// variable via Commander's own Option.env().
const { Command, Option } = require("commander");

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
  .addOption(new Option("--api-key <key>", "API key for the deploy service").env("API_KEY"))
  .action(() => {});

module.exports = { program };
