import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEND_ONLY_PATHS,
  appendOnlyPathsFrom,
  baseAppendOnlyPaths,
  isAppendMergeOf,
  mergeAppendOnly,
} from "./append-log.js";

const FP = "# Work log\n\n## one\n- a\n";

describe("mergeAppendOnly", () => {
  it("lands the base head plus the proposal's tail after a blank line", () => {
    const base = FP + "\n## two (other lane)\n- b\n";
    const fork = FP + "\n## three (this lane)\n- c\n";
    expect(mergeAppendOnly(FP, base, fork)).toBe(base + "\n## three (this lane)\n- c\n");
  });

  it("adds the blank line itself when either side appended without one", () => {
    expect(mergeAppendOnly(FP, FP + "## two\n", FP + "## three\n")).toBe(FP + "## two\n\n## three\n");
    // A base whose last line has no newline still gets a blank line before the entry.
    expect(mergeAppendOnly("x\n", "x\ny", "x\nz\n")).toBe("x\ny\n\nz\n");
  });

  it("keeps the base's trailing blank lines as they are", () => {
    expect(mergeAppendOnly(FP, FP + "## two\n\n\n", FP + "## three\n")).toBe(FP + "## two\n\n\n## three\n");
  });

  it("is the proposal when the base did not change the file, and the base when the proposal did not", () => {
    expect(mergeAppendOnly(FP, FP, FP + "## three\n")).toBe(FP + "## three\n");
    expect(mergeAppendOnly(FP, FP + "## two\n", FP)).toBe(FP + "## two\n");
  });

  it("never lands an entry twice: a base that already holds the proposal's tail stays as it is", () => {
    const entry = "\n## three\n- c\n";
    const base = FP + "\n## two\n- b\n" + entry;
    expect(mergeAppendOnly(FP, base, FP + entry)).toBe(base);
  });

  it("is a conflict for an edit above the end, on either side", () => {
    const edited = FP.replace("- a", "- A");
    expect(mergeAppendOnly(FP, edited + "## two\n", FP + "## three\n")).toBeNull();
    expect(mergeAppendOnly(FP, FP + "## two\n", edited + "## three\n")).toBeNull();
  });

  it("is a conflict for a shortened file (a deleted entry)", () => {
    expect(mergeAppendOnly(FP, "# Work log\n", FP + "## three\n")).toBeNull();
    expect(mergeAppendOnly(FP, FP + "## two\n", "# Work log\n")).toBeNull();
  });

  it("is a conflict for text added to the fork point's last line rather than after it", () => {
    expect(mergeAppendOnly("x\ny", "x\ny\nb\n", "x\nyz\n")).toBeNull();
    expect(mergeAppendOnly("x\ny", "x\nyz\n", "x\ny\nc\n")).toBeNull();
    // The fork point's unterminated last line, then a new line: still an append.
    expect(mergeAppendOnly("x\ny", "x\ny\nb\n", "x\ny\nc\n")).toBe("x\ny\nb\n\nc\n");
  });
});

describe("isAppendMergeOf", () => {
  it("holds for every merge mergeAppendOnly makes", () => {
    const cases: [string, string, string][] = [
      [FP, FP + "\n## two\n", FP + "\n## three\n"],
      [FP, FP, FP + "## three\n"],
      [FP, FP + "## two\n", FP],
      ["", "b\n", "c\n"],
    ];
    for (const [fp, base, fork] of cases) {
      const merged = mergeAppendOnly(fp, base, fork);
      expect(merged).not.toBeNull();
      expect(isAppendMergeOf(base, fork, merged!)).toBe(true);
    }
  });

  it("refuses text that drops or rewrites the base, or adds what the proposal does not end with", () => {
    const base = FP + "## two\n";
    const fork = FP + "## three\n";
    expect(isAppendMergeOf(base, fork, FP + "## three\n")).toBe(false); // base's entry lost
    expect(isAppendMergeOf(base, fork, base.replace("- a", "- A") + "\n## three\n")).toBe(false);
    expect(isAppendMergeOf(base, fork, base + "\n## injected\n")).toBe(false);
  });
});

describe("append-only path lists", () => {
  it("defaults to docs/LOG.md, and an empty value turns the gate-wide list off", () => {
    expect(appendOnlyPathsFrom(undefined)).toEqual([...DEFAULT_APPEND_ONLY_PATHS]);
    expect(DEFAULT_APPEND_ONLY_PATHS).toEqual(["docs/LOG.md"]);
    expect(appendOnlyPathsFrom("")).toEqual([]);
    expect(appendOnlyPathsFrom(" docs/LOG.md, CHANGELOG.md\nnotes/log.md ")).toEqual([
      "docs/LOG.md",
      "CHANGELOG.md",
      "notes/log.md",
    ]);
  });

  it("takes exact file paths only", () => {
    expect(appendOnlyPathsFrom("docs/*.md,/etc/x,docs/,a/../b,./a,ok.md,ok.md")).toEqual(["ok.md"]);
  });

  it("reads a base's own list, and names none for absent or malformed config", () => {
    expect(baseAppendOnlyPaths('{"appendOnly": ["CHANGELOG.md", 3, "docs/LOG.md"]}')).toEqual([
      "CHANGELOG.md",
      "docs/LOG.md",
    ]);
    expect(baseAppendOnlyPaths(null)).toEqual([]);
    expect(baseAppendOnlyPaths("{not json")).toEqual([]);
    expect(baseAppendOnlyPaths('{"appendOnly": "docs/LOG.md"}')).toEqual([]);
  });
});
