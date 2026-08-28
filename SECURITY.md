# Security

## How cliguard handles your code

`cliguard` extracts a CLI's contract by loading its entry file into the
current Node process (`import()`/`require()`) and reading the resulting
object graph - it never parses `--help` text. That means **any top-level
code in the target entry file runs**, exactly as it would if you ran
`node ./bin/cli.js` yourself. This is inherent to how contract extraction
works, not an implementation detail that could be removed - the same is
true of any tool that has to introspect a live framework instance
(`Command`, `CAC`, ...) rather than static source text.

In practice this means:

- Only run `cliguard init`/`check`/`update` against entry files you trust
  the same way you'd trust running them directly - your own project's
  CLI, not an arbitrary file from an untrusted source.
- In CI, this is no different from any other step that runs your own
  `node` scripts (build, test, lint) - the entry file executes with
  whatever permissions the CI job already has.
- cliguard itself never executes network requests, writes outside
  `.cliguard/contract.json`, or shells out to anything other than the
  target entry file's own top-level code.
- If a direct export lookup finds nothing, cliguard tries one more thing
  before giving up: it patches the target's own `commander`/`cac`
  install (resolved from the target file's location, not cliguard's) so
  that a `new Command()` or `cac()` call anywhere in the target's
  top-level code is captured, even when the target never exports the
  result. This doesn't run anything the target wasn't already going to
  run on its own - it only observes construction as a side effect of
  code that executes either way. It also means more of a target's real
  startup path can run than a plain export lookup alone would ever
  reach, including a `.parse()`/`.run()` call some CLIs make eagerly -
  cliguard neutralizes the one sharp edge that creates (a target calling
  `process.exit()` can't kill cliguard's own process or override its
  exit code), but doesn't sandbox anything else the target's code does.

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Bryandero98/cliguard/issues) or,
for something you'd rather not disclose publicly first, use GitHub's
[private vulnerability reporting](https://github.com/Bryandero98/cliguard/security/advisories/new)
for this repository.
