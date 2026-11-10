#!/usr/bin/env node
/**
 * Ranking benchmark for `skein_graph_context` search mode.
 *
 * Runs the labelled queries of tests/benchmarks/graph-context-queries.json against the built
 * MCP server (dist/mcpServer.mjs) once per ranking and prints hit@1, hit@5 and MRR over files:
 * the rank of a query is the first position, in the order of the returned seeds, whose file is one
 * of the gold files.
 *
 * Usage: npm run build && node scripts/bench-graph-context.mjs [workspace] [lexical,ppr]
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(process.argv[2] ?? repoRoot);
const rankings = (process.argv[3] ?? 'lexical,ppr').split(',');
const { queries } = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests', 'benchmarks', 'graph-context-queries.json'), 'utf8'),
);

class Client {
  constructor(env) {
    this.next = 1;
    this.pending = new Map();
    this.child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'mcpServer.mjs')], {
      cwd: workspace,
      env: { ...process.env, WORKSPACE_ROOT: workspace, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
  }

  request(method, params, timeoutMs = 60_000) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'skein-bench', version: '1.0.0' },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  }

  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    return result.structuredContent?.data ?? JSON.parse(result.content[0].text);
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

/** File of a seed id (`symbol:<path>:<name>:<line>`, `file:<path>`, `test:<path>:…`). */
function fileOfSeed(id, nodesById) {
  return nodesById.get(id)?.path ?? id.split(':')[1];
}

async function measure(ranking) {
  const client = new Client({ SKEIN_GRAPH_CONTEXT_RANKING: ranking });
  await client.initialize();
  // Warm the index so the first query is not an outlier.
  await client.call('skein_set_workspace', { workspacePath: workspace, response_format: 'json' });
  const results = [];
  for (const query of queries) {
    const data = await client.call('skein_graph_context', {
      mode: 'search',
      question: query.question,
      maxNodes: 60,
      detail: 'compact',
      response_format: 'json',
    });
    const nodesById = new Map((data.nodes ?? []).map((node) => [node.id, node]));
    const files = [];
    for (const seed of data.seeds ?? []) {
      const file = fileOfSeed(seed, nodesById);
      if (file && !files.includes(file)) files.push(file);
    }
    const rank = files.findIndex((file) => query.gold.includes(file)) + 1;
    results.push({ question: query.question, rank: rank || null });
  }
  client.close();
  return results;
}

function summarize(results) {
  const ranks = results.map((result) => result.rank);
  const hits = (k) => ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length;
  const mrr = ranks.reduce((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length;
  return { 'hit@1': hits(1), 'hit@5': hits(5), MRR: mrr, missing: ranks.filter((rank) => rank === null).length };
}

const all = {};
for (const ranking of rankings) {
  all[ranking] = await measure(ranking);
  const summary = summarize(all[ranking]);
  console.log(`${ranking.padEnd(8)} queries=${queries.length}`, Object.entries(summary).map(([key, value]) => `${key}=${typeof value === 'number' && value < 1.001 && key !== 'missing' ? value.toFixed(3) : value}`).join(' '));
}
if (rankings.length === 2) {
  const [first, second] = rankings;
  console.log(`\nper-query rank changes (${first} -> ${second}):`);
  queries.forEach((query, index) => {
    const before = all[first][index].rank;
    const after = all[second][index].rank;
    if (before !== after) console.log(`  ${before ?? '-'} -> ${after ?? '-'}  ${query.question}`);
  });
}
process.exit(0);
