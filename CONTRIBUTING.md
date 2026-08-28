# Contributing to cliguard

## Getting set up

```sh
git clone https://github.com/<your-fork>/cliguard.git
cd cliguard
npm install
npm run build
npm test
```

`npm test` runs the whole suite against real fixtures - a real Commander.js
program in `src/__fixtures__/`, real `Contract` objects, no mocking library
anywhere. If you're adding behavior, add a test the same way: a real fixture
or a real (plain-data) `Contract`, not a stubbed-out framework object.

## Before opening a PR

```sh
npm run lint
npm run format
npm test
npm run build
```

All four should pass clean.

## The Adapter Pattern

This is the one architectural rule that matters most in this codebase:
**`src/core/` never knows which CLI framework produced a `Contract`.**

- `src/core/types.ts` defines the framework-agnostic shapes (`Contract`,
  `CommandContract`, `OptionContract`, `ArgumentContract`).
- `src/core/diff.engine.ts` compares two `Contract`s and classifies every
  difference as `BREAKING` / `ADDITIVE` / `PATCH`. It only ever reads those
  agnostic shapes.
- `src/adapters/adapter.interface.ts` defines the one contract every adapter
  must satisfy:

  ```typescript
  export interface CliAdapter {
    readonly id: string;
    extract(entryPath: string): Promise<Contract>;
  }
  ```

- `src/adapters/commander.adapter.ts` and `src/adapters/cac.adapter.ts` are
  the two reference implementations - read both before writing a new one.
  Neither parses `--help` output; every field comes straight from each
  framework's own object graph (Commander: `command.options`,
  `command.commands`, `command.registeredArguments`; CAC: `cli.commands`,
  `cli.globalCommand`, `command.options`, `command.args`). CAC's adapter
  doc comment is also worth reading for how to handle a framework whose
  shape doesn't map onto `Contract` 1:1 (no declarative required-option
  concept, a flat command list instead of a tree) - state the real
  limitation in a comment rather than forcing a fit.
- `src/adapters/load-module.ts` is shared by every adapter - the real
  dynamic `import()` (immune to TypeScript's own rewriting), the Windows
  `file://` URL handling, and the missing-file check all live there once.
  A new adapter should use it rather than reimplementing entry-file
  loading; only "which class am I looking for in the loaded exports" is
  each adapter's own job.
- A framework that isn't a core dependency of cliguard itself (only
  Commander is - CAC is an optional peer dependency, since a project
  targeting Commander has no reason to install it) needs a lazy
  `require()` inside the adapter, not a top-level `import` - see
  `cac.adapter.ts`'s `loadCacClass()` for the pattern, including the error
  message when the package isn't installed.

**The best way to contribute to cliguard is a new adapter.** Commander.js and
CAC are both supported today - Yargs is a real gap (see the
[good first issue](https://github.com/Bryandero98/cliguard/issues)). To add
one:

1. Create `src/adapters/<framework>.adapter.ts` implementing `CliAdapter`,
   using `loadModule` from `load-module.ts` for entry-file loading.
2. Map that framework's own internal representation onto `Contract` -
   introspect real objects/APIs the framework exposes, never regex against
   rendered `--help` text (see rule above). If the framework's own model
   doesn't map cleanly onto some `Contract` field, say so in a comment
   (see CAC's adapter) rather than forcing a value that isn't really there.
3. If the framework isn't already a `dependencies`/`peerDependencies` entry
   in `package.json`, add it as an optional peer dependency (see CAC's
   entry) plus a `devDependency` for tests, and load it lazily inside the
   adapter rather than with a top-level import.
4. Add a real fixture CLI built with that framework under
   `src/__fixtures__/`, and a test file mirroring
   `commander-adapter.test.ts`'s or `cac-adapter.test.ts`'s coverage: root
   + subcommand, every option shape (boolean, required if the framework
   supports it, with a default), required and variadic positional
   arguments, and the "no CLI instance found" error path.
5. Register the new adapter in `src/bin.ts`'s `adapters` map.
6. `src/core/diff.engine.ts` should need **zero** changes - if it does,
   that's a sign the adapter is leaking framework details past the
   `CliAdapter` boundary.

## Code style

- No unnecessary abstraction: a function is fine until a second call site
  actually needs the generalization.
- Comments explain *why*, not *what*.
- Keep framework-specific types (`commander`'s `Command`, `Option`, etc.)
  contained inside their adapter file. Nothing outside `src/adapters/`
  should import a framework package directly.

## License

By contributing, you agree your contributions are licensed under this
repo's [MIT license](./LICENSE).
