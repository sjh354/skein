#!/usr/bin/env node
/**
 * Runs the step-5 change-history verification in two VS Code launches.
 *
 * Phase 1 works in a disposable copy of `tests/fixtures/change-template`:
 * plan → apply → history → undo → redo → conflict → stale plan, plus checks
 * that the user's Git HEAD/index/branch never move.
 *
 * Between the launches this script writes a task left in `applying`, so phase 2
 * proves that activation classifies an interrupted change instead of silently
 * applying or rolling it back.
 *
 * Usage: npm run test:change
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repoRoot, "tests", "fixtures", "change-template");
const sandbox = path.join(repoRoot, "tests", "fixtures", "change-sandbox");
const appPath = path.join(sandbox, "src", "app.ts");

function clean() {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function prepareSandbox() {
  clean();
  fs.cpSync(template, sandbox, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: sandbox, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "user@example.com"]);
  git(["config", "user.name", "User"]);
  git(["add", "."]);
  git(["commit", "-qm", "sandbox baseline"]);
  // A dirty user repository: the tool must not stage or commit these files.
  fs.writeFileSync(path.join(sandbox, "staged.txt"), "staged by the user\n", "utf8");
  git(["add", "staged.txt"]);
  fs.writeFileSync(path.join(sandbox, "notes.txt"), "untracked user notes\n", "utf8");
}

function sha256(content) {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function seedInterruptedTask() {
  const current = fs.readFileSync(appPath, "utf8").replace(/\r\n/g, "\n");
  const original = fs.readFileSync(path.join(template, "src", "app.ts"), "utf8").replace(/\r\n/g, "\n");
  if (current === original) {
    throw new Error("Phase 1 did not change the sandbox; cannot seed an interrupted task.");
  }
  const lines = original.split("\n");
  const lastLine = lines.length - 1;
  const planId = "plan-interrupted";
  const task = {
    schemaVersion: 1,
    status: "applying",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: {
      id: planId,
      kind: "rename",
      createdAt: Date.now(),
      workspaceRoot: sandbox.replaceAll("\\", "/"),
      graphVersion: 1,
      source: "ui",
      target: { name: "alpha", newName: "gamma", path: appPath.replaceAll("\\", "/"), line: 0 },
      files: [
        {
          path: appPath.replaceAll("\\", "/"),
          beforeContent: original,
          edits: [
            {
              startLine: 0,
              startCharacter: 0,
              endLine: lastLine,
              endCharacter: lines[lastLine].length,
              newText: current,
            },
          ],
        },
      ],
      fingerprint: {
        files: [
          {
            path: appPath.replaceAll("\\", "/"),
            exists: true,
            sha256: sha256(original),
          },
        ],
        graphVersion: 1,
      },
    },
  };
  const directory = path.join(sandbox, ".skein", "history", "tasks");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${planId}.json`),
    `${JSON.stringify(task, null, 2)}\n`,
    "utf8",
  );
}

function runPhase(glob, label) {
  console.log(`\n=== ${label} (E2E_SUITE_GLOB=${glob}) ===\n`);
  const result = spawnSyncSafe(glob);
  if (result.error) {
    console.error(`Failed to start ${label}:`, result.error);
    return 1;
  }
  return result.status ?? 1;
}

function spawnSyncSafe(glob) {
  return spawnSync("npm", ["run", "test:vscode"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, E2E_WORKSPACE: sandbox, E2E_SUITE_GLOB: glob },
  });
}

clean();
prepareSandbox();
let status = runPhase("suite/changeHistory.test.js", "phase 1: plan/apply/undo/redo");
if (status === 0) {
  seedInterruptedTask();
  status = runPhase("suite/changeRecovery.test.js", "phase 2: interrupted-task recovery");
} else {
  console.error("\nPhase 1 failed; skipping the recovery phase.");
}
clean();
process.exit(status);
