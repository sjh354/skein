import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectTaskState, recoverInterruptedTasks } from "@/analyzer/change/taskStore";
import {
  changeTaskPath,
  hashContent,
  readChangeTask,
  writeChangeTask,
  type ChangeTask,
} from "@/shared/change";

function makeTask(root = "/workspace", overrides: Partial<ChangeTask> = {}): ChangeTask {
  return {
    schemaVersion: 1,
    status: "applying",
    createdAt: 1,
    updatedAt: 1,
    plan: {
      id: "plan-1",
      kind: "rename",
      createdAt: 1,
      workspaceRoot: "/workspace",
      graphVersion: 1,
      source: "ui",
      files: [
        {
          path: path.join(root, "src", "app.ts"),
          beforeContent: "alpha\n",
          edits: [{ startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, newText: "beta" }],
        },
      ],
      fingerprint: {
        files: [
          { path: path.join(root, "src", "app.ts"), exists: true, sha256: hashContent("alpha\n") },
        ],
        graphVersion: 1,
      },
    },
    ...overrides,
  };
}

describe("task recovery", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skein-task-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, ".skein", "history", "tasks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("classifies an untouched file as before", async () => {
    await fs.writeFile(path.join(root, "src", "app.ts"), "alpha\n", "utf8");
    const report = await inspectTaskState(makeTask(root));
    expect(report.state).toBe("before");
    expect(report.files).toEqual([]);
  });

  it("classifies a fully applied file as after", async () => {
    await fs.writeFile(path.join(root, "src", "app.ts"), "beta\n", "utf8");
    const report = await inspectTaskState(makeTask(root));
    expect(report.state).toBe("after");
  });

  it("classifies a differently edited file as partial", async () => {
    await fs.writeFile(path.join(root, "src", "app.ts"), "gamma\n", "utf8");
    const report = await inspectTaskState(makeTask(root));
    expect(report.state).toBe("partial");
    expect(report.files).toEqual([path.join(root, "src", "app.ts")]);
  });

  it("moves interrupted tasks to recovery and leaves other tasks alone", async () => {
    await fs.writeFile(path.join(root, "src", "app.ts"), "beta\n", "utf8");
    const dirty = makeTask(root);
    await writeChangeTask(root, dirty);

    const done = makeTask(root, { status: "succeeded" });
    done.plan.id = "plan-2";
    await writeChangeTask(root, done);

    const reports = await recoverInterruptedTasks(root);
    expect(reports).toHaveLength(1);
    expect(reports[0].state).toBe("after");
    const recovered = await readChangeTask(root, "plan-1");
    expect(recovered?.status).toBe("recovery");
    expect(recovered?.reason).toBe("interrupted-after");
    expect((await readChangeTask(root, "plan-2"))?.status).toBe("succeeded");
    expect(await fs.stat(changeTaskPath(root, "plan-1"))).toBeTruthy();
  });
});
