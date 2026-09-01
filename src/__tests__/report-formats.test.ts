import {
  toGitLabCodeQuality,
  toJUnitXml,
  toRdjsonl,
  type ReportChange,
} from "../core/report-formats";
import { ChangeType } from "../core/types";

describe("toJUnitXml", () => {
  it("reports zero failures and one passing testcase per non-BREAKING change", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.ADDITIVE, path: "root -> option[--dry-run]", message: "added" },
    ];

    const xml = toJUnitXml(changes);

    expect(xml).toContain('<testsuite name="cliguard" tests="1" failures="0">');
    expect(xml).toContain('<testcase name="root -&gt; option[--dry-run]" classname="cliguard">');
    expect(xml).not.toContain("<failure");
  });

  it("reports an unacknowledged BREAKING change as a JUnit <failure>", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.BREAKING, path: "root -> option[--target]", message: "removed" },
    ];

    const xml = toJUnitXml(changes);

    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<failure message="removed" type="BREAKING">removed</failure>');
  });

  it("reports an acknowledged BREAKING change as passing, not a failure", () => {
    const changes: ReportChange[] = [
      {
        type: ChangeType.BREAKING,
        path: "root -> option[--target]",
        message: "removed",
        acknowledged: true,
        reason: "intentional",
      },
    ];

    const xml = toJUnitXml(changes);

    expect(xml).toContain('failures="0"');
    expect(xml).not.toContain("<failure");
  });

  it("escapes < and > in a path so an argument path never produces invalid XML", () => {
    const changes: ReportChange[] = [
      {
        type: ChangeType.BREAKING,
        path: "root -> build -> argument[<file>]",
        message: 'Argument "<file>" was removed.',
      },
    ];

    const xml = toJUnitXml(changes);

    expect(xml).not.toMatch(/argument\[<file>\]/);
    expect(xml).toContain("argument[&lt;file&gt;]");
  });
});

describe("toGitLabCodeQuality", () => {
  it("maps an unacknowledged BREAKING change to blocker severity", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.BREAKING, path: "root -> option[--target]", message: "removed" },
    ];

    const issues = JSON.parse(toGitLabCodeQuality(changes, ".cliguard/contract.json"));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "blocker",
      check_name: "cliguard/breaking",
      location: { path: ".cliguard/contract.json", lines: { begin: 1 } },
    });
    expect(issues[0].description).toContain("root -> option[--target]");
    expect(typeof issues[0].fingerprint).toBe("string");
    expect(issues[0].fingerprint.length).toBeGreaterThan(0);
  });

  it("maps an acknowledged BREAKING change to info severity, not blocker", () => {
    const changes: ReportChange[] = [
      {
        type: ChangeType.BREAKING,
        path: "root -> option[--target]",
        message: "removed",
        acknowledged: true,
        reason: "intentional",
      },
    ];

    const issues = JSON.parse(toGitLabCodeQuality(changes, ".cliguard/contract.json"));

    expect(issues[0].severity).toBe("info");
  });

  it("gives two different changes two different, stable fingerprints", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.BREAKING, path: "root -> option[--a]", message: "removed" },
      { type: ChangeType.BREAKING, path: "root -> option[--b]", message: "removed" },
    ];

    const issuesA = JSON.parse(toGitLabCodeQuality(changes, ".cliguard/contract.json"));
    const issuesB = JSON.parse(toGitLabCodeQuality(changes, ".cliguard/contract.json"));

    expect(issuesA[0].fingerprint).not.toBe(issuesA[1].fingerprint);
    expect(issuesA[0].fingerprint).toBe(issuesB[0].fingerprint);
  });
});

describe("toRdjsonl", () => {
  it("emits one JSON object per line, not a JSON array", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.BREAKING, path: "root -> option[--a]", message: "removed" },
      { type: ChangeType.ADDITIVE, path: "root -> option[--b]", message: "added" },
    ];

    const lines = toRdjsonl(changes, ".cliguard/contract.json").split("\n");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("maps an unacknowledged BREAKING change to ERROR severity", () => {
    const changes: ReportChange[] = [
      { type: ChangeType.BREAKING, path: "root -> option[--target]", message: "removed" },
    ];

    const [diagnostic] = toRdjsonl(changes, ".cliguard/contract.json")
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(diagnostic.severity).toBe("ERROR");
    expect(diagnostic.code.value).toBe("root -> option[--target]");
    expect(diagnostic.location.path).toBe(".cliguard/contract.json");
  });

  it("maps an acknowledged BREAKING change to INFO, and a PATCH to WARNING", () => {
    const changes: ReportChange[] = [
      {
        type: ChangeType.BREAKING,
        path: "root -> option[--target]",
        message: "removed",
        acknowledged: true,
        reason: "intentional",
      },
      { type: ChangeType.PATCH, path: "root -> option[--verbose]", message: "description changed" },
    ];

    const [acknowledged, patch] = toRdjsonl(changes, ".cliguard/contract.json")
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(acknowledged.severity).toBe("INFO");
    expect(patch.severity).toBe("WARNING");
  });

  it("returns an empty string for no changes", () => {
    expect(toRdjsonl([], ".cliguard/contract.json")).toBe("");
  });
});
