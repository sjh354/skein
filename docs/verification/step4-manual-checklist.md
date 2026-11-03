# 4단계 수동 검증 — 자동화 이후 남은 항목

`docs/DESIGN.md` 13.2 4단계의 완료 기준 중 자동화로 확인한 부분과, 실제 화면을 봐야 하는 부분을 분리한다.

- 자동 검증: `npm run test:viewstate`
- 자동 검증 코드: `tests/vscode-e2e/suite/viewState.test.ts`, `tests/vscode-e2e/suite/viewStateRestore.test.ts`, `tests/vscode-e2e/suite/mcpStdioClient.ts`
- 실행 환경: 실제 VS Code 확장 호스트 + 실제 `dist/mcpServer.mjs` stdio 프로세스
- 기준 커밋: `27ece7a`

## 1. 자동 검증이 확인하는 것

`npm run test:viewstate`는 VS Code를 두 번 실행한다.

### 1단계 — MCP 왕복 (11개 검사)

- `.skein/state.json`(스키마 2)에 `mode`·`filePath`·`rootSymbolId`·`depth`·`graphVersion`이 게시된다
- 콜 그래프 노드 좌표·줌·팬(`layout`)이 게시되고, 재시작 후에도 유지된다
- 창별 스냅샷(`windows`)과 `activeWindowId`가 게시되고, 명령은 활성 창으로 전달된다
- `skein_get_view_state`가 게시된 상태와 같은 루트/버전을 반환하고 창 목록을 요약해 준다
- `skein_control_view select`가 선택을 바꾸고 `state.json`에 반영된다
- `set_depth`가 그래프를 재질의하고 `graphVersion`을 올린다
- `set_filter`가 nodeType·edgeType 숨김을 게시하고 해제한다
- `open_file`이 지정한 파일·줄·열로 에디터를 연다
- 이전 `graphVersion`으로 보낸 명령이 `stale-graph-version`으로 거부된다
- `set_expand_all`이 의존성 그래프 상태를 바꾼다
- 확장이 없을 때 `extension-not-responding`으로 끝나고 요청 파일이 남지 않는다
- 알 수 없는 `nodeId` 선택이 `node-not-found`로 거부된다
- 다음 단계를 위해 depth 3·필터·선택·배치 상태와 기준 파일을 남긴다

### 2단계 — 재시작 복원 (2개 검사)

- 재시작 직후 새 `state.json`이 게시되고, 뷰 모드가 `callgraph`가 아니어도 복원된 depth·필터·선택·배치가 유지된다
- `graphVersion`이 재시작 후에도 이전 세션 값을 이어받고, 콜 그래프를 다시 그리면 증가한다
- 콜 그래프 탭을 다시 열면 depth 3·필터·선택·배치가 실제로 복원된다

### 실행 방법

```bash
npm run build          # dist/mcpServer.mjs 갱신
npm run test:viewstate # phase 1 → phase 2
```

테스트는 `tests/fixtures`를 워크스페이스로 쓰고, 끝나면 `tests/fixtures/.skein`을 지운다. VS Code 창이 실제로 열린다.

## 2. 자동 검증에서 나온 발견

| 번호 | 내용 | 상태 |
|---|---|---|
| D1 | `skein_get_view_state`·`skein_control_view` 응답의 경로 축약이 노드 ID와 파일 경로까지 바꿔, MCP가 돌려준 `selection.nodeId`·`filePath`를 그대로 명령에 쓸 수 없었다. 뷰 상태 도구를 경로 축약에서 제외해 수정 | 수정·재검증 완료 |
| D2 | 존재하지 않는 `nodeId`로 `select`하면 `applied: true`를 반환하고 화면은 바뀌지 않았다. 현재 그래프의 노드 집합으로 검증해 `node-not-found`로 거부하도록 수정 | 수정·재검증 완료 |
| D3 | 재시작 후 복원된 뷰 모드가 `callgraph`가 아니면 `state.json`에서 depth·필터·선택이 사라졌다. 모드와 무관하게 마지막 콜 그래프 스냅샷을 유지하도록 수정 | 수정·재검증 완료 |
| D4 | 자동화 환경에서 1회, 확장 시작 시 워크스페이스 폴더를 찾지 못해 `.skein/state.json`이 생성되지 않았다. 폴더가 나타나면 MCP·상태 서비스를 다시 초기화하도록 수정 | 수정·재검증 완료(재현 조건은 반복 확인 필요) |

## 3. 사용자가 직접 확인할 항목

아래 항목은 자동화가 상태·프로토콜까지만 확인하고, 픽셀과 사용성은 확인하지 못한다.

사전 준비:

- [ ] `npm run build` 후 `F5`로 Extension Development Host 실행
- [ ] 테스트용 TS 파일(예: `src/extension/services/ViewStateService.ts`)을 열고 함수 안에 커서
- [ ] `Skein: Show Call Graph` 실행
- [ ] Codex에서 `codex mcp add skein --env WORKSPACE_ROOT=<repo> -- node <repo>/dist/mcpServer.mjs` 등록 (이미 있으면 생략)

### M1. 선택 하이라이트

- [ ] 그래프에서 노드를 클릭 → 해당 노드가 선택 표시되고 상세 패널이 열린다
- [ ] Codex에서 다른 노드를 `select` → 하이라이트와 상세 패널이 그 노드로 바뀐다
- [ ] 없는 노드를 `select` → `node-not-found` 거부 응답이 오고 화면은 그대로인가

자동화는 웹뷰가 선택을 되돌려주는 것까지만 확인했다.

### M2. 포커스 이동

- [ ] 그래프를 드래그·축소해 대상 노드를 화면 밖으로 보낸다
- [ ] Codex에서 그 노드를 `focus` → 뷰포트가 실제로 이동·확대되는가
- [ ] 선택만 바뀌고 화면이 움직이지 않으면 결함으로 기록

