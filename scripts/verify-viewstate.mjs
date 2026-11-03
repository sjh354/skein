#!/usr/bin/env node
/**
 * Runs the step-4 view-state E2E verification in two VS Code launches.
 *
 * Phase 1 leaves depth/filter/selection in tests/fixtures/.skein/state.json and
 * writes a marker; phase 2 starts a fresh extension host and checks that the
 * extension restored them.
 *
 * Usage: npm run test:viewstate
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = path.join(repoRoot, 'tests', 'fixtures', '.skein');

function cleanState() {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

function runPhase(glob, label) {
  console.log(`\n=== ${label} (E2E_SUITE_GLOB=${glob}) ===\n`);
  const result = spawnSync('npm', ['run', 'test:vscode'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, E2E_SUITE_GLOB: glob },
  });
  if (result.error) {
    console.error(`Failed to start ${label}:`, result.error);
    return 1;
  }
  return result.status ?? 1;
}

cleanState();
let status = runPhase('suite/viewState.test.js', 'phase 1: MCP round trip');
if (status === 0) {
  status = runPhase('suite/viewStateRestore.test.js', 'phase 2: restart restore');
} else {
  console.error('\nPhase 1 failed; skipping the restart phase.');
}
cleanState();
process.exit(status);
