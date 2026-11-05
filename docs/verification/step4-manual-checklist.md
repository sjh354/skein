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
| D5 | 드래그·줌·노드 이동 **진행 중**에는 `lastUserActionAt`이 갱신되지 않아(디바운스·종료 시점 기록) 조작 중에 들어온 명령이 거부되지 않고 화면을 갈아끼웠다. 렌더러가 상호작용 상태를 게시하고 확장이 그동안 명령을 거부하도록 수정 | 수정·M6 재검증 완료 |
| D6 | M2: `focus`가 뷰포트를 이동시키지 않고 호출 그래프를 대상 심벌 기준으로 다시 질의해 루트·노드 구성만 바꿨다. 렌더러의 surface `focus`(선택 + fit)로 라우팅하고 적용 확인 뒤에만 응답하도록 수정. 단일 노드 확대 상한 2, programmatic 팬은 사용자 조작으로 기록하지 않음 | 수정·M2 재검증 완료 |
| D7 | M5: 배경 드래그 팬이 `callGraphLayoutChanged`로 게시되지 않아 재시작 후 팬이 유실됐다. 드래그 팬도 배치로 게시하도록 수정 | 수정·M5 재검증 완료 |
| D8 | M3: `set_filter`가 웹뷰의 전달·처리 확인 없이 `applied`로 끝났다. 이제 렌더러가 필터를 적용한 뒤 `callGraphFilterApplied`로 확인하고, 지원하지 않는 필터는 `filter-not-found`, 무응답은 `view-not-responding`으로 거부한다 | 수정·자동 검증 완료(수동 재확인 대기) |
| D9 | M3: 범례 조작이 확장 상태로 게시되지 않았다. 범례가 직접 `acquireVsCodeApi()`를 다시 호출해 실패하고 있었으므로, 상위 webview의 `postMessage`를 넘기도록 수정. 필터 상태도 `surface.hiddenFilters`로 게시 | 수정·자동 검증 완료(수동 재확인 대기) |
| D10 | M4: `set_expand_all true` 뒤 로딩 오버레이가 접기 전까지 계속 돌았다. 확장이 보내던 완료 없는 `expansionProgress started`를 제거하고, 렌더러는 surface 명령으로 펼침을 적용한 뒤 새 `expandedNodeIds`를 게시하고 응답한다 | 수정·M4 재검증 완료 |
| D11 | M8: 다른 워크스페이스 루트의 `filePath`를 `open_file`에 그대로 넣으면 `path-outside-workspace`로 거부됐다. `state.json`의 `workspaceRoots`와 분석 루트를 함께 검사 | 수정·자동 검증 |
| D12 | M8: `layout.positions`·`windows` 중복으로 MCP 응답이 최대 토큰을 넘었다. 응답에서 좌표·창 스냅샷을 빼고 `positionCount`·창 요약만 반환 | 수정·자동 검증 |
| D13 | M10: 파일 그래프 클릭이 `surface.select`를 거치지 않아 `views.file`·`lastUserActionAt`이 비었고, MCP `select`는 `data.selectedNodeId`를 바꾸지 않아 강조가 보이지 않았다. 클릭·명령이 같은 선택 상태를 게시하고 그 값으로 그리도록 수정 | 수정·자동 검증 |
| D14 | M7·M10: `windowId` 생략 시 마지막 기록 창으로 가고, 새 창이 이전 창의 `lastUserActionAt`을 물려받았으며, 영역 전환 후 이전 파일에 창 스냅샷·배치가 남았다. 사용자 조작 기준 창 선택, 창 스냅샷 제거, 영역 밖 레이아웃 정리. 아키텍처 선택 `name`·레벨 이동 시 선택 해제·레벨 revision·가시 범위 분석 수치 | 수정·자동 검증 |
| D15 | M8: 콜 그래프 `select`/`focus` 응답의 `state.selection`이 웹뷰의 비동기 게시 전 값을 읽어 이전 노드로 보였다. 적용한 노드를 응답 상태에 즉시 반영 | 수정·자동 검증 |
| D16 | M7: 멀티루트에서 콜 그래프가 첫 폴더를 인덱스·캐시 루트로 써 활성 파일과 어긋나 늦은 크롤·재색인이 반복될 수 있었다. 활성 파일의 워크스페이스 폴더를 사용 | 수정·자동 검증 |
| D17 | 필터 허용 값이 응답에 없고 뷰 모드 전환 MCP 명령이 없었다. `surface.filters` 게시, `set_view_mode` 추가, `unit: ""`·프로세스 문구 정리 | 수정·자동 검증 |

## 3. 사용자가 직접 확인할 항목

아래 항목은 자동화가 상태·프로토콜까지만 확인하고, 픽셀과 사용성은 확인하지 못한다.

사전 준비:

