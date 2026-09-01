**What this changes and why**

**Checklist**

- [ ] `npm test` passes (real fixtures, not mocked framework internals - see [CONTRIBUTING.md](CONTRIBUTING.md))
- [ ] `npm run lint` passes
- [ ] If this is a new adapter: a real fixture CLI under `src/__fixtures__/`, and a test file covering root + subcommand, every option shape, required/variadic positionals, and the "no instance found" error path
- [ ] If this changes `Contract` or diff classification: `src/core/diff.engine.ts` still needs **zero** framework-specific changes
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
