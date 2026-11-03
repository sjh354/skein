/**
 * Code fingerprint for change plans (DESIGN 8.4).
 *
 * A plan is only applied when the files it was computed against still have the
 * same saved content. A missing file is part of the fingerprint too, so a
 * create/delete/undo plan cannot be applied to a different tree.
 */

import * as fs from "node:fs/promises";
import type { ChangeFileState, ChangeFingerprint } from "@/shared/change";
import { hashContent, isProtectedChangePath } from "@/shared/change";
import { normalizePath } from "@/shared/path";

export async function readFileState(filePath: string): Promise<ChangeFileState> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { path: normalizePath(filePath), exists: true, sha256: hashContent(content) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: normalizePath(filePath), exists: false, sha256: null };
    }
    throw err;
  }
}

export async function captureFingerprint(
  root: string,
  paths: string[],
  graphVersion: number,
): Promise<ChangeFingerprint> {
  const files: ChangeFileState[] = [];
  /* eslint-disable no-await-in-loop -- one small read per changed file */
  for (const filePath of paths) {
    if (isProtectedChangePath(filePath, root)) {
      throw new Error(`path-not-allowed: ${filePath}`);
    }
    files.push(await readFileState(filePath));
  }
  /* eslint-enable no-await-in-loop */
  return { files, graphVersion };
}

export interface FingerprintCheck {
  ok: boolean;
  reason?: "stale-plan";
  /** Files whose saved content or existence no longer matches the plan. */
  changed: string[];
}

export async function compareFingerprint(
  fingerprint: ChangeFingerprint,
): Promise<FingerprintCheck> {
  const changed: string[] = [];
  /* eslint-disable no-await-in-loop -- comparing a handful of files */
  for (const expected of fingerprint.files) {
    const actual = await readFileState(expected.path);
    if (actual.exists !== expected.exists || actual.sha256 !== expected.sha256) {
      changed.push(expected.path);
    }
  }
  /* eslint-enable no-await-in-loop */
  return changed.length === 0 ? { ok: true, changed } : { ok: false, reason: "stale-plan", changed };
}
