// A real CAC program that never exports its instance anywhere - the
// pattern most real CLIs actually use (tsup's own real, published CLI
// is a close relative of this shape). Constructed eagerly at the top
// level via the `cac()` factory (not deferred inside a function), so
// the adapter's automatic construction-capture fallback should still
// find it - and specifically through the factory function, not `new
// CAC()` directly, since that's the documented, common way to use cac.
const { cac } = require("cac");

const cli = cac("mycli");
cli.command("build <entry>", "Build the project").option("-t, --target <target>", "build target");

module.exports = { hello: "world" };
