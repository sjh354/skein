---
paths:
  - "src/webview/**/*.{ts,tsx}"
---

# React Webview

- Webview runs in browser context; access VS Code only through acquired webview API and typed messages.
- Never put callback props in `useMemo`/`useCallback` dependencies. Store current callbacks in a ref and depend only on stable data.
- Reset effects may depend only on `[expandAll, resetToken, currentFilePath]` unless existing behavior is deliberately redesigned and tested.
- Use Set references directly in dependency arrays; do not create arrays inline merely for comparison.
- Normalize path values before storing them in React Sets/Maps.
- `src/webview/index.tsx` builds `dist/webview.js`; the file, symbol, call-graph and architecture views share it.