- [ ] `npm run build` 후 `F5`로 Extension Development Host 실행
- [ ] 테스트용 TS 파일(예: `src/extension/services/ViewStateService.ts`)을 열고 함수 안에 커서
- [ ] `Skein: Show Call Graph` 실행
- [ ] Codex에서 `codex mcp add skein --env WORKSPACE_ROOT=<repo> -- node <repo>/dist/mcpServer.mjs` 등록 (이미 있으면 생략)

### M1. 선택 하이라이트

- [x] 그래프에서 노드를 클릭 → 해당 노드가 선택 표시되고 상세 패널이 열린다
- [x] 에이전트에서 다른 노드를 `select` → 하이라이트와 상세 패널이 그 노드로 바뀐다
- [x] 없는 노드를 `select` → `node-not-found` 거부 응답이 오고 화면은 그대로인가

**결과: 통과 (2026-11-04).** 클릭 선택과 MCP `select`가 같은 상세 패널을 열고, 없는 노드는 거부되며 화면이 유지됐다.

자동화는 웹뷰가 선택을 되돌려주는 것까지만 확인했다.

### M2. 포커스 이동

- [x] 그래프를 드래그·축소해 대상 노드를 화면 밖으로 보낸다
- [x] 에이전트에서 그 노드를 `focus` → 뷰포트가 실제로 이동·확대되는가
- [x] 선택만 바뀌고 화면이 움직이지 않으면 결함으로 기록

**결과: 결함 수정 후 통과 (2026-11-04, D6).** 수정 전에는 `focus`가 그래프를 다시 질의해 루트·노드 구성만 바뀌고 뷰포트는 그대로였다. 렌더러의 surface `focus`로 라우팅한 뒤 뷰포트가 실제로 이동·확대됐고, 확대 배율은 2로 제한됐다.

자동화는 재질의·렌더 카운트만 확인했다.

### M3. 필터의 시각 효과

- [x] 범례에서 `Function` 타입을 끄고 노드가 사라지는가
- [x] 폴더 필터를 끄고 해당 폴더 노드가 사라지는가
- [x] `Outgoing call` 엣지를 끄고 엣지가 사라지는가
- [x] 에이전트 `set_filter`로도 같은 변화가 일어나는가

**결과: 결함 확인 후 수정, 실제 창 재확인 통과 (2026-11-04, D8·D9).** 수정 전에는 범례에서 Function·폴더를 꺼도 상태 게시가 바뀌지 않았고, MCP `set_filter`는 `applied`로 끝나도 캔버스·범례가 변하지 않았다. 이제 범례는 상위 webview의 `postMessage`로 상태를 게시하고, MCP 필터는 렌더러가 실제 적용한 뒤에만 `applied`로 응답한다. 지원하지 않는 값은 `filter-not-found`, 웹뷰가 응답하지 않으면 `view-not-responding`으로 거부한다. 실제 창에서 세 필터와 MCP 필터가 화면·`hiddenFilters`에 함께 반영되는 것을 확인했다. 허용 값은 `surface.filters`에 게시한다(D17).

자동화는 `state.json`의 `hiddenFilters`와 렌더러 확인 응답까지 검증했다.

### M4. 펼침/접힘

- [x] `Skein: Switch to Graph View`로 의존성 그래프로 전환
- [x] 에이전트 `set_expand_all true` → 노드 묶음이 실제로 펼쳐지는가
- [x] `set_expand_all false` → 접히는가

**결과: 결함 확인 후 수정, 실제 창 재확인 통과 (2026-11-04, D10).** 펼침·접힘 자체는 실제 반영됐지만, `true` 뒤 로딩 오버레이가 접기 전까지 남았고 응답의 `state`·`expandedNodeIds`가 한 박자 늦었다. 이제 `set_expand_all`은 렌더러 surface 명령으로 적용되고, 렌더러가 새 `expandedNodeIds`를 게시한 뒤 응답한다. 완료 없는 `expansionProgress started`도 제거했다. 실제 창에서 오버레이가 정상 해제되고 응답의 `expandedNodeIds`가 화면과 일치하는 것을 확인했다.

자동화는 `expandAll` 상태와 렌더러 확인 응답까지 검증했다.

### M5. 재시작 후 배치·뷰포트

- [x] 그래프 노드를 몇 개 드래그하고 확대/축소한다
- [x] `Developer: Reload Window` 후 콜 그래프를 다시 연다
- [x] 깊이·필터·선택이 복원되는가 (자동 검증 완료)
- [x] **노드 배치와 줌·팬이 이전 화면과 같은가** (좌표·뷰포트 저장은 자동 검증 완료, 픽셀 일치만 수동)

**결과: 결함 수정 후 통과 (2026-11-04, D7).** 재시작 뒤 노드 배치·줌·팬이 이전 화면과 같은 위치로 복원됐다. 수정 전에는 배경 드래그 팬이 게시되지 않아 재시작 후 팬이 유실됐다.

