// A real yargs program used as test input for YargsAdapter - exercises
// named export resolution, a subcommand with an alias, positional
// arguments (required + variadic), a required option (yargs's own
// `demandOption`, distinct from CAC's fixture, which has no equivalent),
// every option shape (boolean, string with a default, string with no
// default), and one genuinely global option declared outside any command.
const yargs = require("yargs/yargs");

const cli = yargs([])
  .exitProcess(false)
  .fail(() => {})
  .scriptName("mycli")
  .option("config", { alias: "c", describe: "config file path", type: "string" })
  .command(
    ["build <entry> [extra...]", "b"],
    "Build the project",
    (y) =>
      y
        .positional("entry", { describe: "entry file", type: "string" })
        .positional("extra", { describe: "extra files", type: "string" })
        .option("output", {
          alias: "o",
          describe: "output file path",
          type: "string",
          default: "dist/out.js",
        })
        .option("target", { alias: "t", describe: "build target", type: "string" })
        .demandOption("target")
        .option("verbose", { describe: "verbose logging", type: "boolean" }),
    () => {},
  );

module.exports = { cli };
