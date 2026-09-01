# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-08-31

### Added

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
