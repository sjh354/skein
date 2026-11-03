import { describe, expect, it } from "vitest";
import {
  buildChangePlan,
  fileAfterContent,
  materializePreview,
  planDiff,
  summarizeTask,
} from "@/analyzer/change/changePlan";
import type { ChangeTask } from "@/shared/change";

const ROOT = "/workspace";
const FILE = "/workspace/src/app.ts";
const OTHER = "/workspace/src/other.ts";

function build(files: Parameters<typeof buildChangePlan>[0]["files"], contents?: Map<string, string>) {
  return buildChangePlan({
    id: "plan-1",
    kind: "rename",
    root: ROOT,
    graphVersion: 4,
    source: "mcp",
    now: 123,
    target: { name: "alpha", newName: "beta", path: FILE, line: 0 },
    contents: contents ?? new Map([[FILE, "export const alpha = 1;\n"]]),
    files,
  });
}

describe("buildChangePlan", () => {
  it("keeps only files whose content changes and records the fingerprint", () => {
    const result = build([
      {
        path: FILE,
        edits: [{ startLine: 0, startCharacter: 13, endLine: 0, endCharacter: 18, newText: "beta" }],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.files).toHaveLength(1);
    expect(result.plan.files[0].beforeContent).toBe("export const alpha = 1;\n");
    expect(result.plan.fingerprint.files[0]).toMatchObject({ path: FILE, exists: true });
    expect(result.preview[0].afterContent).toBe("export const beta = 1;\n");
    expect(result.preview[0].diff.removed).toBe(1);
    expect(result.preview[0].diff.added).toBe(1);
    expect(result.plan.createdAt).toBe(123);
    expect(result.plan.source).toBe("mcp");
  });

  it("drops edits that leave the content unchanged", () => {
    const result = build([
      {
        path: FILE,
        edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6, newText: "export" }],
      },
    ]);
    expect(result).toEqual({ ok: false, reason: "no-changes" });
  });

  it("rejects empty, duplicate, protected and unreadable files", () => {
    expect(build([])).toEqual({ ok: false, reason: "no-edits" });
    expect(
      build([
        { path: FILE, edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, newText: "x" }] },
        { path: FILE, edits: [{ startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 2, newText: "y" }] },
      ]),
    ).toEqual({ ok: false, reason: "duplicate-path" });
    expect(
      build([
        {
          path: "/workspace/.skein/state.json",
          edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, newText: "x" }],
        },
      ]),
    ).toEqual({ ok: false, reason: "path-not-allowed" });
    expect(
      build(
        [
          {
            path: OTHER,
            edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1, newText: "x" }],
          },
        ],
        new Map(),
      ),
    ).toEqual({ ok: false, reason: "file-not-readable" });
  });

  it("rejects an invalid edit range", () => {
    expect(
      build([
        {
          path: FILE,
          edits: [{ startLine: 9, startCharacter: 0, endLine: 9, endCharacter: 1, newText: "x" }],
        },
      ]),
    ).toEqual({ ok: false, reason: "invalid-edit" });
  });
});

describe("plan materialization", () => {
  const task: ChangeTask = {
    schemaVersion: 1,
    status: "preview-ready",
    createdAt: 1,
    updatedAt: 1,
    plan: {
      id: "plan-1",
      kind: "rename",
      createdAt: 1,
      workspaceRoot: ROOT,
      graphVersion: 1,
      source: "ui",
      files: [
        {
          path: FILE,
          beforeContent: "alpha\n",
          edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, newText: "beta" }],
        },
      ],
      fingerprint: {
        files: [{ path: FILE, exists: true, sha256: "hash" }],
        graphVersion: 1,
      },
    },
  };

  it("recomputes content, preview, summary and diff", () => {
    expect(fileAfterContent(task.plan.files[0])).toBe("beta\n");
    expect(materializePreview(task)[0].afterContent).toBe("beta\n");
    const summary = summarizeTask(task);
    expect(summary.files[0]).toMatchObject({ path: FILE, edits: 1, added: 1, removed: 1 });
    expect(planDiff(task)).toContain("-alpha");
    expect(planDiff(task)).toContain("+beta");
  });
});
