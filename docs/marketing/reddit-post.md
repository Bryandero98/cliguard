<!-- For r/node. Title suggested by the spec; body below. -->

# Title: Show r/node: Snapshot testing for CLI contracts

Hey r/node,

I kept hitting the same problem across a few internal tools: someone changes
a CLI flag from optional to required (or renames a subcommand, or quietly
changes a default value), and the first sign anything broke is a pile of
failed CI runs somewhere else that depends on that CLI. REST/GraphQL APIs
have contract testing baked into a lot of pipelines now (Pact, oasdiff, and
friends). CLIs don't really have an equivalent, so I built one: `cliguard`.

**How it works:** `cliguard init <entry.js>` captures your CLI's contract
(commands, flags, defaults, required args) and commits it as a JSON
snapshot. `cliguard check` re-extracts the current surface and diffs it
against the snapshot, classifying every difference as BREAKING / ADDITIVE /
PATCH. Exit code 1 on any BREAKING change - drop it straight into CI.

**The one decision I'd actually like feedback on:** extraction never parses
`--help` output. It loads your CLI's entry file into the Node process and
reads Commander.js's own object graph directly (`command.options`,
`command.commands`, `command.registeredArguments`). I went back and forth on
this - regex-parsing `--help` text would work with *any* language or
framework in theory, but it's fragile (every framework formats help text
slightly differently, and a parsing bug would silently make the tool
useless right when you need it). Introspection means v1 only supports
Commander.js, but every field is guaranteed accurate because it comes
straight from the framework's own data, not a text rendering of it.

The core (the types and the diff engine) has zero knowledge that Commander
exists - there's a `CliAdapter` interface and all the framework-specific
code lives behind it. I've since built a second adapter (CAC) against the
same interface with zero changes to the core, which is a decent sign it's
actually the right boundary - though CAC surfaced one real thing worth
knowing: not every framework's model maps 1:1 onto the contract shape
(CAC has no declarative "this flag is required" concept, for instance),
so an adapter sometimes has to state a real limitation rather than force
a value that isn't there. Yargs is next, and still open if you want to
try implementing one.

Genuinely curious what this sub thinks of the introspection-vs-parsing
tradeoff, and whether the adapter interface looks like something you'd
actually want to build against.

Repo (MIT): https://github.com/Bryandero98/cliguard
