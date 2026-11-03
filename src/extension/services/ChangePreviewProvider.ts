/**
 * Virtual documents for change previews (DESIGN 8.4).
 *
 * `vscode.diff` needs both sides to be documents. The "after" side is served
 * from memory so a preview does not write to disk before the user applies it.
 */

import * as vscode from "vscode";

export class ChangePreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  static readonly scheme = "skein-preview";

  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(
      ChangePreviewProvider.scheme,
      this,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  /** Registers the planned content and returns the URI to diff against. */
  set(planId: string, filePath: string, content: string): vscode.Uri {
    return this.setSide(planId, filePath, "after", content);
  }

  /** Registers the before content of a file that does not exist yet. */
  setBefore(planId: string, filePath: string, content: string): vscode.Uri {
    return this.setSide(planId, filePath, "before", content);
  }

  private setSide(
    planId: string,
    filePath: string,
    side: "before" | "after",
    content: string,
  ): vscode.Uri {
    const uri = vscode.Uri.parse(
      `${ChangePreviewProvider.scheme}:/${encodeURIComponent(filePath)}?plan=${encodeURIComponent(planId)}&side=${side}`,
    );
    this.contents.set(uri.toString(), content);
    return uri;
  }

  clear(): void {
    this.contents.clear();
  }

  dispose(): void {
    this.contents.clear();
    this.registration.dispose();
  }
}
