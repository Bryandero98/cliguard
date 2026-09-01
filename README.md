# cliguard

[![npm version](https://img.shields.io/npm/v/cliguard.svg)](https://www.npmjs.com/package/cliguard)
[![npm downloads](https://img.shields.io/npm/dm/cliguard.svg)](https://www.npmjs.com/package/cliguard)
[![CI](https://github.com/Bryandero98/cliguard/actions/workflows/ci.yml/badge.svg)](https://github.com/Bryandero98/cliguard/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cliguard.svg)](https://github.com/Bryandero98/cliguard/blob/main/LICENSE)

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

Point cliguard straight at your existing CLI's entry file - most real CLIs work unmodified, since cliguard automatically captures the framework instance they build at load time even if they never export it (see "Entry files that build the CLI lazily" below). Exporting the instance is still the cleanest way to adopt cliguard where you can, since it never risks running any of your CLI's real logic:

```js
// bin/cli.js
const { Command } = require("commander");

const program = new Command();
program.command("build").requiredOption("-t, --target <target>", "build target");
// ...

module.exports = { program }; // <- cliguard reads this, never runs it
```

ESM entry files work the same way - `export default program` (or a named export) instead of `module.exports`. cliguard loads your entry through a real dynamic `import()`, so this works even for a target CLI with a top-level `await`.

Built with [CAC](https://github.com/cacjs/cac) instead? Export the `CAC` instance the same way (`module.exports = { cli }` / `export default cli`) and pass `--adapter cac`:

```js
// bin/cli.js
const { cac } = require("cac");

const cli = cac("mycli");
cli.command("build <entry>", "build target").option("-t, --target <target>", "build target");

module.exports = { cli };
```

```sh
npx cliguard init ./bin/cli.js --adapter cac
```

`cac` itself is an optional dependency of cliguard - only installed if you actually use `--adapter cac`.

Built with [Yargs](https://github.com/yargs/yargs) instead? Export the instance the same way and pass `--adapter yargs`:

```js
// bin/cli.js
const yargs = require("yargs/yargs");

const cli = yargs([])
  .command("build <entry>", "build the project", (y) =>
    y.option("target", { alias: "t", describe: "build target", type: "string" }).demandOption("target"),
  );

module.exports = { cli };
```

```sh
npx cliguard init ./bin/cli.js --adapter yargs
```

Like `cac`, `yargs` itself is an optional dependency of cliguard - only installed if you actually use `--adapter yargs`.

### Entry files that build the CLI lazily

Not every real CLI exports its instance - plenty build it inside a function that only runs when something actually calls it, or just never had a reason to export it. Pointing cliguard straight at a file like that would fail with "no instance found" under the rule above alone.

So when the direct export lookup finds nothing, cliguard tries one more thing automatically, no flag needed: it patches the exact copy of `commander`/`cac`/`yargs` your entry file will itself `require()`, so any `new Command()` (or CAC's `cac()`, or a `yargs(...)` call) anywhere in your file's own top-level code is captured - even though nothing was ever exported. This covers most real CLIs, since even ones that never bother exporting still build (and often `.parse()`) at the top of their own file as a matter of course.

It can't reach an instance built strictly *inside* a function that's only invoked later, never automatically at load time (a `main()` some other file calls, not the file cliguard is pointed at) - there's no safe, generic way for cliguard to know which function to call or with what arguments. For that shape, write a small wrapper file that reaches into the target's own internals to get (or construct) the instance, and point cliguard at the wrapper instead of the original entry file. The exact shape of that wrapper is inherently project-specific - it's standing in for whatever that project's own entry point would otherwise do - but the command stays the same either way: `cliguard init ./your-wrapper.mjs`.

Either way, if the target's top-level code has its own real side effects when loaded - a `.parse()` call that matches a real command and runs it, a network request, spawning a process - running cliguard against it (directly or through a wrapper) triggers those too, exactly as `node ./bin/cli.js` would. cliguard neutralizes one specific danger this creates (a target calling `process.exit()` can't kill cliguard's own process or override its exit code), but doesn't sandbox anything else - see [SECURITY.md](./SECURITY.md).

Then:

```sh
# Capture the current contract - commit .cliguard/contract.json
npx cliguard init ./bin/cli.js

# Same, plus scaffold .github/workflows/cliguard.yml so CI is wired up too
npx cliguard init ./bin/cli.js --with-ci

# In CI: fail the build on any breaking change
npx cliguard check ./bin/cli.js

# You changed something on purpose? Accept the new contract.
npx cliguard update ./bin/cli.js
```

`cliguard check` exits `1` if it finds even one `BREAKING` change, and `0` otherwise - safe to drop straight into any CI pipeline.

Pass `--json` to `check` for a machine-readable result instead of the emoji lines above - useful for a bot that comments on the PR, a dashboard, or any other script consuming the result instead of a human reading it:

```sh
npx cliguard check ./bin/cli.js --json
```

```json
{
  "ok": false,
  "changes": [
    { "type": "BREAKING", "path": "root -> build -> option[--target]", "message": "Option \"--target\" was removed." }
  ],
  "summary": { "breaking": 1, "acknowledgedBreaking": 0, "additive": 0, "patch": 0 },
  "suggestedBump": "major"
}
```

`suggestedBump` is the semver bump this diff implies (`"major"`, `"minor"`, `"patch"`, or `null` if nothing changed) - a direct read of the same BREAKING/ADDITIVE/PATCH classification the emoji output already uses, so a release script never has to re-derive it.

### Comparing against a git ref instead of a local file

`check` normally diffs against `.cliguard/contract.json` on disk, but a CI runner checking out a PR branch often doesn't have a freshly-updated one - `--against <ref>` reads the contract straight out of git instead, no local file required:

```sh
npx cliguard check ./bin/cli.js --against origin/main
```

Works with any ref `git show` understands - a branch, a tag, a commit sha. Combine with `--json` the same way as the file-based path.

### Accepting an intentional breaking change

Sometimes a `BREAKING` change is exactly what you meant to ship - a flag genuinely needed to go away in a major version. Running `cliguard update` after a real, intentional break re-baselines the *entire* contract silently; it doesn't leave a record of what changed or why. `cliguard accept` does:

```sh
npx cliguard accept ./bin/cli.js "root -> build -> option[--target]" --reason "removed in v2.0, replaced by --targets"
```

This only works against a change `check` would currently report as `BREAKING` - it reads the exact `path` from your own `check` output (text or `--json`), so there's nothing to guess. It writes `.cliguard/accepted-breaks.json` (commit this file); from then on, `check` still shows that change - now as a 🟣 acknowledged line with the reason attached - but stops counting it toward the `BREAKING` total that fails your build. Any *other*, un-accepted breaking change still fails CI as normal. Once you're done, `cliguard update` still re-baselines the contract to match reality, same as always.

### Deprecating something ahead of its removal

`accept` forgives a break that already happened. `deprecate` is the other half - announce a removal *before* it happens, so when it eventually does, it's a PATCH instead of a BREAKING change:

```sh
# The option still exists today - deprecate marks it for a future removal
npx cliguard deprecate ./bin/cli.js "root -> build -> option[--target]" \
  --remove-by 2.0.0 --reason "replaced by --targets"
```

This only works against a path that currently exists (it reads the same `path` shape `check`/`accept` use) - it writes `.cliguard/deprecations.json` (commit this file). From then on, whenever that command/option/argument actually gets removed, `check` reports it as PATCH, with the deprecation's reason and `--remove-by` folded into the message, instead of failing the build. Removing anything that was never deprecated first still fails exactly as before - deprecation has to be announced ahead of the break, not applied retroactively.

`--remove-by` is informational only (a version or a date, whichever fits your release process) - cliguard never checks it against the clock or your `package.json` version, it's just carried through into the message so whoever's reading a changelog or a PR comment knows the plan.

### Comparing two contracts directly

`cliguard diff <old.json> <new.json>` runs the same comparison as `check`, but reads both sides straight off disk instead of running any CLI - useful for comparing two tags' committed contracts (`git show v1.0.0:.cliguard/contract.json > old.json`), or reviewing a contract change in a PR without a working copy of the target CLI at all:

```sh
npx cliguard diff old-contract.json new-contract.json --json
```

It respects `.cliguard/accepted-breaks.json` the same way `check` does, and exits `1` on an un-acknowledged `BREAKING` change.

### Previewing a contract without committing it

`cliguard preview <entry>` runs the same extraction `init` would, but prints the contract to stdout instead of writing `.cliguard/contract.json` - useful for sanity-checking what a new adapter or a lazily-built target CLI actually captures before you commit to it as the baseline:

```sh
npx cliguard preview ./bin/cli.js --adapter yargs
```

### Catching a breaking change before it reaches CI

`cliguard install-hook <entry>` installs a git hook (`pre-push` by default) that runs `cliguard check` automatically, so a breaking change is caught locally instead of waiting for CI to say so:

```sh
npx cliguard install-hook ./bin/cli.js
# or, to gate every commit instead of every push:
npx cliguard install-hook ./bin/cli.js --hook pre-commit
```

Never overwrites a hook that's already there - if you're already using [husky](https://typicode.github.io/husky/) or a similar tool, add the same `npx cliguard check ...` line to your existing hook instead.

### `--strict`: catching changes the default rules can't see

The default rules match commands/options/arguments by name, so a change that keeps every name the same is invisible to them - even when it can still break a caller. `--strict` adds rules for exactly that gap. Today, one: a pure reorder of a command's positional arguments.

```js
// before
program.command("copy").argument("<src>").argument("<dest>");
// after - same two arguments, swapped order
program.command("copy").argument("<dest>").argument("<src>");
```

The default rules see no change at all here (`<src>` still exists, `<dest>` still exists). But `cli copy a.txt b.txt` now copies `b.txt` over `a.txt`, not the reverse - a real, silent break for anyone calling it positionally:

```sh
npx cliguard check ./bin/cli.js --strict
```

Off by default so it never changes behavior for an existing CI config - opt in per project.

## How changes get classified

| | Removed | Added | Required flipped | Value type / default changed |
|---|---|---|---|---|
| **Command** | 🔴 BREAKING | 🟢 ADDITIVE | - | - |
| **Option / argument** | 🔴 BREAKING | 🟢 ADDITIVE (optional) / 🔴 BREAKING (required) | 🔴 optional→required · 🟡 required→optional | 🔴 BREAKING |
| **Alias** | 🔴 BREAKING | 🟡 PATCH | - | - |
| **Description** | - | - | - | 🟡 PATCH |

Full rules live in [`src/core/diff.engine.ts`](src/core/diff.engine.ts) - it's the one file worth reading if you want to know exactly why something was flagged.

## CI integration

`cliguard init --with-ci` scaffolds the workflow below for you - `git add .github/workflows/cliguard.yml` and you're done. Prefer to see it first, or wire it up by hand? Read on.

The bundled GitHub Action (`Bryandero98/cliguard@v1`) is the recommended way to run this in CI: on top of the same exit-code gate as `npx cliguard check`, it posts the diff as a PR comment - updated in place on every push, not a new one each time - so a reviewer sees exactly what changed without opening the CI log:

```yaml
# .github/workflows/cliguard.yml
name: CLI contract
on: [pull_request]
permissions:
  pull-requests: write # needed for the PR comment
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - run: npm ci
      - uses: Bryandero98/cliguard@v1
        with:
          entry: ./bin/cli.js
          # adapter: yargs        # default: commander
          # comment-on-pr: false  # default: true
```

Set `comment-on-pr: false` to keep the exit-code gate without the comment, or use the raw CLI directly for a non-GitHub CI provider:

```yaml
- run: npx cliguard check ./bin/cli.js
```

## Supported frameworks

[Commander.js](https://github.com/tj/commander.js) (default), [CAC](https://github.com/cacjs/cac) (`--adapter cac`), and [Yargs](https://github.com/yargs/yargs) (`--adapter yargs`) today. The core (types + diff engine) is 100% framework-agnostic by design: every framework-specific detail lives behind the `CliAdapter` interface in [`src/adapters/`](src/adapters/), so adding a new adapter never touches the diffing logic. Click, Clap, and Cobra are the next open gaps - see the [good first issue](https://github.com/Bryandero98/cliguard/labels/good%20first%20issue).

A couple of `OptionContract`/`ArgumentContract` fields carry real, framework-specific limitations rather than a mapping gap - see [`src/adapters/cac.adapter.ts`](src/adapters/cac.adapter.ts)'s own doc comment for exactly which ones and why (CAC has no declarative "this flag must be passed" concept, and no per-argument description). Yargs's own real limitation is the opposite kind - see [`src/adapters/yargs.adapter.ts`](src/adapters/yargs.adapter.ts)'s doc comment for why each command's options are read from a fresh, isolated instance rather than the shared one the target CLI actually built.

The current adapter mechanism loads the target CLI's entry file into the Node process (`import()`/`require()`) and reads its object graph directly, so the next targets are other Node frameworks. Cross-language support (Python's Click, Rust's Clap, Go's Cobra) is a real future direction, but needs a different extraction strategy first, since a compiled Clap/Cobra binary can't be `require()`'d into Node the way a JS CLI can - most likely each of those would introspect via a structured `--help` output (some frameworks support a JSON mode) rather than the same in-process approach.

## Security

Extracting a contract runs the target entry file's own top-level code, the same as `node ./bin/cli.js` would - see [SECURITY.md](./SECURITY.md) for what that means in practice.

## Roadmap

The CLI and core diffing engine are, and will stay, free and open-source. Planned next: a hosted add-on for teams that want more than a CI exit code - a dashboard with the history of contract changes across releases, and Slack/webhook alerts the moment a breaking change lands. See [issue: Webhook reporter for SaaS integration](https://github.com/Bryandero98/cliguard/issues) for the first building block.

## Support this project

cliguard is free and will stay free. If it's saving you from a broken release, a small tip helps keep it going:

- **Ko-fi:** [ko-fi.com/bryandero98](https://ko-fi.com/bryandero98)
- **USDT (TRC20):** `TEG4Kk2qXYMQ4mHNd7dPhSPRyT14CGr2or` — double-check the network is set to **TRC20** before sending; a transfer on the wrong network can't be recovered.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE)
