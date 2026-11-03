import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  canRedo,
  canUndo,
  findRedoCandidate,
  findUndoCandidate,
  hashContent,
  isProtectedChangePath,
  parseChangeHistory,
  parseChangeRequest,
  parseChangeTask,
  positionToOffset,
  replaceWholeFileEdit,
  summarizeHistoryEntry,
  type ChangeHistoryEntry,
  type ChangePlan,
  type ChangeTask,
} from "@/shared/change";

const ROOT = "/workspace";
const FILE = "/workspace/src/app.ts";

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return {
    id: "plan-1",
    kind: "rename",
    createdAt: 1,
    workspaceRoot: ROOT,
    graphVersion: 3,
    source: "ui",
    target: { name: "alpha", newName: "beta", path: FILE, line: 0 },
    files: [{ path: FILE, beforeContent: "alpha\n", edits: [] }],
    fingerprint: {
      files: [{ path: FILE, exists: true, sha256: hashContent("alpha\n") }],
      graphVersion: 3,
    },
    ...overrides,
  };
}

function task(overrides: Partial<ChangeTask> = {}): ChangeTask {
  const basePlan = plan();
  return {
    schemaVersion: 1,
    plan: basePlan,
    status: "preview-ready",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function entry(overrides: Partial<ChangeHistoryEntry> = {}): ChangeHistoryEntry {
  return {
    id: "entry-1",
    planId: "plan-1",
    kind: "rename",
    source: "ui",
    createdAt: 1,
    status: "succeeded",
    files: [{ path: FILE, change: "modified", beforeHash: "a", afterHash: "b" }],
    beforeCommit: "before",
    afterCommit: "after",
    ...overrides,
  };
}

describe("shared/change positions and edits", () => {
  it("maps line/character positions to offsets", () => {
    const content = "one\ntwo\nthree";
    expect(positionToOffset(content, 0, 0)).toBe(0);
    expect(positionToOffset(content, 1, 2)).toBe(6);
    expect(positionToOffset(content, 2, 5)).toBe(13);
  });

  it("rejects positions outside the content", () => {
    expect(positionToOffset("one\ntwo", 5, 0)).toBe(-1);
    expect(positionToOffset("one\ntwo", 0, 4)).toBe(-1);
    expect(positionToOffset("one\ntwo", -1, 0)).toBe(-1);
  });

  it("applies several non-overlapping edits", () => {
    const content = "const alpha = alpha;\n";
    const result = applyTextEdits(content, [
      { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 11, newText: "beta" },
      { startLine: 0, startCharacter: 14, endLine: 0, endCharacter: 19, newText: "beta" },
    ]);
    expect(result).toBe("const beta = beta;\n");
  });

  it("rejects overlapping edits", () => {
    expect(
      applyTextEdits("abcdef", [
        { startLine: 0, startCharacter: 1, endLine: 0, endCharacter: 3, newText: "x" },
        { startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 4, newText: "y" },
      ]),
    ).toBeNull();
  });

  it("rejects an invalid range", () => {
    expect(
      applyTextEdits("abc", [
        { startLine: 0, startCharacter: 2, endLine: 0, endCharacter: 1, newText: "x" },
      ]),
    ).toBeNull();
  });

  it("builds a whole-file replacement that round-trips", () => {
    const content = "one\ntwo\n";
    const edit = replaceWholeFileEdit(content, "three\nfour");
    expect(applyTextEdits(content, [edit])).toBe("three\nfour");
  });

  it("protects repository and Skein state paths", () => {
    expect(isProtectedChangePath("/workspace/src/app.ts", ROOT)).toBe(false);
    expect(isProtectedChangePath("/workspace/.git/config", ROOT)).toBe(true);
    expect(isProtectedChangePath("/workspace/.skein/state.json", ROOT)).toBe(true);
    expect(isProtectedChangePath("/elsewhere/app.ts", ROOT)).toBe(true);
  });
});

describe("shared/change parsing", () => {
  it("round-trips a task through JSON", () => {
    const parsed = parseChangeTask(JSON.stringify(task()));
    expect(parsed?.plan.id).toBe("plan-1");
    expect(parsed?.status).toBe("preview-ready");
    expect(parsed?.plan.files[0].beforeContent).toBe("alpha\n");
  });

  it("rejects malformed tasks", () => {
    expect(parseChangeTask("not json")).toBeNull();
    expect(parseChangeTask(JSON.stringify({ status: "preview-ready" }))).toBeNull();
    expect(parseChangeTask(JSON.stringify(task({ status: "nope" as ChangeTask["status"] })))).toBeNull();
    expect(
      parseChangeTask(
        JSON.stringify({ ...task(), plan: { ...plan(), kind: "delete" } }),
      ),
    ).toBeNull();
  });

  it("parses history entries with undo/redo links", () => {
    const index = parseChangeHistory(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          entry(),
          entry({ id: "entry-2", kind: "undo", undoTargetId: "entry-1" }),
          entry({ id: "entry-3", kind: "redo", redoOfId: "entry-2" }),
        ],
      }),
    );
    expect(index?.entries.map((item) => item.kind)).toEqual(["rename", "undo", "redo"]);
    expect(summarizeHistoryEntry(index!.entries[1]).undoTargetId).toBe("entry-1");
  });

  it("parses rename change requests and rejects incomplete ones", () => {
    const request = parseChangeRequest(
      JSON.stringify({
        id: "request-1",
        kind: "change",
        createdAt: 1,
        command: { action: "change_plan", kind: "rename", nodeId: "node", newName: "beta" },
      }),
    );
    expect(request?.command.action).toBe("change_plan");
    expect(
      parseChangeRequest(
        JSON.stringify({
          id: "request-2",
          kind: "change",
          createdAt: 1,
          command: { action: "change_plan", kind: "rename", newName: "beta" },
        }),
      ),
    ).toBeNull();
    expect(
      parseChangeRequest(
        JSON.stringify({ id: "request-3", kind: "change", createdAt: 1, command: { action: "select" } }),
      ),
    ).toBeNull();
  });
});

describe("shared/change undo and redo candidates", () => {
  it("undoes the newest applied rename", () => {
    const index = parseChangeHistory(
      JSON.stringify({ schemaVersion: 1, entries: [entry()] }),
    )!;
    expect(findUndoCandidate(index)?.id).toBe("entry-1");
    expect(canUndo(index.entries[0], index)).toBe(true);
    expect(findRedoCandidate(index)).toBeUndefined();
    expect(findUndoCandidate(index, "missing")).toBeUndefined();
  });

  it("only redoes the newest undo", () => {
    const index = parseChangeHistory(
      JSON.stringify({
        schemaVersion: 1,
        entries: [entry(), entry({ id: "undo-1", kind: "undo", undoTargetId: "entry-1" })],
      }),
    )!;
    expect(findUndoCandidate(index)).toBeUndefined();
    expect(findRedoCandidate(index)?.id).toBe("undo-1");
    expect(findUndoCandidate(index, "entry-1")).toBeUndefined();
  });

  it("undoes a redo and blocks out-of-order entries", () => {
    const index = parseChangeHistory(
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          entry(),
          entry({ id: "undo-1", kind: "undo", undoTargetId: "entry-1" }),
          entry({ id: "redo-1", kind: "redo", redoOfId: "undo-1" }),
        ],
      }),
    )!;
    expect(findUndoCandidate(index)?.id).toBe("redo-1");
    expect(findRedoCandidate(index)).toBeUndefined();
    expect(canUndo(index.entries[0], index)).toBe(false);
    expect(canRedo(index.entries[1], index)).toBe(false);
  });
});
