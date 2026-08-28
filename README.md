# cliguard

Snapshot testing for CLI contracts.

## The problem

REST and GraphQL APIs have contract testing (Pact, Specmatic, oasdiff) baked into every serious CI pipeline. CLIs don't. So a CLI's breaking changes ship silently: a flag quietly goes from optional to required, a subcommand gets renamed, a default value changes - and the first place anyone finds out is a Slack message from whoever's automation script just started failing in production.

## The solution

`cliguard` captures your CLI's real contract - every command, flag, default, and required argument - straight from your CLI framework's own object graph, not by parsing `--help` text. Commit that contract like a snapshot test. From then on, `cliguard check` fails your build the moment a change would break an existing caller, and passes straight through anything additive or cosmetic.

```text
🔴 [root -> build -> option[--target]] Option "--target" was removed.
🟢 [root -> build -> option[--dry-run]] New optional option "--dry-run" was added.
```

The first line fails your CI. The second one doesn't - `--dry-run` is new and optional, so nothing that already calls your CLI can break because of it.

## Quick start

```sh
npm install --save-dev cliguard
```

Your CLI's entry file needs to **export** its Commander `Command` instance instead of calling `.parse()` itself:

```js
// bin/cli.js
const { Command } = require("commander");

const program = new Command();
program.command("build").requiredOption("-t, --target <target>", "build target");
// ...

module.exports = { program }; // <- cliguard reads this, never runs it
```

Then:

```sh
# Capture the current contract - commit .cliguard/contract.json
npx cliguard init ./bin/cli.js

# In CI: fail the build on any breaking change
npx cliguard check ./bin/cli.js

# You changed something on purpose? Accept the new contract.
npx cliguard update ./bin/cli.js
```

`cliguard check` exits `1` if it finds even one `BREAKING` change, and `0` otherwise - safe to drop straight into any CI pipeline.

## How changes get classified

| | Removed | Added | Required flipped | Value type / default changed |
|---|---|---|---|---|
| **Command** | 🔴 BREAKING | 🟢 ADDITIVE | - | - |
| **Option / argument** | 🔴 BREAKING | 🟢 ADDITIVE (optional) / 🔴 BREAKING (required) | 🔴 optional→required · 🟡 required→optional | 🔴 BREAKING |
| **Alias** | 🔴 BREAKING | 🟡 PATCH | - | - |
| **Description** | - | - | - | 🟡 PATCH |

Full rules live in [`src/core/diff.engine.ts`](src/core/diff.engine.ts) - it's the one file worth reading if you want to know exactly why something was flagged.

## CI integration

```yaml
# .github/workflows/cliguard.yml
name: CLI contract
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - run: npm ci
      - run: npx cliguard check ./bin/cli.js
```

## Supported frameworks

[Commander.js](https://github.com/tj/commander.js) today - it's what Vue CLI, Prettier, and a large share of the npm CLI ecosystem is built on. The core (types + diff engine) is 100% framework-agnostic by design: every framework-specific detail lives behind the `CliAdapter` interface in [`src/adapters/`](src/adapters/), so adding a new adapter never touches the diffing logic. See the [good first issues](https://github.com/Bryandero98/cliguard/labels/good%20first%20issue) for exactly that.

The current adapter mechanism loads the target CLI's entry file into the Node process (`import()`/`require()`) and reads its object graph directly, so the next targets are other Node frameworks - Yargs and CAC are both open. Cross-language support (Python's Click, Rust's Clap, Go's Cobra) is a real future direction, but needs a different extraction strategy first, since a compiled Clap/Cobra binary can't be `require()`'d into Node the way a JS CLI can - most likely each of those would introspect via a structured `--help` output (some frameworks support a JSON mode) rather than the same in-process approach.

## Roadmap

The CLI and core diffing engine are, and will stay, free and open-source. Planned next: a hosted add-on for teams that want more than a CI exit code - a dashboard with the history of contract changes across releases, and Slack/webhook alerts the moment a breaking change lands. See [issue: Webhook reporter for SaaS integration](https://github.com/Bryandero98/cliguard/issues) for the first building block.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