### M6. 사용자 조작 우선

`timeoutMs`는 MCP가 응답을 기다리는 시간이며, 확장이 명령 실행을 붙잡아 두는 값이 아니다. 명령은 받은 즉시 처리되므로 "호출이 끝나기 전에 클릭"으로는 재현되지 않는다. 확장은 렌더러가 드래그·줌·노드 이동 중이라고 보고하는 동안 들어온 명령을 거부한다.

- [x] 그래프를 노드 드래그, 캔버스 팬 또는 휠 줌으로 계속 조작한다
- [x] 조작을 멈추지 않은 상태에서 에이전트로 `set_depth`(또는 `select`)를 보낸다
- [x] 응답이 `rejected` / `user-action-superseded`인가
- [x] 조작이 끊기지 않고 깊이·선택·뷰포트가 유지되는가
- [x] 조작을 멈춘 뒤 같은 명령을 보내면 `applied`로 끝나는가

**결과: 통과.** 드래그 중 보낸 `set_depth`가 `rejected / user-action-superseded`로 끝나고 드래그와 뷰포트가 유지됐으며, 조작을 멈춘 뒤 같은 명령은 `applied`로 적용됐다.

명령 실행이 1초 미만이므로 클릭 한 번을 0.4초 창에 맞추는 방식은 쓰지 않는다. 조작 상태는 마지막 이벤트 후 250ms에 해제되고, 웹뷰가 끝을 보고하지 못하면 3초 뒤 안전하게 만료된다.

### M7. 멀티루트·두 창

- [x] `File → Add Folder to Workspace`로 폴더를 추가하고 `Skein: Set Workspace Folder`로 전환
- [x] `get_view_state`의 `workspaceRoot`와 상태가 폴더별로 분리되는가 (영역별 `state.json`)
- [x] 같은 폴더를 `Duplicate Workspace`로 두 창에 열고, 양쪽에서 노드를 선택
- [x] `get_view_state`의 `windows`에 두 창이 보이고, `windowId`로 각 창을 지정해 조작할 수 있는가
- [x] 한쪽 선택이 다른 쪽 스냅샷을 지우지 않는가 (창별 병합)
- [x] 실제 사용에서 혼선이 남아 있는지 판단

**결과: 통과 + 부수 문제 (2026-11-04).** 두 창의 선택이 서로 지우지 않고 `windowId` 지정 명령이 대상 창에만 적용됐다. 다만 `filePath` 재사용(다른 루트), 창 기록 잔존, `windowId` 생략 시 마지막 기록 창으로 가는 문제가 확인돼 D11·D14로 수정했다. 폴더 전환 복원에 다른 영역 배치가 섞이는 문제는 복원 전 스냅샷 정리(D14)로 막았다.

### M8. 에이전트 실제 호출

- [x] 에이전트에서 `skein_get_view_state`를 호출해 상태를 읽는다
- [x] 같은 응답의 `selection.nodeId` 또는 `callGraph.rootSymbolId`를 그대로 `select`에 넣는다
- [ ] 같은 응답의 `filePath`를 그대로 `open_file`에 넣는다
- [x] 두 창이면 `windows`의 `windowId`를 `control_view`에 넘겨 대상을 지정할 수 있는가
- [x] 에이전트가 도구·인자를 스스로 고르는 흐름에서 혼동이 없는가

**결과: 부분 통과, 수정 (2026-11-04).** `nodeId`·`windowId` 재사용은 통과했다. 멀티루트 복제 창에서 `filePath`를 그대로 넣으면 `path-outside-workspace`로 거부되고, 응답이 10만~20만 자로 최대 토큰을 넘었다. `workspaceRoots` 검증(D11)과 응답 축약(D12)으로 수정했으며, 같은 응답을 다시 왕복하는 실제 확인은 남아 있다.

### M9. 파일 열기 동작

- [x] `open_file`이 기존 탭을 덮는 미리보기 탭으로 열리는가
- [x] 사용자가 고정 탭을 기대하는 흐름에서 불편하지 않은가

**결과: 통과 (2026-11-04).** 미리보기 탭 동작을 확인했고 사용자는 "불편하지 않고 좋다"고 답했다.

### M10. 다른 뷰의 선택

- [x] 파일·리스트·아키텍처 뷰에서 선택한 대상이 `state.json`의 `views`에 게시되는가
- [x] 게시되지 않는다면, 해당 뷰에 선택 상태가 있는지 확인한다

**결과: 부분 통과 (2026-11-04).** 리스트 뷰의 클릭·`select`·`focus`·`search`는 전부 통과했다(`views.list`, `lastUserActionAt`, `surface.search.total`/`matches` 일치). 파일 그래프는 클릭이 `views.file`·`lastUserActionAt`에 게시되지 않고 MCP `select`가 화면에 보이지 않았으며, 아키텍처는 `group-2` 같은 불투명 ID만 게시되고 레벨 이동 후 선택이 남았다. D13·D14로 수정했다.

