import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureFingerprint,
  compareFingerprint,
  readFileState,
} from "@/analyzer/change/fingerprint";
import { normalizePath } from "@/shared/path";
import { hashContent } from "@/shared/change";

describe("change fingerprint", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skein-fingerprint-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.ts"), "alpha\r\n", "utf8");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("describes an existing file with a normalized hash", async () => {
    const state = await readFileState(path.join(root, "src", "app.ts"));
    expect(state.exists).toBe(true);
    expect(state.sha256).toBe(hashContent("alpha\n"));
  });

  it("describes a missing file", async () => {
    const state = await readFileState(path.join(root, "src", "missing.ts"));
    expect(state).toEqual({
      path: normalizePath(path.join(root, "src", "missing.ts")),
      exists: false,
      sha256: null,
    });
  });

  it("captures and compares fingerprints", async () => {
    const file = path.join(root, "src", "app.ts");
    const fingerprint = await captureFingerprint(root, [file], 4);
    expect(fingerprint.graphVersion).toBe(4);
    expect(await compareFingerprint(fingerprint)).toEqual({ ok: true, changed: [] });

    await fs.writeFile(file, "beta\n", "utf8");
    expect(await compareFingerprint(fingerprint)).toMatchObject({
      ok: false,
      reason: "stale-plan",
      changed: [normalizePath(file)],
    });
  });

  it("detects a deleted file", async () => {
    const file = path.join(root, "src", "app.ts");
    const fingerprint = await captureFingerprint(root, [file], 1);
    await fs.rm(file);
    expect((await compareFingerprint(fingerprint)).ok).toBe(false);
  });

  it("refuses to fingerprint protected paths", async () => {
    await expect(
      captureFingerprint(root, [path.join(root, ".skein", "state.json")], 1),
    ).rejects.toThrow("path-not-allowed");
  });
});
