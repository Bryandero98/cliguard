// Throwaway demo CLI, used only to verify the GitHub Action's PR-comment
// behavior end to end in a real workflow run. Not part of cliguard's own
// test suite or public surface - deleted before this test branch merges
// anywhere real.
const { Command } = require("commander");

const program = new Command();
program
  .command("deploy")
  .requiredOption("-e, --env <env>", "target environment")
  .option("--dry-run", "don't actually deploy");

module.exports = { program };
