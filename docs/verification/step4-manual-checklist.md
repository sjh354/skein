# 4단계 수동 검증 — 자동화 이후 남은 항목

`docs/DESIGN.md` 13.2 4단계의 완료 기준 중 자동화로 확인한 부분과, 실제 화면을 봐야 하는 부분을 분리한다.

- 자동 검증: `npm run test:viewstate`
- 자동 검증 코드: `tests/vscode-e2e/suite/viewState.test.ts`, `tests/vscode-e2e/suite/viewStateRestore.test.ts`, `tests/vscode-e2e/suite/mcpStdioClient.ts`
- 실행 환경: 실제 VS Code 확장 호스트 + 실제 `dist/mcpServer.mjs` stdio 프로세스
- 기준 커밋: `27ece7a`

## 1. 자동 검증이 확인하는 것

`npm run test:viewstate`는 VS Code를 두 번 실행한다.

### 1단계 — MCP 왕복 (11개 검사)

- `.skein/state.json`에 `mode`·`filePath`·`rootSymbolId`·`depth`·`graphVersion`이 게시된다
- `skein_get_view_state`가 게시된 상태와 같은 루트/버전을 반환한다
- `skein_control_view select`가 선택을 바꾸고 `state.json`에 반영된다
- `set_depth 3`이 그래프를 재질의하고 `graphVersion`을 올린다
- `set_filter`가 nodeType·edgeType 숨김을 게시하고 해제한다
- `open_file`이 지정한 파일·줄·열로 에디터를 연다
- 이전 `graphVersion`으로 보낸 명령이 `stale-graph-version`으로 거부된다
- `set_expand_all`이 의존성 그래프 상태를 바꾼다
- 확장이 없을 때 `extension-not-responding`으로 끝나고 요청 파일이 남지 않는다
- 알 수 없는 `nodeId` 선택이 `node-not-found`로 거부된다
- 다음 단계를 위해 depth 3·필터·선택 상태와 기준 파일을 남긴다

### 2단계 — 재시작 복원 (2개 검사)

- 재시작 직후 새 `state.json`이 게시되고, 뷰 모드가 `callgraph`가 아니어도 복원된 depth·필터·선택이 유지된다 (D3 수정)
- 콜 그래프 탭을 다시 열면 depth 3·필터·선택이 실제로 복원된다

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
| D4 | 자동화 환경에서 1회, 확장 시작 시 워크스페이스 폴더를 찾지 못해 `.skein/state.json`이 생성되지 않았다. 재실행에서는 재현되지 않음 | 관찰 |

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
- [ ] 깊이·필터·선택은 복원되는가 (자동 검증 완료)
- [ ] **노드 배치와 뷰포트는 복원되지 않는 것을 확인**하고, 4단계 완료 기준에서 이것이 허용 가능한지 판단한다

현재 구현은 위치를 저장하지 않는다. 이 항목은 결함 확인이 아니라 4단계 잔여 범위 결정이다.

### M6. 실제 클릭 기반 사용자 우선

- [ ] Codex에서 `timeoutMs: 8000`으로 `set_depth`를 호출한다
- [ ] 호출이 끝나기 전에 그래프에서 다른 노드를 클릭한다
- [ ] 응답이 `rejected` / `user-action-superseded`인가
- [ ] 클릭한 선택과 깊이가 유지되는가

단위 테스트만 있고 실제 웹뷰 클릭으로는 검증되지 않았다.

### M7. 멀티루트·두 창

- [ ] `File → Add Folder to Workspace`로 폴더를 추가하고 `Skein: Set Workspace Folder`로 전환
- [ ] `get_view_state`의 `workspaceRoot`와 상태가 폴더별로 분리되는가
- [ ] 같은 폴더를 `Duplicate Workspace`로 두 창에 열고, 양쪽에서 노드를 선택
- [ ] 한쪽 선택이 다른 쪽 `state.json`을 덮어쓰는가
- [ ] 이 혼선이 4단계에서 허용 가능한지, 영역 키·창 식별자를 지금 넣어야 하는지 판단

자동화하지 않았다. 상태 키가 한 폴더 기준이고 창 식별자가 없는 것은 알려진 미구현이다.

### M8. Codex 실제 호출

- [ ] Codex에서 `skein_get_view_state`를 호출해 상태를 읽는다
- [ ] 같은 응답의 `selection.nodeId` 또는 `callGraph.rootSymbolId`를 그대로 `select`에 넣는다
- [ ] 같은 응답의 `filePath`를 그대로 `open_file`에 넣는다
- [ ] Codex가 도구·인자를 스스로 고르는 흐름에서 혼동이 없는가

자동화는 동일한 stdio 클라이언트로 검증했다. Codex 모델의 도구 선택 자체는 자동화할 수 없다.

### M9. 파일 열기 동작

- [ ] `open_file`이 기존 탭을 덮는 미리보기 탭으로 열리는가
- [ ] 사용자가 고정 탭을 기대하는 흐름에서 불편하지 않은가

자동화는 파일·줄·열만 확인했다.

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

## 5. 완료 판정

- [ ] `npm run test:viewstate` 통과
- [ ] M1~M4에서 화면 변화 확인
- [ ] M5에서 위치 복원 미구현을 확인하고 4단계 잔여 범위 확정
- [ ] M6~M7 결과로 경합·영역 규칙 범위 확정
- [ ] blocker 0건
