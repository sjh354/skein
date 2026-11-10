import { mkdtemp, open, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "@/shared/lock";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withFileLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "skein-lock-"));
    lockPath = path.join(dir, "lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a live holder's lock past staleAfterMs instead of handing it to a waiter", async () => {
    const events: string[] = [];
    const options = { staleAfterMs: 120, timeoutMs: 2_000 };
    const holder = withFileLock(lockPath, async () => {
      events.push("a-start");
      await sleep(400);
      events.push("a-end");
    }, options);
    await sleep(20);
    const waiter = withFileLock(lockPath, async () => {
      events.push("b-start");
    }, options);
    await Promise.all([holder, waiter]);
    expect(events).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("takes over a lock whose holder died", async () => {
    const handle = await open(lockPath, "wx");
    await handle.close();
    const stale = new Date(Date.now() - 10_000);
    await utimes(lockPath, stale, stale);
    const result = await withFileLock(lockPath, async () => "ran", { staleAfterMs: 5_000, timeoutMs: 500 });
    expect(result).toBe("ran");
  });

  it("gives up after timeoutMs while the lock is held", async () => {
    const holder = withFileLock(lockPath, () => sleep(300), { staleAfterMs: 5_000 });
    await sleep(20);
    await expect(
      withFileLock(lockPath, async () => undefined, { timeoutMs: 100, staleAfterMs: 5_000 }),
    ).rejects.toThrow("lock-timeout");
    await holder;
  });
});
