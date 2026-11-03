#!/usr/bin/env node
/**
 * Runs the step-6 move/extract/inline verification in one VS Code launch.
 *
 * The sandbox is a disposable copy of `tests/fixtures/refactor-template` with a
 * real user Git repository. The suite drives the real MCP stdio server and the
 * extension command bridge: move (create/undo/redo), extract, inline and a
 * stale-plan rejection, then checks that the user's HEAD and index never move.
 *
 * Usage: npm run test:refactor
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = path.join(repoRoot, "tests", "fixtures", "refactor-template");
const sandbox = path.join(repoRoot, "tests", "fixtures", "refactor-sandbox");

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
  // Dirty user state the tool must leave alone.
  fs.writeFileSync(path.join(sandbox, "staged.txt"), "staged by the user\n", "utf8");
  git(["add", "staged.txt"]);
  fs.writeFileSync(path.join(sandbox, "notes.txt"), "untracked user notes\n", "utf8");
}

console.log("\n=== refactor E2E (move/extract/inline) ===\n");
clean();
prepareSandbox();
const result = spawnSync("npm", ["run", "test:vscode"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, E2E_WORKSPACE: sandbox, E2E_SUITE_GLOB: "suite/refactor.test.js" },
});
clean();
process.exit(result.status ?? 1);
