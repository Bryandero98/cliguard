// An ESM Commander.js program with a top-level `await` - not a
// synchronous ESM graph, so it cannot be loaded via `require()` even on a
// Node version that supports requiring plain ESM. Only a real dynamic
// `import()` can load this.
import { Command } from "commander";

await Promise.resolve();

const program = new Command();
program.name("tlacli").description("Top-level-await ESM CLI");

export default program;
