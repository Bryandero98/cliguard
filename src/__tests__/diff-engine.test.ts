import { DiffEngine } from "../core/diff.engine";
import { ChangeType, type CommandContract, type Contract } from "../core/types";

function makeCommand(overrides: Partial<CommandContract> = {}): CommandContract {
  return {
    name: "mycli",
    description: "Example CLI",
    aliases: [],
    options: [],
    arguments: [],
    subcommands: [],
    ...overrides,
  };
}

function makeContract(root: CommandContract): Contract {
  return {
    contractVersion: 1,
    adapter: "commander",
    capturedAt: "2026-01-01T00:00:00.000Z",
    root,
  };
}

describe("DiffEngine", () => {
  const engine = new DiffEngine();

  it("ignores capturedAt entirely", () => {
    const oldContract = makeContract(makeCommand());
    const newContract = { ...makeContract(makeCommand()), capturedAt: "2030-01-01T00:00:00.000Z" };

    expect(engine.compare(oldContract, newContract)).toEqual([]);
  });

  it("flags a BREAKING change when a required option is removed", () => {
    const oldContract = makeContract(
      makeCommand({
        options: [
          {
            flags: "-t, --target <target>",
            name: "target",
            aliases: ["-t"],
            description: "build target",
            required: true,
            valueType: "string",
            variadic: false,
            defaultValue: null,
          },
        ],
      }),
    );
    const newContract = makeContract(makeCommand({ options: [] }));

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root -> option[--target]",
      message: 'Option "--target" was removed.',
    });
  });

  it("flags a BREAKING change (with an accurate message) when an optional option is removed", () => {
    // Regression test: the message used to hardcode the word "Required"
    // regardless of whether the removed option actually was one -
    // removing an optional option is just as BREAKING (it still breaks
    // any invocation that passed it), but claiming it was "required" is
    // simply false and misleading in the diff output.
    const oldContract = makeContract(
      makeCommand({
        options: [
          {
            flags: "--verbose",
            name: "verbose",
            aliases: [],
            description: "verbose logging",
            required: false,
            valueType: "boolean",
            variadic: false,
            defaultValue: null,
          },
        ],
      }),
    );
    const newContract = makeContract(makeCommand({ options: [] }));

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root -> option[--verbose]",
      message: 'Option "--verbose" was removed.',
    });
  });

  it("flags an ADDITIVE change when a new optional option is added", () => {
    const oldContract = makeContract(makeCommand({ options: [] }));
    const newContract = makeContract(
      makeCommand({
        options: [
          {
            flags: "--verbose",
            name: "verbose",
            aliases: [],
            description: "verbose logging",
            required: false,
            valueType: "boolean",
            variadic: false,
            defaultValue: null,
          },
        ],
      }),
    );

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.ADDITIVE,
      path: "root -> option[--verbose]",
      message: 'New optional option "--verbose" was added.',
    });
  });

  it("flags a BREAKING change when a new *required* option is added", () => {
    const oldContract = makeContract(makeCommand({ options: [] }));
    const newContract = makeContract(
      makeCommand({
        options: [
          {
            flags: "-t, --target <target>",
            name: "target",
            aliases: [],
            description: "build target",
            required: true,
            valueType: "string",
            variadic: false,
            defaultValue: null,
          },
        ],
      }),
    );

    const diff = engine.compare(oldContract, newContract);

    expect(diff[0].type).toBe(ChangeType.BREAKING);
  });

  it("flags a PATCH change when only a description changes", () => {
    const option = {
      flags: "-o, --output <path>",
      name: "output",
      aliases: ["-o"],
      description: "output path",
      required: false,
      valueType: "string" as const,
      variadic: false,
      defaultValue: "dist/out.js",
    };
    const oldContract = makeContract(makeCommand({ options: [option] }));
    const newContract = makeContract(
      makeCommand({ options: [{ ...option, description: "the output file path" }] }),
    );

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toEqual([
      {
        type: ChangeType.PATCH,
        path: "root -> option[--output]",
        message: 'Option "--output" description changed.',
      },
    ]);
  });

  it("flags a BREAKING change when an option's default value changes", () => {
    const option = {
      flags: "-o, --output <path>",
      name: "output",
      aliases: [],
      description: "output path",
      required: false,
      valueType: "string" as const,
      variadic: false,
      defaultValue: "dist/out.js",
    };
    const oldContract = makeContract(makeCommand({ options: [option] }));
    const newContract = makeContract(
      makeCommand({ options: [{ ...option, defaultValue: "build/out.js" }] }),
    );

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root -> option[--output]",
      message: 'Option "--output" default value changed from "dist/out.js" to "build/out.js".',
    });
  });

  it("flags a BREAKING change when a required option becomes optional->required, and PATCH the reverse", () => {
    const option = {
      flags: "--force",
      name: "force",
      aliases: [],
      description: "force overwrite",
      required: false,
      valueType: "boolean" as const,
      variadic: false,
      defaultValue: null,
    };
    const becameRequired = engine.compare(
      makeContract(makeCommand({ options: [option] })),
      makeContract(makeCommand({ options: [{ ...option, required: true }] })),
    );
    expect(becameRequired.some((d) => d.type === ChangeType.BREAKING)).toBe(true);

    const becameOptional = engine.compare(
      makeContract(makeCommand({ options: [{ ...option, required: true }] })),
      makeContract(makeCommand({ options: [option] })),
    );
    expect(becameOptional).toEqual([
      {
        type: ChangeType.PATCH,
        path: "root -> option[--force]",
        message: 'Option "--force" became optional - backward compatible.',
      },
    ]);
  });

  it("recurses into subcommands and flags a removed command as BREAKING, an added one as ADDITIVE", () => {
    const oldContract = makeContract(
      makeCommand({ subcommands: [makeCommand({ name: "build" })] }),
    );
    const newContract = makeContract(
      makeCommand({ subcommands: [makeCommand({ name: "deploy" })] }),
    );

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root -> build",
      message: 'Command "build" was removed.',
    });
    expect(diff).toContainEqual({
      type: ChangeType.ADDITIVE,
      path: "root -> deploy",
      message: 'Command "deploy" was added.',
    });
  });

  it('labels an unnamed command (CAC\'s default command, name === "") as <default> instead of a blank path segment', () => {
    const option = {
      flags: "-o, --out <path>",
      name: "out",
      aliases: ["-o"],
      description: "output path",
      required: false,
      valueType: "string" as const,
      variadic: false,
      defaultValue: null,
    };
    const oldContract = makeContract(
      makeCommand({ subcommands: [makeCommand({ name: "", options: [option] })] }),
    );
    const newContract = makeContract(makeCommand({ subcommands: [makeCommand({ name: "" })] }));

    const diff = engine.compare(oldContract, newContract);

    expect(diff).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root -> <default> -> option[--out]",
      message: 'Option "--out" was removed.',
    });
  });

  it("flags a BREAKING change when an alias is removed, and PATCH when one is added", () => {
    const oldContract = makeContract(makeCommand({ aliases: ["b"] }));
    const removed = engine.compare(oldContract, makeContract(makeCommand({ aliases: [] })));
    expect(removed).toContainEqual({
      type: ChangeType.BREAKING,
      path: "root",
      message: 'Alias "b" was removed from command "mycli".',
    });

    const added = engine.compare(
      makeContract(makeCommand({ aliases: [] })),
      makeContract(makeCommand({ aliases: ["b"] })),
    );
    expect(added).toContainEqual({
      type: ChangeType.PATCH,
      path: "root",
      message: 'Alias "b" was added to command "mycli".',
    });
  });

  it("flags a BREAKING change when the adapter or contract version differ", () => {
    const oldContract = makeContract(makeCommand());
    const diff = engine.compare(oldContract, { ...makeContract(makeCommand()), adapter: "yargs" });

    expect(diff).toContainEqual(
      expect.objectContaining({ type: ChangeType.BREAKING, path: "contract" }),
    );
  });
});
