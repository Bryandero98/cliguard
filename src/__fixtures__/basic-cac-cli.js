// A real CAC program used as test input for CacAdapter - exercises named
// export resolution, a subcommand with an alias, positional arguments
// (required + variadic, using CAC's own `[...name]` variadic syntax,
// which differs from Commander's `[name...]`), and every option shape
// (boolean, string with a default, string with no default).
const { cac } = require("cac");

const cli = cac("mycli");

cli
  .command("build <entry> [...extra]", "Build the project")
  .alias("b")
  .option("-o, --output <path>", "output file path", { default: "dist/out.js" })
  .option("-t, --target <target>", "build target")
  .option("--verbose", "verbose logging")
  .action(() => {});

module.exports = { cli };
