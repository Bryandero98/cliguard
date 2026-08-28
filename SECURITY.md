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

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/Bryandero98/cliguard/issues) or,
for something you'd rather not disclose publicly first, use GitHub's
[private vulnerability reporting](https://github.com/Bryandero98/cliguard/security/advisories/new)
for this repository.
