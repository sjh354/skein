/**
 * Three-way merge for undo/redo (DESIGN 9.3).
 *
 * Undo (base = recorded after, ours = current, theirs = recorded before) keeps
 * edits the user made after the change. A conflict is reported to the caller;
 * the user's file is never overwritten with a reset/checkout. `git merge-file`
 * runs on three temporary files, never inside the user's repository.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ThreeWayMergeResult {
  clean: boolean;
  /** Merged text; contains conflict markers when `clean` is false. */
  content: string;
  conflicts: number;
}

export type ThreeWayMergeFailure = { error: "merge-unavailable" | "merge-failed"; message: string };

export async function mergeThreeWay(
  current: string,
  base: string,
  other: string,
): Promise<ThreeWayMergeResult | ThreeWayMergeFailure> {
  let directory: string;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "skein-merge-"));
  } catch (err) {
    return { error: "merge-unavailable", message: String(err) };
  }
  const currentPath = path.join(directory, "current");
  const basePath = path.join(directory, "base");
  const otherPath = path.join(directory, "other");
  try {
    await Promise.all([
      fs.writeFile(currentPath, current, "utf8"),
      fs.writeFile(basePath, base, "utf8"),
      fs.writeFile(otherPath, other, "utf8"),
    ]);
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["merge-file", "-p", "--diff3", currentPath, basePath, otherPath],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      );
      return { clean: true, content: stdout, conflicts: 0 };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      if (typeof failure.code === "number" && failure.code > 0 && failure.code < 128) {
        return { clean: false, content: failure.stdout ?? "", conflicts: failure.code };
      }
      return {
        error: "merge-failed",
        message: failure.stderr ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
