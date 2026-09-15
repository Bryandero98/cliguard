# Diff rules

Every check `cliguard` runs against two `Contract`s, exactly as implemented in
[`src/core/diff.engine.ts`](src/core/diff.engine.ts) and covered by
[`src/__tests__/diff-engine.test.ts`](src/__tests__/diff-engine.test.ts) - this
file exists so the rules are readable without opening either one, the same
way [oasdiff documents its ~755 OpenAPI checks](https://github.com/oasdiff/oasdiff)
in a doc separate from its own source. If this file and the diff engine's own
code/tests ever disagree, the code (and its tests) win - open an issue.

`cliguard` doesn't version this rule set independently: it changes alongside
the `cliguard` package version itself (see [CHANGELOG.md](CHANGELOG.md) for
when a rule was added or its severity changed).

## Severities

| Severity | Meaning | Effect on `cliguard check`'s exit code |
|---|---|---|
| 🔴 **BREAKING** | Removes or narrows something an existing caller may already depend on. | Exit `1`, unless acknowledged (see "Escape hatches" below). |
| 🟢 **ADDITIVE** | Purely additive - every existing invocation keeps working exactly as before. | Never fails the build. |
| 🟡 **PATCH** | Cosmetic only (help text, alias reordering with no collision, a narrowing→widening flip like required→optional). | Never fails the build. |

A `Contract`'s own `adapter` or `contractVersion` field changing at all is
also 🔴 **BREAKING** ("the two snapshots aren't comparable"), reported once
at the top of the diff regardless of anything else that changed underneath.

## Commands (including the root command)

| Change | Severity | Why |
|---|---|---|
| Command removed | 🔴 BREAKING | Every invocation of that command stops working entirely. |
| Command added | 🟢 ADDITIVE | Nothing existing is affected by a new command appearing. |
| Description changed | 🟡 PATCH | Help text only - never parsed or relied on programmatically. |
| Alias removed | 🔴 BREAKING | An invocation using that alias (e.g. `mycli b` for `build`) stops working. |
| Alias added | 🟡 PATCH | A new way to invoke an existing command; nothing existing changes. |

## Options (flags)

| Change | Severity | Why |
|---|---|---|
| Option removed | 🔴 BREAKING | Any invocation passing that flag now fails outright. |
| New **required** option added | 🔴 BREAKING | Every existing invocation that doesn't pass it will now fail. |
| New **optional** option added | 🟢 ADDITIVE | Existing invocations are unaffected; the flag is simply new. |
| Optional → required | 🔴 BREAKING | Same reasoning as a new required option - existing callers that omit it now fail. |
| Required → optional | 🟡 PATCH | Strictly more permissive; nothing that worked before stops working. |
| Value type changed (`boolean` ↔ `string`) | 🔴 BREAKING | An invocation passing (or not passing) a value the old way is now parsed differently, or rejected. |
| Became variadic, or stopped being variadic | 🔴 BREAKING | The number of values the flag accepts changed - an existing invocation relying on the old arity may now behave differently or fail. |
| Default value changed | 🔴 BREAKING | Any invocation that never passed the flag (relying on the old default) now silently gets different behavior - the most dangerous kind of change specifically because it produces no parse error. |
| Alias removed (e.g. `-o` dropped from `--output`) | 🔴 BREAKING | An invocation using that short form stops working. |
| Alias added | 🟡 PATCH | A new way to pass an existing flag; nothing existing changes. |
| Environment variable binding removed | 🔴 BREAKING | An invocation that only ever set the env var (never the flag itself) silently stops working - see [Environment variable bindings](#environment-variable-bindings) below. |
| Environment variable binding added | 🟢 ADDITIVE | A new way to satisfy an existing flag; every existing invocation (env-based or not) is unaffected. |
| Environment variable binding renamed | 🔴 BREAKING | From a caller's perspective, indistinguishable from losing the old binding - an invocation relying on the old name stops working even though a new one appears in its place. |
| Description changed | 🟡 PATCH | Help text only. |

### Environment variable bindings

Click's `envvar=`, Commander's `.env()`, and yargs's `.env(prefix)` convention
all let a flag be satisfied from an environment variable instead of the
command line. `OptionContract.envVar` (see
[`src/core/types.ts`](src/core/types.ts)) captures that binding wherever an
adapter can detect it (see each adapter's own `limitations` for exactly what
it can and can't see - CAC and this PoC's Cobra dump command have no such
concept at all, so `envVar` is always absent for those two). Renaming or
dropping this binding is exactly as real and exactly as invisible a breaking
change as removing the flag's short alias would be, which is why it gets its
own three rules above instead of being silently ignored.

## Arguments (positionals)

| Change | Severity | Why |
|---|---|---|
| Argument removed | 🔴 BREAKING | Any invocation supplying that positional now either fails or silently shifts every later positional over by one. |
| New **required** argument added | 🔴 BREAKING | Every existing invocation that doesn't supply it will now fail. |
| New **optional** argument added | 🟢 ADDITIVE | Existing invocations are unaffected. |
| Optional → required | 🔴 BREAKING | Same reasoning as a new required argument. |
| Required → optional | 🟡 PATCH | Strictly more permissive. |
| Became variadic, or stopped being variadic | 🔴 BREAKING | The number of values accepted changed. |
| Description changed | 🟡 PATCH | Help text only. |
| Argument order changed, same names/shapes (`--strict` only) | 🔴 BREAKING | Silent by default - the default, name-indexed comparison can't see position at all - but real for any caller passing values positionally instead of by name. Opt-in via `cliguard check --strict` since most CLIs' own callers pass positionals in the order documented, making this rule noisy for some projects and load-bearing for others. |

## Modifiers - things that reclassify a change above, never a rule of their own

These never introduce a *new* kind of detected change; they only change the
severity (or exit-code effect) already assigned by a rule above.

- **`[unstable]` markers** (`DiffEngine.applyUnstableMarkers`): a command,
  option, or argument whose own description contains the marker string
  (`[unstable]` by default, configurable) has every 🔴 BREAKING change at its
  path downgraded to 🟡 PATCH - inspired by `buf`'s
  `ignore_unstable_packages`. Checked against *both* the old and new
  contract, since a removal only exists in the old one and an
  added-then-changed entry only exists in the new one.
- **`cliguard deprecate`**: a 🔴 BREAKING **removal** (`DiffResult.removal ===
  true`) at a path recorded via `cliguard deprecate` ahead of time is
  downgraded to 🟡 PATCH once it actually happens - an announced removal
  isn't a surprise to whoever depends on it. Only ever touches a removal;
  a different kind of BREAKING change at the same path (e.g. a default value
  change on an option that also happens to be deprecated) is untouched.
- **`cliguard accept`**: doesn't change a change's reported severity at all
  - a 🔴 BREAKING entry stays 🔴 BREAKING in the output - but stops it from
    failing `check`'s exit code once a maintainer has explicitly recorded
    (with a required reason) that it's intentional. The audit trail lives in
    `.cliguard/accepted-breaks.json`, committed to the repo.

## What's deliberately *not* a rule

- `Contract.capturedAt` (an ISO timestamp) is never read by the diff engine
  at all - two contracts that differ only in when they were captured compare
  as identical.
- A command/option's `flags` field (Commander's raw `-o, --output <path>`
  declaration string) is informational only, carried in `Contract` for
  display purposes - never diffed directly. Every actual property it
  encodes (`name`, `aliases`, `valueType`, ...) is diffed individually
  instead, so a purely cosmetic reformatting of that string (spacing,
  argument placeholder wording) produces no diff entry.
