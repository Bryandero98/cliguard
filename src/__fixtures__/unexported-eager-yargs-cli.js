// A real Yargs program that never exports its instance anywhere. The
// adapter's construction-capture fallback should still find an eagerly
// created top-level instance returned by the yargs/yargs factory.
const yargs = require("yargs/yargs");

const cli = yargs([]).scriptName("mycli");
cli.command("build <entry>", "Build the project", (command) =>
  command.option("target", { alias: "t", type: "string", demandOption: true }),
);

module.exports = { hello: "world" };
