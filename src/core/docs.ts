import type { ArgumentContract, CommandContract, Contract, OptionContract } from "./types";

/**
 * Renders a Contract as Markdown CLI reference docs - one section per
 * command, an arguments table and an options table for each. Walks the
 * same recursive `CommandContract` tree `diff.engine.ts` walks, so a
 * command that `check` can already see is a command these docs can already
 * render; nothing here reads a live CLI or a specific adapter.
 *
 * The point of generating this from the Contract rather than hand-writing
 * it: the moment the docs would go stale, `check` already fails CI for the
 * same underlying reason (the CLI's surface changed) - these docs literally
 * cannot drift from reality without cliguard itself catching it first.
 */
export function renderMarkdownDocs(contract: Contract, fallbackTitle: string): string {
  const title = contract.root.name || fallbackTitle;
  const lines: string[] = [`# ${title}`, ""];
  if (contract.root.description) {
    lines.push(contract.root.description, "");
  }
  renderCommandBody(contract.root, lines);
  renderSubcommands(contract.root, 2, lines);
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

function renderSubcommands(cmd: CommandContract, depth: number, lines: string[]): void {
  const level = Math.min(depth, 6);
  for (const sub of cmd.subcommands) {
    lines.push(`${"#".repeat(level)} \`${commandSignature(sub)}\``, "");
    if (sub.description) lines.push(sub.description, "");
    if (sub.aliases.length > 0) {
      lines.push(`_Aliases: ${sub.aliases.map((alias) => `\`${alias}\``).join(", ")}_`, "");
    }
    renderCommandBody(sub, lines);
    renderSubcommands(sub, depth + 1, lines);
  }
}

/** `<default>` (see diff.engine.ts's own commandLabel) reads as a real, if odd, name; CAC's blank-name default command instead renders as just the CLI's own usage line with no distinct heading fragment. */
function commandSignature(cmd: CommandContract): string {
  const args = cmd.arguments.map(argumentUsage).join(" ");
  return [cmd.name, args].filter(Boolean).join(" ");
}

function argumentUsage(arg: ArgumentContract): string {
  const name = arg.variadic ? `${arg.name}...` : arg.name;
  return arg.required ? `<${name}>` : `[${name}]`;
}

function renderCommandBody(cmd: CommandContract, lines: string[]): void {
  if (cmd.arguments.length > 0) {
    lines.push("**Arguments**", "", "| Name | Required | Description |", "|---|---|---|");
    for (const arg of cmd.arguments) {
      lines.push(
        `| \`${escapeCell(argumentUsage(arg))}\` | ${arg.required ? "yes" : "no"} | ${escapeCell(arg.description)} |`,
      );
    }
    lines.push("");
  }

  if (cmd.options.length > 0) {
    lines.push("**Options**", "", "| Flag | Default | Description |", "|---|---|---|");
    for (const option of cmd.options) {
      lines.push(`| ${optionCell(option)} | ${defaultCell(option)} | ${descriptionCell(option)} |`);
    }
    lines.push("");
  }
}

function optionCell(option: OptionContract): string {
  return `\`${escapeCell(option.flags)}\``;
}

/** A string default renders bare (`dist/out.js`) - readable as prose. Any other JSON-serializable shape (boolean, number, array) renders via JSON.stringify so it stays unambiguous (e.g. distinguishing the string "true" from the boolean true never comes up for a string default, but would for anything else). */
function defaultCell(option: OptionContract): string {
  if (option.defaultValue === null || option.defaultValue === undefined) return "-";
  const rendered =
    typeof option.defaultValue === "string"
      ? option.defaultValue
      : JSON.stringify(option.defaultValue);
  return `\`${escapeCell(rendered)}\``;
}

function descriptionCell(option: OptionContract): string {
  const description = escapeCell(option.description);
  return option.required ? `${description} *(required)*` : description;
}

/** Markdown table cells break on a literal `|` or an embedded newline - both are possible in a framework-supplied description string. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