- [x] `search`의 첫 일치 대상이 화면에서 선택·포커스되고 `surface.search`에 ID와 전체 일치 개수가 게시되는가 (리스트 뷰 통과, 파일 그래프 `pipeline` 16개·`style_refs` 1개)
- [ ] 파일 그래프 `set_expanded`가 지정 노드만 펼치고 접는가 (M4에서 `expandAll`·`set_expanded` 함께 확인)
- [ ] 아키텍처 `set_architecture`의 graph/matrix·unit·folder·minImports가 실제 화면에 반영되는가 (view·unit·minImports·cycle 엣지 합산 확인, `folder`는 남음)
- [x] 아키텍처 `surface.architecture.revision`·`surface.analysis.revision`·`surface.diagnostics.revision`을 구분해 다른 분석을 혼동하지 않는가 (D14로 레벨·진단 revision 분리)

## 4. 기록 양식

| 번호 | 결과 | 관찰 | 심각도 | 후속 |
|---|---|---|---|---|
| M1 | 통과 | 클릭 선택과 `select`가 같은 상세 패널을 열고, 없는 노드는 `node-not-found`로 거부되며 화면 유지 | - | - |
| M2 | 통과 (수정 후) | `focus`가 재질의만 하고 뷰포트를 움직이지 않던 문제를 surface `focus` 라우팅으로 수정. 이동·확대 확인, 확대 상한 2 | - | D6 |
| M3 | 통과 (수정 후) | `set_filter`가 렌더러 확인 뒤에만 `applied`로 응답하고 범례가 상위 webview `postMessage`로 상태를 게시. 세 필터와 MCP 필터가 화면·`hiddenFilters`에 반영 | - | D8·D9 |
| M4 | 통과 (수정 후) | surface 명령으로 펼침을 적용하고 새 `expandedNodeIds` 게시 뒤 응답. 오버레이 해제 확인 | - | D10 |
| M5 | 통과 (수정 후) | 재시작 뒤 노드 배치·줌·팬이 같은 위치로 복원. 드래그 팬 미게시 문제 수정 | - | D7 |
| M6 | 통과 | 드래그 중 보낸 `set_depth`가 `user-action-superseded`로 거부되고 조작·뷰포트 유지, 종료 후 `applied` | - | - |
| M7 | 통과 + 부수 문제 | 두 창 선택 분리·`windowId` 지정 통과. 다른 루트 `filePath` 거부, 창 잔존·대상 선택, 폴더 전환 배치 혼입은 수정 | - | D11·D14 |
| M8 | 부분 통과 | `nodeId`·`windowId` 재사용 통과. `filePath` 거부·응답 토큰 초과는 수정, 실제 재왕복 확인 남음 | - | D11·D12·D15 |
| M9 | 통과 | 미리보기 탭 동작, 사용자 "불편하지 않고 좋다" | - | - |
| M10 | 부분 통과 | 리스트 뷰 전부 통과. 파일 그래프 클릭·MCP 선택 표시, 아키텍처 선택 표기·레벨 revision 수정 | - | D13·D14 |

## 5. 완료 판정

- [ ] `npm run test:viewstate` 통과
- [x] M1~M4에서 화면 변화 확인 (M1·M2·M3·M4 통과: 2026-11-04)
- [x] M5에서 배치·뷰포트가 눈으로 복원되는지 확인 (통과: 2026-11-04)
- [x] M6~M9에서 실제 클릭·두 창·에이전트 흐름 확인 (M6·M7·M9 통과, M8 부분 통과 후 수정)
- [ ] M10의 다른 뷰 선택·검색·아키텍처 조작이 실제 화면과 공유 상태에서 일치 (리스트 통과, 파일 그래프·아키텍처 수정 후 재확인 필요)
- [ ] blocker 0건 (M8·M10 재확인과 `folder`·아키텍처 `search` 확인 전에는 미충족)

## 2026-11-05 추가 확인

- `set_architecture`의 `view`(graph/matrix)·`minImports`·`folder`와 아키텍처 `search`가 `surface.architecture`·`views`에 반영되고 화면과 일치했다. `search("infra")`는 해당 묶음 하나만 일치시켜 선택했다.
- `set_view_mode` 5개 모드(`file`·`list`·`symbol`·`callgraph`·`architecture`)가 전환되고 호출 그래프로 돌아올 때 루트·배치·줌이 복원됐다.
- 모드 전환 직후에는 아키텍처 `surface`가 아직 그려지기 전이라 비어 있을 수 있다. 조작 직후 응답 상태가 한 박자 늦는 경우가 있다.
