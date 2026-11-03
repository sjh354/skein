import { describe, expect, it } from "vitest";
import { diffLines } from "@/analyzer/change/lineDiff";

describe("diffLines", () => {
  it("returns an empty diff for identical content", () => {
    expect(diffLines("a\nb\n", "a\nb\n")).toEqual({
      added: 0,
      removed: 0,
      unified: "",
      truncated: false,
    });
  });

  it("counts added and removed lines and keeps context", () => {
    const result = diffLines("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.unified).toContain(" one");
    expect(result.unified).toContain("-two");
    expect(result.unified).toContain("+TWO");
    expect(result.truncated).toBe(false);
  });

  it("handles an appended line without a trailing newline", () => {
    const result = diffLines("a", "a\nb");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.unified).toContain("+b");
  });

  it("falls back to a coarse diff for very large files", () => {
    const before = Array.from({ length: 1_600 }, (_, index) => `line ${index}`);
    const after = [...before];
    after[800] = "changed";
    const result = diffLines(before.join("\n"), after.join("\n"));
    expect(result.truncated).toBe(true);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.unified).toContain("changed");
  });

  it("truncates a unified diff that exceeds the character cap", () => {
    const before = Array.from({ length: 1_200 }, (_, index) => `before ${index}`);
    const after = before.map((line) => `${line} changed`);
    const result = diffLines(before.join("\n"), after.join("\n"));
    expect(result.added).toBe(1_200);
    expect(result.removed).toBe(1_200);
    expect(result.unified).toContain("[diff truncated]");
    expect(result.unified.length).toBeLessThan(22_000);
  });
});
