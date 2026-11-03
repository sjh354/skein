import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HistoryError, HistoryRepo } from "@/analyzer/change/historyRepo";
import { mergeThreeWay } from "@/analyzer/change/threeWayMerge";
import { historyRepoPath } from "@/shared/change";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function indexDigest(root: string): string {
  return createHash("sha256").update(execFileSync("git", ["ls-files", "-s"], { cwd: root })).digest("hex");
}

describe("HistoryRepo", () => {
  let root: string;
  let repo: HistoryRepo;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skein-history-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const alpha = 1;\n", "utf8");
    await fs.writeFile(path.join(root, "src", "b.ts"), "export const beta = alpha;\n", "utf8");
    await fs.mkdir(path.join(root, ".skein"), { recursive: true });
    await fs.writeFile(path.join(root, ".skein", ".gitignore"), "*\n", "utf8");
    // A user repository with a staged file and an unstaged edit must stay untouched.
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "user@example.com"]);
    git(root, ["config", "user.name", "User"]);
    git(root, ["add", "src"]);
    git(root, ["commit", "-qm", "user base"]);
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const alpha = 2;\n", "utf8");
    await fs.writeFile(path.join(root, "staged.txt"), "staged\n", "utf8");
    git(root, ["add", "staged.txt"]);
    repo = new HistoryRepo(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("records before and after snapshots without touching the user repository", async () => {
    const userHead = git(root, ["rev-parse", "HEAD"]).trim();
    const userIndex = indexDigest(root);
    const userStatus = git(root, ["status", "--porcelain"]);

    const before = await repo.snapshot("before plan-1", [
      path.join(root, "src", "a.ts"),
      path.join(root, "src", "b.ts"),
    ]);
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const renamed = 2;\n", "utf8");
    const after = await repo.snapshot("after plan-1", [
      path.join(root, "src", "a.ts"),
      path.join(root, "src", "b.ts"),
    ]);

    expect(before).not.toBe(after);
    expect(await repo.readText(before, path.join(root, "src", "a.ts"))).toBe(
      "export const alpha = 2;\n",
    );
    expect(await repo.readText(after, path.join(root, "src", "a.ts"))).toBe(
      "export const renamed = 2;\n",
    );
    expect(await repo.hasFile(after, path.join(root, "src", "b.ts"))).toBe(true);
    expect(await repo.hasFile(after, path.join(root, "src", "missing.ts"))).toBe(false);
    expect(await repo.readText(after, path.join(root, "src", "missing.ts"))).toBeNull();

    expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(userHead);
    expect(indexDigest(root)).toBe(userIndex);
    expect(git(root, ["status", "--porcelain"])).toBe(userStatus);
    expect(git(root, ["status", "--porcelain"])).not.toContain(".skein");
    expect(historyRepoPath(root)).toBe(path.join(root, ".skein", "history", "repo.git"));
    expect(await fs.stat(path.join(historyRepoPath(root), "HEAD"))).toBeTruthy();
  });

  it("records a deletion and is safe to call twice", async () => {
    const before = await repo.snapshot("before delete", [path.join(root, "src", "b.ts")]);
    await fs.rm(path.join(root, "src", "b.ts"));
    const after = await repo.snapshot("after delete", [path.join(root, "src", "b.ts")]);
    expect(await repo.hasFile(before, path.join(root, "src", "b.ts"))).toBe(true);
    expect(await repo.hasFile(after, path.join(root, "src", "b.ts"))).toBe(false);
    await expect(repo.ensure()).resolves.toBeUndefined();
    expect((await repo.log()).length).toBe(2);
  });

  it("rejects files outside the workspace", async () => {
    await expect(repo.snapshot("outside", [path.join(root, "..", "outside.ts")])).rejects.toBeInstanceOf(
      HistoryError,
    );
  });

  it("keeps the recorded bytes for CRLF content", async () => {
    await fs.writeFile(path.join(root, "src", "a.ts"), "line1\r\nline2\r\n", "utf8");
    const commit = await repo.snapshot("crlf", [path.join(root, "src", "a.ts")]);
    expect(await repo.readText(commit, path.join(root, "src", "a.ts"))).toBe("line1\r\nline2\r\n");
  });
});

describe("mergeThreeWay", () => {
  it("merges a non-conflicting edit", async () => {
    const result = await mergeThreeWay(
      "one\ntwo\nthree\nadded by user\n",
      "one\ntwo\nthree\n",
      "one\nTWO\nthree\n",
    );
    expect(result).toMatchObject({ clean: true, conflicts: 0 });
    if ("content" in result) expect(result.content).toBe("one\nTWO\nthree\nadded by user\n");
  });

  it("reports conflicts without writing user files", async () => {
    const result = await mergeThreeWay("one\nuser\nthree\n", "one\ntwo\nthree\n", "one\ntwo-changed\nthree\n");
    expect(result).toMatchObject({ clean: false });
    if ("content" in result) {
      expect(result.conflicts).toBeGreaterThan(0);
      expect(result.content).toContain("<<<<<<<");
    }
  });
});
