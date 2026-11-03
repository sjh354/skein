/**
 * Cross-process file lock used by the shared state file and the change history.
 *
 * Both writers live in the extension host, but a crashed writer or a second
 * window must not interleave a read-modify-write cycle. The lock is a file
 * created with O_EXCL; a lock older than `staleAfterMs` is treated as abandoned.
 *
 * NO vscode imports — this module is used by the extension and its unit tests.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileLockOptions {
  /** How long a writer waits for an existing lock. */
  timeoutMs?: number;
  /** A lock file older than this is removed and retried. */
  staleAfterMs?: number;
  /** Poll interval while waiting. */
  retryDelayMs?: number;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes read-modify-write cycles across processes. The lock file is
 * created next to the data it protects and removed in `finally`.
 */
export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 20;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  /* eslint-disable no-await-in-loop -- acquiring and releasing the lock is inherently sequential */
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        return await action();
      } finally {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleAfterMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("lock-timeout", { cause: err });
      await sleep(retryDelayMs);
    }
  }
  /* eslint-enable no-await-in-loop */
}
