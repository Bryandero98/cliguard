// A real yargs program that never exports its instance anywhere - the
// pattern most real CLIs actually use. Constructed eagerly at the top
// level via `require("yargs/yargs")(args)` (not deferred inside a
// function), so the adapter's automatic construction-capture fallback
// should still find it - through the factory *call* specifically, since
// yargs's own package export is itself the callable factory (unlike
// commander/cac, which expose a named class/factory property).
const yargs = require("yargs/yargs");

yargs([])
  .exitProcess(false)
  .fail(() => {})
  .scriptName("mycli")
  .command("build <entry>", "Build the project", (y) =>
    y.option("target", { alias: "t", describe: "build target", type: "string" }),
  );

module.exports = { hello: "world" };
