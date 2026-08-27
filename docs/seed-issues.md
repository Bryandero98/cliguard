# Seed issues

Templates to file as real GitHub issues once the repo is public. Delete this
file (or move it to actual issues) once they're filed.

---

## 1. `[Feature] Yargs Adapter`

**Labels:** `good first issue`, `help wanted`, `enhancement`

**Body:**

cliguard's core (`src/core/types.ts`, `src/core/diff.engine.ts`) is 100%
framework-agnostic - every framework-specific detail is meant to live behind
the `CliAdapter` interface in
[`src/adapters/adapter.interface.ts`](../src/adapters/adapter.interface.ts):

```typescript
export interface CliAdapter {
  readonly id: string;
  extract(entryPath: string): Promise<Contract>;
}
```

Right now [Commander.js](https://github.com/tj/commander.js) is the only
supported framework, via
[`src/adapters/commander.adapter.ts`](../src/adapters/commander.adapter.ts).
[Yargs](https://github.com/yargs/yargs) is a huge share of the remaining
Node CLI ecosystem and has no adapter yet.

**What's needed:**

- `src/adapters/yargs.adapter.ts` implementing `CliAdapter`, mapping a Yargs
  instance's own internal command/option graph onto `Contract` -
  `CommandContract`, `OptionContract`, `ArgumentContract` from
  `src/core/types.ts`. No `--help` text parsing, same rule the Commander
  adapter follows.
- A real fixture CLI built with Yargs under `src/__fixtures__/`.
- A test file mirroring `src/__tests__/commander-adapter.test.ts`'s
  coverage: root + subcommand, every option shape, required and variadic
  positional arguments, and the "no CLI instance found" error path.

`src/core/diff.engine.ts` and `src/bin.ts` should need zero changes - if
they do, that's a sign the adapter is leaking Yargs-specific details past
the `CliAdapter` boundary. See [CONTRIBUTING.md](../CONTRIBUTING.md#the-adapter-pattern)
for the full walkthrough.

---

## 2. `[Feature] CAC Adapter`

**Labels:** `good first issue`, `help wanted`, `enhancement`

**Body:**

Same shape of task as the Yargs adapter (see that issue for the full
`CliAdapter` contract and reference implementation), targeting
[CAC](https://github.com/cacjs/cac) - a smaller, increasingly popular
Commander alternative used by tools like Vite's own CLI tooling in the past
and several modern Node CLIs.

**What's needed:**

- `src/adapters/cac.adapter.ts` implementing `CliAdapter`, mapping a CAC
  instance's commands/options onto `Contract` via CAC's own object graph
  (check its `cli.commands`, each `Command`'s `.options`, etc. - CAC's
  internals are simpler than Commander's, which makes this a good
  first adapter to attempt if you haven't touched the codebase before).
- A real fixture CLI built with CAC under `src/__fixtures__/`.
- A test file mirroring `src/__tests__/commander-adapter.test.ts`'s
  coverage.

As with the Yargs adapter: `src/core/` and `src/bin.ts` should need no
changes at all.

---

## 3. `[Roadmap] Webhook reporter for SaaS integration`

**Labels:** `roadmap`, `enhancement`

**Body:**

Today `cliguard check` only prints to the terminal and sets an exit code.
That's enough for CI, but a team that wants Slack alerts or a historical
dashboard of contract changes across releases currently has to scrape
stdout.

**Proposal:** a reporter that takes the `DiffResult[]` array
`DiffEngine.compare()` already produces (see
[`src/core/diff.engine.ts`](../src/core/diff.engine.ts)) and POSTs it as
JSON to a configurable webhook URL - e.g. a new `--webhook <url>` flag on
`cliguard check`, or a `CLIGUARD_WEBHOOK_URL` environment variable read in
`src/bin.ts`.

This is intentionally scoped small for v1: serialize the existing
`DiffResult[]` (type, path, message) plus which entry file and repo/commit
it ran against, and POST it. No new dependencies needed for a basic
`fetch`-based POST.

This is the first building block toward a hosted dashboard / Slack
integration - see the README's roadmap section - but this issue is just the
webhook POST itself, not the receiving service.