자동화는 재질의·렌더 카운트만 확인했다.

### M3. 필터의 시각 효과

- [ ] 범례에서 `Function` 타입을 끄고 노드가 사라지는가
- [ ] 폴더 필터를 끄고 해당 폴더 노드가 사라지는가
- [ ] `Outgoing call` 엣지를 끄고 엣지가 사라지는가
- [ ] Codex `set_filter`로도 같은 변화가 일어나는가

자동화는 `state.json`의 `hiddenFilters`만 확인했다.

### M4. 펼침/접힘

- [ ] `Skein: Switch to Graph View`로 의존성 그래프로 전환
- [ ] Codex `set_expand_all true` → 노드 묶음이 실제로 펼쳐지는가
- [ ] `set_expand_all false` → 접히는가

자동화는 `expandAll` 상태만 확인했다.

### M5. 재시작 후 배치·뷰포트

- [ ] 그래프 노드를 몇 개 드래그하고 확대/축소한다
- [ ] `Developer: Reload Window` 후 콜 그래프를 다시 연다
- [ ] 깊이·필터·선택이 복원되는가 (자동 검증 완료)
- [ ] **노드 배치와 줌·팬이 이전 화면과 같은가** (좌표·뷰포트 저장은 자동 검증 완료, 픽셀 일치만 수동)

### M6. 실제 클릭 기반 사용자 우선

- [ ] Codex에서 `timeoutMs: 8000`으로 `set_depth`를 호출한다
- [ ] 호출이 끝나기 전에 그래프에서 다른 노드를 클릭한다
- [ ] 응답이 `rejected` / `user-action-superseded`인가
- [ ] 클릭한 선택과 깊이가 유지되는가

단위 테스트만 있고 실제 웹뷰 클릭으로는 검증되지 않았다.

### M7. 멀티루트·두 창

- [ ] `File → Add Folder to Workspace`로 폴더를 추가하고 `Skein: Set Workspace Folder`로 전환
- [ ] `get_view_state`의 `workspaceRoot`와 상태가 폴더별로 분리되는가 (영역별 `state.json`)
- [ ] 같은 폴더를 `Duplicate Workspace`로 두 창에 열고, 양쪽에서 노드를 선택
- [ ] `get_view_state`의 `windows`에 두 창이 보이고, `windowId`로 각 창을 지정해 조작할 수 있는가
- [ ] 한쪽 선택이 다른 쪽 스냅샷을 지우지 않는가 (창별 병합)
- [ ] 실제 사용에서 혼선이 남아 있는지 판단

창별 스냅샷·잠금·명령 대상 지정은 구현·단위 검증했고, 실제 두 창 UAT는 남아 있다.

### M8. Codex 실제 호출

- [ ] Codex에서 `skein_get_view_state`를 호출해 상태를 읽는다
- [ ] 같은 응답의 `selection.nodeId` 또는 `callGraph.rootSymbolId`를 그대로 `select`에 넣는다
- [ ] 같은 응답의 `filePath`를 그대로 `open_file`에 넣는다
- [ ] 두 창이면 `windows`의 `windowId`를 `control_view`에 넘겨 대상을 지정할 수 있는가
- [ ] Codex가 도구·인자를 스스로 고르는 흐름에서 혼동이 없는가

자동화는 동일한 stdio 클라이언트로 검증했다. Codex 모델의 도구 선택 자체는 자동화할 수 없다.

### M9. 파일 열기 동작

- [ ] `open_file`이 기존 탭을 덮는 미리보기 탭으로 열리는가
- [ ] 사용자가 고정 탭을 기대하는 흐름에서 불편하지 않은가

자동화는 파일·줄·열만 확인했다.

### M10. 다른 뷰의 선택

- [ ] 파일·리스트·아키텍처 뷰에서 선택한 대상이 `state.json`의 `views`에 게시되는가
- [ ] 게시되지 않는다면, 해당 뷰에 선택 상태가 있는지 확인한다

2026-11-03 각 화면의 선택을 `views.file/list/symbol/architecture`에 게시하도록 연결했다. 실제 클릭과 MCP 선택이 같은 ID로 게시되는지 확인한다. 최상위 `selection`은 마지막 콜 그래프 선택을 보존한다. `surface`에는 현재 화면의 노드 ID·펼침·검색·분석 요약이 있다.

- [ ] `search`의 첫 일치 대상이 화면에서 선택·포커스되고 `surface.search`에 ID와 전체 일치 개수가 게시되는가
- [ ] 파일 그래프 `set_expanded`가 지정 노드만 펼치고 접는가
- [ ] 아키텍처 `set_architecture`의 graph/matrix·unit·folder·minImports가 실제 화면에 반영되는가
- [ ] 아키텍처 `surface.analysis.revision`과 상세 진단 조회의 revision을 비교해 다른 분석을 혼동하지 않는가

## 4. 기록 양식

| 번호 | 결과 | 관찰 | 심각도 | 후속 |
|---|---|---|---|---|
| M1 | | | | |
| M2 | | | | |
| M3 | | | | |
| M4 | | | | |
| M5 | | | | |
| M6 | | | | |
| M7 | | | | |
| M8 | | | | |
| M9 | | | | |
| M10 | | | | |

## 5. 완료 판정

- [ ] `npm run test:viewstate` 통과
- [ ] M1~M4에서 화면 변화 확인
- [ ] M5에서 배치·뷰포트가 눈으로 복원되는지 확인
- [ ] M6~M8에서 실제 클릭·두 창·Codex 흐름 확인
- [ ] M10의 다른 뷰 선택·검색·아키텍처 조작이 실제 화면과 공유 상태에서 일치
- [ ] blocker 0건
