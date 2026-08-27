<!-- Draft for Dev.to / Hashnode. -->

# CLI Snapshot Testing: Stop Your Internal Tools From Breaking Everyone Else's Pipeline

## The pain

Every team with more than a couple of engineers ends up with at least one
internal CLI - a deploy script, a codegen tool, a scaffold generator,
something wrapping three other tools into one command. It starts small.
Then other repos start depending on it in their own CI pipelines, other
scripts start shelling out to it, and at some point it quietly becomes
load-bearing infrastructure that nobody explicitly signed up to maintain a
compatibility promise for.

Then someone - reasonably, with good intentions - notices that a flag
really *should* be required, or that a subcommand name doesn't match the
new naming convention, and changes it. It merges clean. Tests pass, because
the CLI's own tests only ever tested its own repo. Twenty minutes later,
three other teams' CI pipelines are red, and nobody connects the dots for
another hour because the error is "missing required argument," not "your
CLI's contract changed."

REST APIs stopped having this problem years ago - most serious API teams
run some flavor of contract testing (Pact, Specmatic, oasdiff) as a matter
of course, specifically to catch exactly this class of accidental breaking
change before it ships. CLIs never got the equivalent tooling, even though
the failure mode is identical: a public interface changed shape, and
whoever depends on that interface found out the hard way.

## How CLI snapshotting works

The idea behind [`cliguard`](https://github.com/Bryandero98/cliguard) is
the same one behind Jest's snapshot tests, applied to a CLI's public
surface instead of a rendered component:

1. **Capture.** `cliguard init` extracts your CLI's full contract - every
   command, subcommand, flag (with its type, default, and whether it's
   required), and positional argument - and writes it to
   `.cliguard/contract.json`. You commit that file like any other snapshot.
2. **Check.** On every PR, `cliguard check` re-extracts the *current*
   surface and diffs it against the committed contract. Every difference
   gets classified:
   - 🔴 **BREAKING** - something was removed, an optional thing became
     required, a default or value type changed.
   - 🟢 **ADDITIVE** - a new optional command/flag/argument was added.
     Nothing that already calls your CLI can break because of it.
   - 🟡 **PATCH** - cosmetic only (a description changed, an alias was
     added, something required became optional).
3. **Fail loud, in the right place.** `cliguard check` exits `1` the moment
   it finds even one `BREAKING` change. That failure shows up on the PR
   that introduced it - not as a mystery failure in someone else's
   pipeline three hours later.

The part worth calling out specifically: extraction never parses rendered
`--help` text with regular expressions. It loads your CLI's entry file into
the Node process and reads the framework's own object graph directly - for
Commander.js, that's `command.options`, `command.commands`, and
`command.registeredArguments`. Every field in the contract is guaranteed to
match what the framework will actually do at runtime, because it *is* what
the framework will do at runtime, not a text rendering of it that has to be
parsed back apart.

## Quick tutorial

Your CLI's entry file needs to export its Commander `Command` instance
instead of calling `.parse()` on it directly:

```js
// bin/cli.js
const { Command } = require("commander");

const program = new Command();
program
  .command("build")
  .requiredOption("-t, --target <target>", "build target");
// ...

module.exports = { program }; // cliguard reads this - it never runs your CLI
```

Install it as a dev dependency:

```sh
npm install --save-dev cliguard
```

Capture the baseline and commit it:

```sh
npx cliguard init ./bin/cli.js
git add .cliguard/contract.json
git commit -m "chore: add cliguard contract"
```

Wire the check into CI:

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

Now, the moment a PR removes a flag, flips one from optional to required,
or changes a default value, the build fails right there with exactly what
changed and where:

```text
🔴 [root -> build -> option[--target]] Required option "--target" was removed.
```

And when you add something new and safe, the check passes straight
through:

```text
🟢 [root -> build -> option[--dry-run]] New optional option "--dry-run" was added.
```

When you make an intentional breaking change - a real major version bump -
just accept the new contract:

```sh
npx cliguard update ./bin/cli.js
```

## Where it's headed

`cliguard` only supports Commander.js today, on purpose - the core (the
contract types and the diff engine) is 100% framework-agnostic, with every
framework-specific detail behind a small `CliAdapter` interface. Yargs and
CAC adapters are open [good first issues](https://github.com/Bryandero98/cliguard/issues)
if you want to try implementing one.

Repo (MIT): https://github.com/Bryandero98/cliguard
