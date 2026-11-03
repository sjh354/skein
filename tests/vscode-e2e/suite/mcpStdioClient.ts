/**
 * Minimal MCP stdio client for E2E tests.
 *
 * The real `dist/mcpServer.mjs` process is spawned so the view-state round trip
 * goes through the same files and protocol a Codex/Copilot client uses. The
 * transport is newline-delimited JSON-RPC (MCP stdio binding).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

export interface McpToolResult {
  /** `structuredContent.data` from the formatted tool response. */
  data: any;
  /** True when the MCP client should treat the call as failed. */
  isError: boolean;
  raw: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const INITIALIZE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 20_000;

export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: readline.Interface;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly serverPath: string,
    private readonly workspaceRoot: string,
    extraEnv: Record<string, string> = {},
  ) {
    this.child = spawn(process.execPath, [serverPath], {
      cwd: workspaceRoot,
      env: { ...process.env, WORKSPACE_ROOT: workspaceRoot, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Keep stderr drained; the server logs there.
    this.child.stderr.resume();
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    this.child.on('exit', (code) => {
      this.closed = true;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server exited (code ${code ?? 'unknown'})`));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'skein-e2e', version: '1.0.0' },
      },
      INITIALIZE_TIMEOUT_MS,
    );
    if (!result?.protocolVersion) {
      throw new Error(`Unexpected initialize result: ${JSON.stringify(result)}`);
    }
    this.notify('notifications/initialized', {});
  }

  /** Calls a tool and returns `structuredContent.data`. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<McpToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (!result || !Array.isArray(result.content)) {
      throw new Error(`Unexpected tools/call result: ${JSON.stringify(result)}`);
    }
    const data = result.structuredContent?.data ?? parseFirstText(result.content);
    return { data, isError: result.isError === true || result.structuredContent?.success === false, raw: result };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 3_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'));
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return; // notification / server request
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
    } else {
      pending.resolve(message.result);
    }
  }
}

function parseFirstText(content: Array<{ type: string; text?: string }>): any {
  const text = content.find((part) => part.type === 'text' && typeof part.text === 'string')?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
