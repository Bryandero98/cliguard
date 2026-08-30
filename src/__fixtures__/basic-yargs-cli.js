// A real Yargs program used as test input for YargsAdapter - exercises
// named-export resolution, a subcommand with an alias, positional
// arguments (required + variadic), and every option shape (boolean,
// string, required, with a default).
const yargs = require("yargs/yargs");

const cli = yargs([]).scriptName("mycli");

cli.command(["build <entry> [extra..]", "b"], "Build the project", (command) =>
  command
    .positional("entry", { describe: "entry file", type: "string" })
    .positional("extra", { describe: "extra files", type: "string" })
    .option("output", {
      alias: "o",
      type: "string",
      describe: "output file path",
      default: "dist/out.js",
    })
    .option("target", {
      alias: "t",
      type: "string",
      describe: "build target",
      demandOption: true,
    })
    .option("verbose", { type: "boolean", describe: "verbose logging" }),
);

module.exports = { cli };
