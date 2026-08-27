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

- `src/adapters/commander.adapter.ts` is the reference implementation. It's
  the file to read before writing a new adapter - notice that it never
  parses `--help` output; every field comes straight from Commander's own
  object graph (`command.options`, `command.commands`,
  `command.registeredArguments`).

**The best way to contribute to cliguard is a new adapter.** Commander.js is
the only framework supported today - Yargs and CAC are both real gaps (see
the [good first issues](https://github.com/Bryandero98/cliguard/issues)).
To add one:

1. Create `src/adapters/<framework>.adapter.ts` implementing `CliAdapter`.
2. Map that framework's own internal representation onto `Contract` -
   introspect real objects/APIs the framework exposes, never regex against
   rendered `--help` text (see rule above).
3. Add a real fixture CLI built with that framework under
   `src/__fixtures__/`, and a test file mirroring
   `commander-adapter.test.ts`'s coverage: root + subcommand, every option
   shape (boolean, required, with a default), required and variadic
   positional arguments, and the "no CLI instance found" error path.
4. `src/core/diff.engine.ts` and `src/bin.ts` should need **zero** changes -
   if they do, that's a sign the adapter is leaking framework details past
   the `CliAdapter` boundary.

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
