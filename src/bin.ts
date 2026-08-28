#!/usr/bin/env node
import { Command } from "commander";

import { CommanderAdapter } from "./adapters/commander.adapter";
import { DiffEngine, type DiffResult } from "./core/diff.engine";
import {
  contractExists,
  getContractDisplayPath,
  readContract,
  writeContract,
} from "./core/storage";
import { ChangeType } from "./core/types";

const adapter = new CommanderAdapter();
const diffEngine = new DiffEngine();

// eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json has no type declarations to import against; require() is the simplest correct read here
const packageJson = require("../package.json") as { version: string };

const program = new Command();
program
  .name("cliguard")
  .description(
    "Snapshot-tests your CLI's contract so you never ship a breaking change by accident.",
  )
  .version(packageJson.version);

program
  .command("init")
  .description("Capture the current CLI surface as the committed contract")
  .argument("<entry>", "path to the target CLI's entry file")
  .action(async (entry: string) => {
    if (contractExists()) {
      console.warn(`El contrato ya existe. Usa "cliguard update" para sobrescribirlo.`);
      process.exit(1);
    }

    const contract = await adapter.extract(entry);
    writeContract(contract);
    console.log(`✅ Contrato de CLI inicializado con éxito en ${getContractDisplayPath()}.`);
  });

program
  .command("check")
  .description("Compare the current CLI surface against the committed contract")
  .argument("<entry>", "path to the target CLI's entry file")
  .action(async (entry: string) => {
    const oldContract = readContract();
    const newContract = await adapter.extract(entry);
    const diff = diffEngine.compare(oldContract, newContract);

    if (diff.length === 0) {
      console.log("✅ El contrato de la CLI está intacto.");
      process.exit(0);
    }

    printDiff(diff);

    const hasBreaking = diff.some((entry) => entry.type === ChangeType.BREAKING);
    process.exit(hasBreaking ? 1 : 0);
  });

program
  .command("update")
  .description("Overwrite the committed contract with the CLI's current surface")
  .argument("<entry>", "path to the target CLI's entry file")
  .action(async (entry: string) => {
    const contract = await adapter.extract(entry);
    writeContract(contract);
    console.log("🔄 Contrato de CLI actualizado con éxito.");
  });

function printDiff(diff: readonly DiffResult[]): void {
  for (const entry of diff) {
    console.log(`${emojiFor(entry.type)} [${entry.path}] ${entry.message}`);
  }
}

function emojiFor(type: ChangeType): string {
  switch (type) {
    case ChangeType.BREAKING:
      return "🔴";
    case ChangeType.PATCH:
      return "🟡";
    case ChangeType.ADDITIVE:
      return "🟢";
    default:
      return "⚪";
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
