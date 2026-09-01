import { renderMarkdownDocs } from "../core/docs";
import type { ArgumentContract, CommandContract, Contract, OptionContract } from "../core/types";

function option(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    flags: "--verbose",
    name: "verbose",
    aliases: [],
    description: "verbose logging",
    required: false,
    valueType: "boolean",
    variadic: false,
    defaultValue: null,
    ...overrides,
  };
}

function arg(overrides: Partial<ArgumentContract> = {}): ArgumentContract {
  return {
    name: "file",
    required: true,
    variadic: false,
    description: "",
    ...overrides,
  };
}

function command(overrides: Partial<CommandContract> = {}): CommandContract {
  return {
    name: "mycli",
    description: "",
    aliases: [],
    options: [],
    arguments: [],
    subcommands: [],
    ...overrides,
  };
}

function contract(root: CommandContract): Contract {
  return { contractVersion: 1, adapter: "commander", capturedAt: "2026-01-01T00:00:00.000Z", root };
}

describe("renderMarkdownDocs", () => {
  it("renders the root's own name as an H1 and its description as a paragraph", () => {
    const md = renderMarkdownDocs(contract(command({ name: "mycli", description: "Example CLI" })), "fallback");

    expect(md).toContain("# mycli\n");
    expect(md).toContain("Example CLI\n");
  });

  it("falls back to the given title when the root has no name (e.g. a CAC default-command-only CLI)", () => {
    const md = renderMarkdownDocs(contract(command({ name: "" })), "cli.js");

    expect(md).toContain("# cli.js\n");
  });

  it("renders a subcommand as an H2 with its usage signature: name plus each argument in <>/[] notation", () => {
    const root = command({
      subcommands: [
        command({
          name: "build",
          description: "Build the project",
          arguments: [
            arg({ name: "entry", required: true, variadic: false }),
            arg({ name: "extra", required: false, variadic: true }),
          ],
        }),
      ],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("## `build <entry> [extra...]`\n");
    expect(md).toContain("Build the project\n");
  });

  it("renders an arguments table with Required=yes/no", () => {
    const root = command({
      subcommands: [
        command({
          name: "build",
          arguments: [
            arg({ name: "entry", required: true, description: "entry file" }),
            arg({ name: "extra", required: false, variadic: true, description: "extra files" }),
          ],
        }),
      ],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("| `<entry>` | yes | entry file |");
    expect(md).toContain("| `[extra...]` | no | extra files |");
  });

  it("renders a string default bare, a non-string default via JSON.stringify, and no default as '-'", () => {
    const root = command({
      options: [
        option({ name: "output", flags: "-o, --output <path>", defaultValue: "dist/out.js" }),
        option({ name: "retries", flags: "--retries <n>", defaultValue: 3 }),
        option({ name: "verbose", flags: "--verbose", defaultValue: null }),
      ],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("| `-o, --output <path>` | `dist/out.js` |");
    expect(md).toContain("| `--retries <n>` | `3` |");
    expect(md).toContain("| `--verbose` | - |");
  });

  it("marks a required option with *(required)* in its description cell", () => {
    const root = command({
      options: [option({ name: "target", flags: "-t, --target <t>", description: "build target", required: true })],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("build target *(required)*");
  });

  it("renders aliases under a command's heading when present", () => {
    const root = command({
      subcommands: [command({ name: "build", aliases: ["b"] })],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("_Aliases: `b`_");
  });

  it("escapes a literal | in a description so it can't break the Markdown table", () => {
    const root = command({
      options: [option({ name: "format", flags: "--format <fmt>", description: "one of a|b|c" })],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("one of a\\|b\\|c");
  });

  it("increases heading depth for a nested sub-subcommand", () => {
    const root = command({
      subcommands: [
        command({
          name: "remote",
          subcommands: [command({ name: "add" })],
        }),
      ],
    });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).toContain("## `remote`");
    expect(md).toContain("### `add`");
  });

  it("omits the Arguments/Options tables entirely for a command that has neither", () => {
    const root = command({ subcommands: [command({ name: "noop" })] });

    const md = renderMarkdownDocs(contract(root), "fallback");

    expect(md).not.toContain("**Arguments**");
    expect(md).not.toContain("**Options**");
  });
});
