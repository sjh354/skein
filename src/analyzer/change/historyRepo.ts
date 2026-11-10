/**
 * Internal Git history for tool changes (DESIGN 9.1).
 *
 * `.skein/history/repo.git` is a separate repository whose git-dir never points
 * at the user's `.git`; every command passes `--git-dir` and `--work-tree`
 * explicitly. Only the files a plan touches are staged, so analysis state and
 * secrets are never collected. If Git is missing or a snapshot fails, the
 * caller must refuse to apply (DESIGN 9.2) instead of recording a fake history.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { historyDirPath, historyRepoPath } from "@/shared/change";
import { normalizePath } from "@/shared/path";

const execFileAsync = promisify(execFile);

export class HistoryError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HistoryError";
  }
}

export interface GitCommitInfo {
  hash: string;
  message: string;
  createdAt: number;
}

export class HistoryRepo {
  private ready: Promise<void> | null = null;
  private readonly gitDir: string;
  private readonly hooksDir: string;

  constructor(private readonly root: string) {
    this.gitDir = historyRepoPath(root);
    this.hooksDir = path.join(historyDirPath(root), "no-hooks");
  }

  async ensure(): Promise<void> {
    this.ready ??= this.initialize();
    return this.ready;
  }

  /** Creates the isolated repository on first use. */
  private async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.hooksDir, { recursive: true });
      try {
        await fs.access(path.join(this.gitDir, "HEAD"));
      } catch {
        await fs.mkdir(this.gitDir, { recursive: true });
        // `git init` rejects --work-tree before the repository exists; the
        // work-tree is configured right after initialization instead.
        await this.runInit();
      }
      await this.run(["config", "core.bare", "false"]);
      await this.run(["config", "core.worktree", this.root]);
      await this.run(["config", "core.autocrlf", "false"]);
      await this.run(["config", "core.hooksPath", this.hooksDir]);
    } catch (err) {
      this.ready = null;
      if (err instanceof HistoryError) throw err;
      throw new HistoryError(
        "git-unavailable",
        `Could not initialize internal history: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** Records the current on-disk state of `paths` and returns the commit hash. */
  async snapshot(label: string, paths: string[]): Promise<string> {
    await this.ensure();
    const relative = paths.map((filePath) => this.relativePath(filePath));
    if (relative.length === 0) throw new HistoryError("no-paths", "No files to record");
    try {
      // A file created by this plan does not exist yet; a deleted file is no
      // longer on disk but is still tracked, so include it to stage the
      // deletion. Paths that match neither would make `git add` fail.
      const stageable: string[] = [];
      /* eslint-disable no-await-in-loop -- inspect each planned path */
      for (const item of relative) {
        try {
          await fs.access(path.resolve(this.root, item));
          stageable.push(item);
          continue;
        } catch {
          // not on disk; stage it only when the internal repository tracks it
        }
        try {
          await this.run(["ls-files", "--error-unmatch", "--", item]);
          stageable.push(item);
        } catch {
          // never existed in this history
        }
      }
      /* eslint-enable no-await-in-loop */
      if (stageable.length > 0) {
        await this.run(["add", "--all", "--force", "--", ...stageable]);
      }
      await this.run([
        "commit",
        "--quiet",
        "--no-verify",
        "--allow-empty",
        "-m",
        `skein ${label}`,
      ]);
      const { stdout } = await this.run(["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch (err) {
      if (err instanceof HistoryError) throw err;
      throw new HistoryError("history-record-failed", `Could not record ${label}`, { cause: err });
    }
  }

  /** Returns the recorded text, or null when the file is absent in that commit. */
  async readText(commit: string, filePath: string): Promise<string | null> {
    await this.ensure();
    const relative = this.relativePath(filePath);
    try {
      const { stdout } = await this.run(["show", `${commit}:${relative}`], { encoding: "buffer" });
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      if (buffer.includes(0)) {
        throw new HistoryError("binary-unsupported", `Binary file: ${relative}`);
      }
      return buffer.toString("utf8");
    } catch (err) {
      if (err instanceof HistoryError && err.reason === "binary-unsupported") throw err;
      return null;
    }
  }

  async hasFile(commit: string, filePath: string): Promise<boolean> {
    await this.ensure();
    const relative = this.relativePath(filePath);
    try {
      await this.run(["cat-file", "-e", `${commit}:${relative}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Commits written by this tool, newest first. */
  async log(limit = 50): Promise<GitCommitInfo[]> {
    await this.ensure();
    try {
      const { stdout } = await this.run([
        "log",
        `--max-count=${limit}`,
        "--format=%H%x00%ct%x00%s",
      ]);
      return stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [hash, timestamp, ...message] = line.split("\0");
          return { hash, createdAt: Number(timestamp) * 1000, message: message.join("\0") };
        });
    } catch {
      // An empty repository has no HEAD yet.
      return [];
    }
  }

  private relativePath(filePath: string): string {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(this.root, filePath);
    const relative = normalizePath(path.relative(this.root, absolute));
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative)
    ) {
      throw new HistoryError("path-not-allowed", `Path outside workspace: ${filePath}`);
    }
    return relative;
  }

  private run(
    args: string[],
    options: { encoding?: "utf8" | "buffer" } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const fullArgs = [
      "--git-dir",
      this.gitDir,
      "--work-tree",
      this.root,
      ...this.configArgs(),
      ...args,
    ];
    return this.exec(fullArgs, options);
  }

  /** `git init` must run before a work-tree can be attached. */
  private runInit(): Promise<{ stdout: string; stderr: string }> {
    return this.exec(
      ["--git-dir", this.gitDir, ...this.configArgs(), "init", "--quiet", "--bare", this.gitDir],
      {},
    );
  }

  private configArgs(): string[] {
    return [
      "-c",
      "user.name=Skein",
      "-c",
      "user.email=skein@localhost",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
    ];
  }

  private exec(
    fullArgs: string[],
    options: { encoding?: "utf8" | "buffer" },
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", fullArgs, {
      cwd: this.root,
      encoding: options.encoding ?? "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      },
    }) as unknown as Promise<{ stdout: string; stderr: string }>;
  }
}
