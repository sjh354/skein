/**
 * Atomic file writes: a temporary file in the same directory, then a rename, so
 * a reader never sees a half-written file. The pid and a counter keep two
 * processes (and two writes in one process) from sharing a temporary name.
 *
 * NO vscode imports — used by the extension, the MCP server, the analyzer and tests.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

let temporaryFileCounter = 0;

function temporaryPathFor(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${++temporaryFileCounter}.tmp`,
  );
}

export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = temporaryPathFor(filePath);
  await fs.writeFile(temporaryPath, data);
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (err) {
    await fs.rm(temporaryPath, { force: true });
    throw err;
  }
}

/** Synchronous variant for the index cache, whose save runs inside sync dispose paths. */
export function writeFileAtomicSync(filePath: string, data: string | Uint8Array): void {
  const temporaryPath = temporaryPathFor(filePath);
  fsSync.writeFileSync(temporaryPath, data);
  try {
    fsSync.renameSync(temporaryPath, filePath);
  } catch (err) {
    fsSync.rmSync(temporaryPath, { force: true });
    throw err;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
