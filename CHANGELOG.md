# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `cliguard preview <entry>`: extracts and prints the current CLI's contract
  without writing `.cliguard/contract.json` - useful for sanity-checking a
  new adapter or a target CLI's extraction before committing a baseline.
- `cliguard init --with-ci`: scaffolds `.github/workflows/cliguard.yml`
  (the same workflow the README documents by hand) alongside the baseline
  contract, so wiring up CI is no longer a separate manual step. Never
  overwrites an existing workflow file.
- `cliguard check <entry> --against <ref>`: compares against a git ref's
  committed contract (a branch, tag, or commit sha - e.g. `origin/main`)
  instead of the `.cliguard/contract.json` on disk. Removes the single
  biggest source of CI friction: a PR branch no longer needs its own
  freshly-checked-out baseline file just to run `check`.
- `cliguard doctor [entry]`: lists every registered adapter's real,
  framework-shape limitations (e.g. CAC can't express "this option is
  required"), previously visible only by reading adapter source. With an
  `entry`, also tests real extraction against it and reports a structural
  summary (command/option/argument counts) or the real failure. `CliAdapter`
  gained a `limitations: readonly string[]` field, filled in per adapter.
- `--strict` on `check`/`diff`: enables extra rules for changes that are
  currently silent but can still break an existing caller - today, a pure
  reorder of a command's positional arguments (same names, different
  sequence), which the default name-indexed comparison can't see since it
  never looks at position. Off by default - existing CI configs keep
  today's behavior exactly.
- `cliguard install-hook <entry>`: installs a git `pre-push` (or
  `--hook pre-commit`) hook that runs `cliguard check` automatically -
  catches a breaking change before it ever reaches CI, not just at it.
  Never overwrites an existing hook.
- `cliguard deprecate <entry> <path> --remove-by <version|date>`: schedules
  a command/option/argument for removal ahead of time, committed to
  `.cliguard/deprecations.json`. `check`/`diff` then reclassify that
  path's eventual removal as PATCH instead of BREAKING - but only because
  it was announced in advance; removing something with no prior
  `deprecate` still fails the build exactly as before.

## [0.6.0] - 2026-08-31

### Added

- The GitHub Action now posts (and keeps updated in place, one comment per
  PR) a Markdown summary of the diff as a PR comment - the recommended CI
  path, surfacing exactly what changed where a reviewer already looks,
  instead of only a CI exit code buried in a log. New `comment-on-pr`
  input (default `true`) to opt out; needs `permissions: pull-requests:
  write` on the calling workflow.
- `cliguard diff <old.json> <new.json>`: compares two contract files
  directly - no adapter, no target CLI ever loaded - for diffing two tags'
  committed contracts or reviewing a contract change without a working
  copy of the target CLI. Respects `.cliguard/accepted-breaks.json` and
  exits `1` on an un-acknowledged `BREAKING` change, same as `check`.
- `cliguard accept <entry> <path> --reason "<text>"`: records that a specific
  `BREAKING` change is intentional, in a committed, auditable
  `.cliguard/accepted-breaks.json`. `check` still shows an accepted change
  (as a 🟣 acknowledged line with its reason) but stops counting it toward
  the `BREAKING` total that fails the build - any other, un-accepted
  breaking change still fails CI as normal. `check --json`'s output gains
  a matching `acknowledged`/`reason` per change and a `summary.acknowledgedBreaking` count.
- Release workflow: pushing a `v*` tag now runs the full test matrix, then
  publishes to npm and cuts a GitHub Release with that version's own
  CHANGELOG section as the release notes - publishing was previously a
  manual, easy-to-forget step.
- `CHANGELOG.md`.
- Issue templates (bug report, feature request) and a PR template.
- README badges (npm version, downloads, CI status, license).

## [0.5.0] - 2026-08-31

### Added

- Yargs adapter (`--adapter yargs`). Reads a command's options from a fresh,
  isolated instance rather than the shared one yargs itself builds, since
  yargs has no per-command object tree the way Commander does.

## [0.4.0] - 2026-08-28

### Added

- Automatic construction-capture fallback: when a target CLI never exports
  its Commander/CAC instance, cliguard now patches the exact copy of the
  framework the target file will itself `require()`, so a `new Command()`
  or `cac()` call anywhere in the file's own top-level code is captured
  even though nothing was ever exported.

### Fixed

- CAC's unnamed default command is now labeled `<default>` in diff output
  instead of an empty string.

## [0.3.1] - 2026-08-28

### Fixed

- A target CLI's instance is now detected structurally (duck-typed) rather
  than via `instanceof`, which reliably failed whenever the target resolved
  its own separate copy of `commander`/`cac` - the common case, since
  `npx cliguard` installs into its own isolated location.

## [0.3.0] - 2026-08-28

### Added

- `--json` output for `check`: a machine-readable result (`ok`, `changes`,
  a `summary` count per change type, and a `suggestedBump`) for CI bots,
  dashboards, or any script consuming the result instead of a human.

### Fixed

- User-facing CLI messages are now consistently in English.

## [0.2.0] - 2026-08-28

### Added

- CAC adapter (`--adapter cac`), the first adapter added after Commander -
  proved the `CliAdapter` boundary actually holds a second framework
  without touching the diff engine.

## [0.1.0] - 2026-08-27

### Added

- Initial release: Commander.js adapter, `init`/`check`/`update` commands,
  the framework-agnostic `Contract` format and BREAKING/ADDITIVE/PATCH diff
  classification, and `--version`.

### Fixed

- Entry files are loaded via a real dynamic `import()` rather than a
  TypeScript-rewritten `require()` in disguise, so a genuine ESM target
  (including one with a top-level `await`) loads correctly.
- The diff engine no longer claims a removed option was `required` when it
  wasn't.
- A corrupt `.cliguard/contract.json` now names the file and suggests the
  fix instead of a generic parse error.

[0.6.0]: https://github.com/Bryandero98/cliguard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Bryandero98/cliguard/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Bryandero98/cliguard/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/Bryandero98/cliguard/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Bryandero98/cliguard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Bryandero98/cliguard/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Bryandero98/cliguard/releases/tag/v0.1.0
