# 8단계 기준선 — 변경 전 검증 결과

`docs/DESIGN.md` 13.2 8단계의 "원본 문제와 새 변경 문제 구분"을 위해 변경 전 상태를 기록했다.

- 측정일: 2026-11-03 (Asia/Seoul)
- 브랜치: `chore/8-prune-integration` (분기 직후, 코드 변경 전)
- Node.js: 26.3.0, VS Code 테스트 런타임: 1.144.1

## 통과

| 검사 | 결과 |
|---|---|
| `npm run check:types` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | 285 files, 4,478 passed, 18 skipped |
| `npm run test:diagnostics` | 23 files, 465 passed |

## 기준선 실패 (변경 전부터 존재)

`npm run test:vscode` 전체 실행: **184 passing, 3 pending, 12 failing**. 단계별 스크립트(`test:viewstate`·`test:change`·`test:refactor`)는 별도 워크스페이스를 지정하므로 전체 실행과 결과가 다르다.

| # | 스위트 | 실패 | 원인 |
|---|---|---|---|
| 1 | Webview Protocol | `viewMode` 초기값이 `file`이 아님 | 다른 스위트가 남긴 뷰 상태 |
| 2–3 | View State restore (phase 2) | 복원된 깊이·필터·선택 대기 시간 초과 | phase 1 상태가 남은 채 전체 실행 |
| 4 | View State MCP round trip (phase 1) | 기본 깊이 1 대신 3 | 이전 실행의 `.skein/state.json` 영향 |
| 5–7 | Step 5·6 변경 스위트 | 샌드박스가 아니라 `fixtures`를 워크스페이스로 사용 | 전체 실행에는 `E2E_WORKSPACE`가 설정되지 않음 |
| 8–12 | Architecture view | 그룹·엣지·파일 수가 하드코딩 기대값과 다름(예: 28≠26, 267≠217) | 픽스처 기준값이 현재 분석 결과와 어긋남 |

따라서 8단계 후 전체 `test:vscode`를 다시 실행해 **위 12개 외의 새 실패가 없는지**를 비교한다. 단계별 스크립트는 각각 독립 실행해 통과 여부를 기록한다.

## 제거 전 패키지 구성

- 커맨드 23개, MCP 도구 31개, VS Code 언어 모델 도구 23개
- 런타임 번들: `dist/extension.js`, `indexerWorker.js`, `astWorker.js`, `mcpServer.mjs`, `mcpWorker.js`, `webview.js`, `callgraph.js`
- 직접 의존성 중 사용처 없음: `vis-network`(소스·테스트 import 0), `ajv`(직접 import 0)
