# 8단계 대체표 — 기존 화면과 현재 표면

`docs/DESIGN.md` 13.2 8단계의 "예전 화면의 기능 대체표 확인" 결과다. 실제 화면 확인 없이 코드·테스트·패키지 구성으로 확인한 내용만 적었다. 수동 확인이 필요한 판정은 "수동 확인 대기"로 남긴다.

- 작성일: 2026-11-03 (Asia/Seoul)
- 기준: `chore/8-prune-integration` 브랜치
- 자동 근거: `npm test`, `npm run test:diagnostics`, VS Code E2E 스위트, `npm run package`

## 표면

| 기존 표면 | 현재 표면 | 코드 근거 | 판정 |
|---|---|---|---|
| 하단 패널 의존성 그래프 | 같은 `App`을 패널과 에디터 탭이 공유 | `GraphProvider.resolveWebviewView`, `WebviewManager.getHtmlForWebview(host)` | 유지 |
| 에디터 제목 그래프 아이콘 | `showEditorGraph` → `WebviewPanel` | `GraphProvider.showEditorGraph`, `package.json` `editor/title` | 유지 |
| 파일 그래프 | 파일 모드 `ReactFlowGraph` | `App.tsx` `viewMode === "file"` | 유지 |
| Symbol View 그래프 | 심벌 모드 `ReactFlowGraph` | `App.tsx` `symbolViewMode === "graph"` | 유지 |
| Symbol View 원자형 | `AtomicSymbolGraph` (기본값) | `App.tsx` `symbolViewMode === "atomic"` | 유지 |
| Symbol View 목록 | `SymbolCardView` | `App.tsx` `viewMode === "list"` | 유지 |
| Live Call Graph | `App` 내부 `CytoscapeGraph` | `App.tsx` `viewMode === "callgraph"` | 유지 |
| Call Graph 전용 webview 번들 | `dist/callgraph.js`는 어떤 런타임 코드도 로드하지 않음 | `esbuild.js`의 `callgraphWebview`만 참조 | **제거** |
| Architecture View | `ArchitectureGraph` + `ArchitectureViewService` | `viewMode === "architecture"`, `skein_explore_architecture` | 유지 |
| 역참조·미사용 필터·전체 펼침 | 파일 모드 메뉴 | `package.json` `view/title` | 유지 |
| `skein.toggleViewMode` | `skein.setViewMode{File,List,Symbol,Architecture}` + 툴바 | `CommandRegistrationService` | 제거(2026-11-03 사용자 결정: 사용 중인 연결 없음) |
| Copilot 언어 모델 도구 | MCP와 별도로 VS Code 안에서 동작 | `LmToolsService`, `package.json` `languageModelTools` | 유지(2026-11-03 사용자 지원 지속 결정) |
| CLI·위키·Review Gate·Branch Watch | 이미 제거됨 | `git log --grep 'remove the CLI'`, 남은 참조 없음 | 완료 |

## 이번 단계에서 제거한 것

- `src/webview/callgraph/index.tsx`와 `dist/callgraph.js` 번들: 런타임 로더가 없었다.
- `src/analyzer/export/HtmlExporter.ts`: 위키/HTML 내보내기 표면 제거 뒤 테스트만 남아 있었다.
- `src/webview/hooks/useGraphData.ts`, `src/webview/utils/clusterUtils.ts`: `App`/`ReactFlowGraph`로 대체됐다.
- `src/analyzer/utils/removedNameImporters.ts`, `workspaceText.ts`: 삭제된 CLI·Review Gate 경로의 보조 모듈이었다.
- `src/analyzer/llm/{LlmClientFactory,AnthropicLlmClient,OpenAiCompatibleLlmClient,CopilotCliLlmClient}.ts`: LLM 호출 표면이 제거된 뒤 남아 있었다. `QueryEngine`의 주입 지점(`LlmClient` 타입)은 테스트용으로 유지한다.
- `src/shared/index.ts`: 아무도 사용하지 않는 배럴이다.

## 남은 수동 확인

- [ ] 패널과 에디터 탭이 같은 분석 세션을 공유하고, 한쪽에서 바꾼 선택·배치가 다른 쪽에 반영되는가
- [x] `skein.toggleViewMode` 제거 결정 및 등록·기여·구현 제거
- [x] Copilot 언어 모델 도구 계속 지원 결정, 기존 구현 유지
- [ ] 삭제한 렌더러·모듈의 대체 화면이 실제 VS Code에서 동일하게 동작하는가
