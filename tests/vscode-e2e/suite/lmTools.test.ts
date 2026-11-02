/**
 * E2E Tests for native Language Model Tools registration.
 *
 * Verifies that after extension activation all 23 Skein LM tools
 * are present in `vscode.lm.tools`.  Tests are skipped gracefully when the
 * VS Code host doesn't support `vscode.lm.tools` (pre-1.90 or non-Copilot
 * environments) so they never cause false failures on older CI agents.
 *
 * New tools added in session (v1.8.0):
 *   - skein_resolve_module_path
 *   - skein_analyze_breaking_changes
 *   - skein_query_call_graph
 *   - skein_scan_dead_code
 */

import { before } from 'mocha';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

// Minimum set of expected tool names (all 23).
const EXPECTED_TOOLS = [
  'skein_find_referencing_files',
  'skein_analyze_dependencies',
  'skein_crawl_dependency_graph',
  'skein_get_symbol_graph',
  'skein_find_unused_symbols',
  'skein_get_symbol_callers',
  'skein_get_impact_analysis',
  'skein_get_index_status',
  'skein_parse_imports',
  'skein_generate_codemap',
  'skein_expand_node',
  'skein_verify_dependency_usage',
  'skein_invalidate_files',
  'skein_rebuild_index',
  'skein_get_symbol_dependents',
  'skein_trace_function_execution',
  'skein_analyze_file_logic',
  // v1.8.0 batch 2
  'skein_resolve_module_path',
  'skein_analyze_breaking_changes',
  'skein_query_call_graph',
  'skein_scan_dead_code',
  'skein_graph_context',
  'skein_query_natural_language',
];

/** Returns true when vscode.lm.tools is supported by the current host. */
function lmToolsSupported(): boolean {
  return (
    typeof vscode.lm === 'object' &&
    vscode.lm !== null &&
    'tools' in vscode.lm &&
    Array.isArray((vscode.lm as unknown as { tools: unknown }).tools)
  );
}

/** Returns registered tools as a plain array, or [] when unsupported. */
function getRegisteredTools(): ReadonlyArray<{ name: string }> {
  if (!lmToolsSupported()) return [];
  return (vscode.lm as unknown as { tools: ReadonlyArray<{ name: string }> }).tools;
}

suite('LM Tools Registration Test Suite', () => {
  before(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('sjh354.skein');
    assert.ok(ext, 'Extension should exist');
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  test('vscode.lm.registerTool is supported in this VS Code version', function () {
    const supported = typeof (vscode.lm as Record<string, unknown>).registerTool === 'function';
    if (!supported) {
      this.skip();
    }
    assert.ok(supported, 'vscode.lm.registerTool should be a function');
  });

  test('All 23 Skein LM tools are registered', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const registeredNames = new Set(getRegisteredTools().map((t) => t.name));

    const missing = EXPECTED_TOOLS.filter((name) => !registeredNames.has(name));
    assert.strictEqual(
      missing.length,
      0,
      `Missing LM tools: ${missing.join(', ')}`,
    );
  });

  test('resolve_module_path tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'skein_resolve_module_path');
    assert.ok(tool, 'skein_resolve_module_path should be registered');
  });

  test('analyze_breaking_changes tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'skein_analyze_breaking_changes');
    assert.ok(tool, 'skein_analyze_breaking_changes should be registered');
  });

  test('query_call_graph tool is registered with correct name', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tool = getRegisteredTools().find((t) => t.name === 'skein_query_call_graph');
    assert.ok(tool, 'skein_query_call_graph should be registered');
  });

  test('Total Skein tool count is exactly 23', function () {
    if (!lmToolsSupported()) {
      this.skip();
    }

    const tools = getRegisteredTools();
    const skeinTools = tools.filter((t) => t.name.startsWith('skein_'));
    assert.strictEqual(
      skeinTools.length,
      23,
      `Expected 23 skein tools, found ${skeinTools.length}: ${skeinTools.map((t) => t.name).join(', ')}`,
    );
  });
});
