import type { CliAdapter } from "./adapter.interface";
import { CacAdapter } from "./cac.adapter";
import { ClickAdapter } from "./click.adapter";
import { CommanderAdapter } from "./commander.adapter";
import { YargsAdapter } from "./yargs.adapter";

// Constructing an adapter here is cheap (no eager require of its
// framework - CacAdapter/YargsAdapter only load their framework lazily,
// inside extract()), so every adapter is always registered regardless of
// which one a given caller actually uses. Shared by bin.ts (the CLI) and
// index.ts (the programmatic API) so both agree on exactly the same set
// of adapters under exactly the same names, rather than two registries
// that could silently drift apart.
export const adapters: Readonly<Record<string, CliAdapter>> = {
  commander: new CommanderAdapter(),
  cac: new CacAdapter(),
  yargs: new YargsAdapter(),
  click: new ClickAdapter(),
};

export function resolveAdapter(name: string): CliAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(
      `cliguard: unknown adapter "${name}". Available: ${Object.keys(adapters).join(", ")}.`,
    );
  }
  return adapter;
}
