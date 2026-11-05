# 배포·계정 작업 인수인계

제품명을 Skein으로 바꾼 뒤 레포 밖에서 직접 해야 하는 작업만 정리한다. 코드·문서 쪽 이름 변경, 원작자 표기, 아이콘은 레포에 반영했다.

- 작성일: 2026-11-02 (Asia/Seoul)
- 확장 ID: `sjh354.skein` (publisher `sjh354`, name `skein`)
- npm 이름 후보: `skein-vscode` (npm의 `skein`은 다른 패키지가 사용 중)

## 1. GitHub: fork 표시 제거

`sjh354/skein`은 이름을 바꿔도 `magic5644/Graph-It-Live`의 fork로 표시된다. 웹 UI에는 fork 해제 기능이 없어 GitHub Support에 요청해야 한다.

1. https://support.github.com/contact 에서 "Detach fork"를 요청한다. 대상은 `sjh354/skein`이다.
2. 해제하면 되돌릴 수 없고 upstream과의 비교·PR 연결이 사라진다. 커밋 이력은 그대로 남는다.
3. 해제 후에도 `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md`, `package.json`의 `contributors`에 원작자 표기를 유지한다. MIT 조건이므로 지우지 않는다.

## 2. VS Code Marketplace 등록

npm이 아니라 Marketplace에 게시한다. npm 등록은 필요하지 않다.

1. Microsoft 계정으로 Azure DevOps 조직을 만든다 (https://dev.azure.com).
2. Personal Access Token을 발급한다. Organization은 All accessible organizations, Scope는 Marketplace → Manage로 한다. 토큰은 저장소·문서·로그에 남기지 않는다.
3. https://marketplace.visualstudio.com/manage 에서 publisher `sjh354`를 만든다. 다른 ID를 쓰면 `package.json`의 `publisher`를 맞춘다.
4. `npx @vscode/vsce login sjh354`로 토큰을 입력한다. (`@vscode/vsce`는 devDependency로 이미 설치되어 있다.)
5. 아래 배포 전 점검을 마친다.
6. `npx @vscode/vsce publish`로 게시한다. 웹 포털에서 VSIX를 직접 올려도 된다.

Open VSX(VS Code 포크 에디터용)는 선택이다. 필요하면 `ovsx publish`를 쓴다.

### 배포 전 점검

- [ ] 버전: 현재 `0.0.2`. 첫 공개는 `0.1.0`처럼 올린다.
- [ ] `npm run check:types`, `npm run lint`, `npm test`, `npm run package:verify` 통과
- [ ] `npm run package`로 만든 VSIX를 로컬에 설치해 그래프 탭·MCP 서버·Dart 호출 그래프 동작 확인
- [ ] README의 "Not yet published to the Marketplace" 문구를 설치 안내로 교체
- [ ] 아이콘(`resources/icon.png`)과 `galleryBanner` 색 확인
- [ ] 외부 공개이므로 게시 직전에 한 번 더 확인한다

## 3. npm 이름 예약 (선택)

코어 분석 엔진을 라이브러리로 따로 공개할 때만 필요하다. 지금은 독립 CLI가 없어 불필요하다.

1. `npm view skein-vscode`로 비어 있는지 확인한다.
2. `npm login` 후 이름이 `skein-vscode`인 `package.json`이 있는 폴더에서 `npm publish --access public`을 실행한다. 확장 본체의 `package.json`은 `name`이 `skein`이므로 그대로 올리지 않는다.

## 4. 이름 변경으로 달라진 식별자

| 항목 | 이전 | 이후 |
|---|---|---|
| 확장 ID | `sjh354.structure-graph` | `sjh354.skein` |
| 커맨드·설정 키 | `graph-it-live.*` | `skein.*` |
| MCP 서버 이름 | `structure-graph` | `skein` |
| MCP·언어 모델 도구 | `graph-it-live_*`, `graphitlive_*` | `skein_*` |
| 구조 규칙 파일 | `graphit.architecture.json` | `skein.architecture.json` |
| 무시 파일 | `.graphitignore` | `.skeinignore` |

- 이전 이름으로 저장한 VS Code 사용자 설정과 에이전트의 MCP 설정은 이전되지 않는다. 필요한 곳에서 `skein`으로 바꿔야 한다.
- 기존 `.graphitignore`·`graphit.architecture.json`을 쓰는 분석 대상 프로젝트는 파일 이름을 바꿔야 한다. 이전 이름을 읽는 호환 처리는 넣지 않았다.

## 5. 정리 결과

- `sonar-project.properties`와 `.vscode/settings.json`의 원작자 SonarCloud·Snyk 설정을 제거했다.
- `.github/workflows/`는 검증만 수행하고 배포·비밀 값을 쓰지 않는다. 모두 유지하고, 삭제된 `scripts/mcpSession.ts` 경로 필터만 정리했다.
- 분석 캐시는 `<workspace>/.skein/cache/`, 세션 통계는 `~/.skein/stats/`로 옮겼다. 기존 `.graph-it/cache/`는 첫 실행에서 한 번 이동하며, 이동에 실패하면 재색인한다. 통계 비활성화 환경 변수는 `SKEIN_NO_STATS`로 바뀌었고 `GRAPH_IT_NO_STATS`는 읽지 않는다.
- Claude Code 프로젝트 상태(`~/.claude.json`, `~/.claude/projects/`)는 작업 폴더 경로를 기준으로 저장된다. 폴더를 `skein`으로 옮겼으므로 새 경로에서 처음 열 때 신뢰 확인을 다시 거친다.

## 6. 4단계 완료 후 남은 확인 (나중에 한 번에)

4단계 코드 작업은 다음까지 반영했다.

- `state.json` 스키마 2: 창별 스냅샷(`windows`), 활성 창, 콜 그래프 배치(노드 좌표·줌·팬), 뷰별 선택, 스키마 1 자동 변환
- 쓰기 병합과 `state.lock`: 같은 폴더를 두 창에서 열어도 서로의 스냅샷을 지우지 않음
- `skein_control_view`의 `windowId` 대상 지정: 대상 창만 명령을 적용하고 나머지는 요청을 남겨 둠
- 재시작 복원: 모드·파일·깊이·필터·선택·배치·`graphVersion` (memento가 아니라 `state.json` 기준)
- `graphVersion` 통합: 콜 그래프 재드로우, 파일 변경, 의존성 재분석, 인덱스 재구축에서 증가하고 재시작 후 유지
- 사라진 노드 선택 해제, 영역별 `state.json` 전환(`skein.setWorkspace`), 시작 시 워크스페이스 미탐지 재시도(D4)
- `npm run test:viewstate`에 배치·창·버전 복원 검사 추가

상세 수동 절차와 기록 양식은 `docs/verification/step4-manual-checklist.md`에 있다.

### 6.1 수동 확인 (원격 작업 후 실제 창에서)

- [x] `M1` 선택 하이라이트와 상세 패널이 `select` 명령에 반응하는가 (통과: 2026-11-04)
- [x] `M2` `focus`가 뷰포트를 실제로 이동·확대하는가 (수정 후 통과: 2026-11-04, focus 재질의 → surface focus 라우팅)
- [x] `M3` `set_filter`가 캔버스에서 노드·엣지를 실제로 숨기는가 (nodeType·folder·edgeType) — **수정 후 실제 창 재확인 통과: 2026-11-04**
- [x] `M4` `set_expand_all`이 의존성 그래프를 실제로 펼치고 접는가 — **수정 후 실제 창 재확인 통과: 2026-11-04 (오버레이 해제·응답 상태 일치)**
- [x] `M5` 재시작 후 노드 배치·줌·팬이 눈으로 같은 위치에 복원되는가 (수정 후 통과: 2026-11-04, 드래그 팬 게시 수정)
- [x] `M6` 드래그·줌·노드 이동 중에 보낸 명령이 `user-action-superseded`로 거부되고 화면이 유지되는가 (통과: 2026-11-04)
- [x] `M7` 멀티루트 폴더 전환과 같은 폴더 두 창에서 상태가 분리되는가 (2026-11-04 통과, 부수 문제는 6.4)
- [ ] `M8` 에이전트가 `get_view_state`의 `nodeId`·`filePath`·`windowId`를 그대로 `control_view`에 넘기는가 (2026-11-04 부분 통과: 멀티루트 `filePath` 거부·응답 크기 문제 → 6.4 수정. 2026-11-05: `nodeId`·`windowId` 재사용 통과, 멀티루트 `filePath` 재검증은 아직)
- [x] `M9` `open_file`이 미리보기 탭으로 열리는 동작이 불편하지 않은가 (2026-11-04 통과: 사용자 "불편하지 않고 좋다")
- [ ] `M10` 파일·리스트·아키텍처 뷰의 선택·검색·조작이 `views`·`surface`와 일치하는가 (2026-11-04 부분 통과: 리스트 뷰 전부 통과, 파일 그래프·아키텍처 문제 → 6.4 수정. 2026-11-05: 아키텍처 `search`·선택·`set_architecture`(view·minImports·folder) 통과, 파일 그래프 클릭·MCP 선택 재확인은 아직)

2026-11-04 실창 기록: M1·M2·M5·M6은 통과했고, M2(`focus` 재질의 문제)·M5(드래그 팬 미게시)는 수정 후 재검증했다. M3는 `set_filter`가 `applied`로 끝나도 화면·범례가 바뀌지 않고 범례→상태 게시도 동작하지 않아 결함으로 확정했으며, 렌더러 확인 응답과 webview `postMessage` 전달로 수정한 뒤 실제 창에서 재확인해 닫았다. M4는 펼침·접힘 자체는 통과했으나 `true` 이후 로딩 오버레이가 남고 `expandedNodeIds`·응답 `state`가 한 박자 늦어, surface 명령과 렌더러 게시 뒤 응답으로 수정했고 실제 창에서 오버레이 해제까지 확인해 닫았다. M7·M8·M9·M10의 관찰과 후속 항목은 6.4와 `docs/verification/step4-manual-checklist.md`의 기록 표에 있다.

### 6.2 남은 연결 구현 (2026-11-03)

- [x] 파일·리스트·심벌·아키텍처 화면의 선택을 `views`에 게시
- [x] `skein_control_view search`: 현재 렌더러가 로드한 노드의 ID·이름 검색, 첫 일치 대상 포커스. 전체 프로젝트 검색은 `skein_graph_context`의 검색 모드 사용
- [x] `set_expanded`: 파일 의존성 그래프의 개별 노드, 아키텍처의 개별 그룹 펼침/접기
- [x] `set_architecture`: graph/matrix·unit·folder·minImports 조작. 한 호출에 한 탐색 단계만 변경
- [x] `state.json`의 `surface`: 노드 ID·펼침·검색·콜그래프 필터·분석 개수/최신성·아키텍처 revision·진단 참조 게시. 노드 ID 10,000개, 검색 결과·진단 참조 각 100개 제한. 진단 상세 근거는 `skein_diagnose_structure`, 분석 상세는 기존 조회 도구로 조회
- [x] 패널·에디터 탭에 같은 분석 결과 전달, 선택·펼침 상태와 호출 그래프 배치/뷰포트 동기화, 나중에 연 화면에 최근 결과 재전달
- [x] 새 화면 명령은 렌더러가 React 상태를 반영하고 상태를 게시한 뒤 응답. 없는 노드·숨겨진 노드·지원하지 않는 조작·무응답은 명시적 거부
- [x] 드래그·줌·노드 이동 중에는 렌더러가 상호작용 상태를 게시하고, 그동안 들어온 명령은 `user-action-superseded`로 거부 (마지막 이벤트 후 250ms 해제, 웹뷰 무응답 시 3초 만료)
- [ ] D4(시작 시 워크스페이스 폴더 미탐지) 재현 조건 반복 확인 — 기존 수정 후 실사용 확인 항목

이 항목의 구현 완료는 아래 수동 화면 검증 완료를 뜻하지 않는다. 아키텍처 요약·진단은 해당 화면에서 분석된 결과이며, 새 분석을 유발하지 않는다. `surface.search`는 현재 로드된 노드 범위이며 전체 인덱스 검색 결과가 아니다. `selection` 최상위 필드는 마지막 콜 그래프 선택을 보존하므로 다른 뷰에서는 `views[mode]`를 사용한다.

### 6.3 실행 명령

```bash
npm run build
npm run test:viewstate   # phase 1 왕복 + phase 2 재시작 복원
npm run test:change      # 단계 5: 계획→이력→적용→되돌리기→재적용→충돌/복구
npm run test:refactor    # 단계 6: 이동(생성/삭제 Undo/Redo)→추출→인라인→오래된 계획
npm test                 # 단위 테스트
npm run check:types
npm run lint
```

### 6.4 2026-11-04 실창 결과와 후속 수정

| 항목 | 결과 | 관찰·후속 |
|---|---|---|
| M3 필터 | 통과(수정 후) | `set_filter`·범례가 화면과 `hiddenFilters`에 반영. 잘못된 값은 `filter-not-found` |
| M4 펼침/접힘 | 통과(수정 후) | `expandAll`·`set_expanded`가 화면·`expandedNodeIds`에 반영, 오버레이 해제 |
| M7 멀티루트·두 창 | 통과 + 부수 문제 | 두 창 선택 분리·`windowId` 지정 동작. 아래 D11~D14 |
| M8 응답 값 재사용 | 부분 통과 | `nodeId` 재사용은 통과. `filePath`(다른 루트)·응답 토큰 초과는 D11·D12로 수정 |
| M9 파일 열기 | 통과 | 미리보기 탭 동작, 사용자 의견 "불편하지 않고 좋다" |
| M10 선택·검색·조작 | 부분 통과 | 리스트 뷰 전부 통과. 파일 그래프 클릭·MCP 선택 표시, 아키텍처 선택 표기는 D13·D14로 수정 |

2026-11-04에 확인·수정한 항목:

- **D11 멀티루트 경로 거부**: `get_view_state.filePath`가 다른 워크스페이스 루트를 가리키면 `open_file`이 `path-outside-workspace`로 거부됐다. `state.json`에 `workspaceRoots`를 게시하고, 명령 경로를 분석 루트 또는 게시된 워크스페이스 폴더 안에서 허용하도록 수정했다.
- **D12 응답 크기**: `get_view_state`·`control_view` 응답이 `layout.positions`·`windows` 중복 스냅샷으로 최대 토큰을 넘겼다. MCP 응답에서는 노드 좌표와 창 스냅샷을 빼고 `layout.positionCount`·창 요약만 돌려주도록 수정했다. `windowId`를 지정해도 같은 스냅샷이 두 번 들어가지 않는다.
- **D13 파일 그래프 클릭·선택 표시**: 파일 그래프 노드 클릭이 `surface.select`를 거치지 않아 `views.file`·`lastUserActionAt`이 갱신되지 않았고, MCP `select`도 `data.selectedNodeId`를 바꾸지 못해 파란 강조가 보이지 않았다. 클릭과 MCP 선택이 같은 선택 상태를 게시하고 `selectedNodeId`로 그리도록 수정했다.
- **D14 창 대상·아키텍처 선택**: `windowId`가 없을 때 마지막 상태 기록 창이 아니라 사용자가 마지막으로 조작한 창(`lastUserActionAt`, 동률이면 `updatedAt`)을 대상으로 삼는다. 창을 옮기거나 닫을 때 이전 영역의 창 스냅샷을 지우고, 새 창이 이전 창의 `lastUserActionAt`을 물려받지 않게 했다. 아키텍처 선택은 `name`을 함께 게시하고, 다른 레벨로 이동하면 선택을 비우며, `surface.analysis`는 전체 프로젝트가 아니라 현재 레벨이 그리는 파일·엣지 수를 게시한다. `surface.architecture.revision`은 현재 레벨 revision, `surface.diagnostics.revision`은 진단 revision이다.
- **D15 콜 그래프 선택 응답**: `select`/`focus` 응답의 `state.selection`이 웹뷰의 비동기 게시보다 먼저 읽혀 이전 노드로 보이던 문제를, 적용한 노드를 즉시 응답 상태에 넣도록 수정했다.
- **D16 콜 그래프 인덱스 루트**: 멀티루트에서 활성 파일과 다른 첫 폴더를 인덱스·캐시 루트로 사용해 늦은 크롤·재색인이 반복될 수 있었다. 활성 파일의 워크스페이스 폴더를 인덱스·캐시 루트로 사용하도록 수정했다.
- **D17 필터 허용 값·모드 전환**: `surface.filters`에 `set_filter`가 받는 nodeType·folder·edgeType 값을 게시하고, `control_view`에 `set_view_mode`(`file`·`list`·`symbol`·`callgraph`·`architecture`)를 추가했다. `set_architecture`의 `unit: ""`가 최상위 복귀라는 설명도 도구 설명에 넣었다. 펼침 오버레이 문구의 프랑스어도 영어로 바꿨다.

남은 확인:

- [x] `folder` 파라미터(`set_architecture`), 아키텍처 `search`의 화면 반영 (2026-11-05 통과)
- 콜 그래프 지연 시간의 정량 측정 (미수행)
- 멀티루트에서 상태 영역은 `Skein: Set Workspace Folder`가 고른 영역을 따른다(활성 파일을 따라 자동 전환하지 않는다). 이 동작이 불편하면 별도 설계가 필요하다.

### 6.5 2026-11-05 실창·MCP 검증 결과와 수정

에이전트(Claude Code)가 MCP로, 사용자가 개발 호스트 창에서 샌드박스 작업공간(`tests/fixtures/refactor-template` 기반)을 검증했다. 확인 중 찾은 결함은 모두 회귀 테스트와 함께 고쳤다.

- 이름 변경 오류 `[UriError] ... "//"`: 절대 경로를 넣은 미리보기 가상 문서 URI가 원인이었다. 변경 명령의 적용 전 diff 탭을 없애 (`ChangePreviewProvider` 삭제) 근본적으로 제거했다.
- 변경 명령 UI: 확인 모달에 파일별 `(+n -n)`만 보이고, 적용·다시 적용 뒤 바뀐 파일(최대 5개)을 Skein 그래프 탭이 없는 에디터 그룹에 일반 탭으로 연다. Undo는 열지 않는다.
- `partial-apply` 오판: 저장 시 포매터(`editor.formatOnSave`+Prettier)가 계획한 내용을 바꿔 적용 직후 비교가 어긋났고, 이력이 남지 않았다. 적용을 편집기 저장이 아니라 디스크 직접 쓰기로 바꿨다(저장되지 않은 편집은 이미 적용 전에 거부). 변경이 에디터 자체의 Ctrl+Z 스택에는 남지 않으므로 `Skein: Undo Last Tool Change`를 쓴다. 파일 끝 빈 줄도 한 줄로 정규화한다.
- 호출 그래프: 삭제된 파일이 색인에 남아 유령 노드가 보였다(삭제 감시와 처음 열 때 정리 추가). 이동·재생성된 심벌로 그래프가 이어지도록 생성 감시와 이름 기반 루트 추적을 넣었다. 로딩 오버레이에 스피너를 붙이고 마운트 전 진행 메시지를 보관해 다시 보낸다.
- 호출 그래프 뷰포트: 다른 화면의 줌·팬까지 적용되어 서로 반대로 움직였다. 노드 위치만 공유한다. 에디터 탭이 늦게 마운트되면 빈 화면이던 문제는 마운트 알림 때 그래프를 다시 보내 고쳤다. 호출 그래프를 보는 중 에디터 탭을 다시 열어도 모드를 바꾸지 않는다. 렌더링 중 뷰포트 변경(저장된 배치 복원·레이아웃 뒤 `fit`)이 사용자 조작으로 전송되어 직후 에이전트 명령을 `user-action-superseded`로 거부하던 경로를 "프로그램이 이동"으로 표시해 막았다(CI E2E `select`가 한 번 이 때문에 실패).
- 추출: 선택 안에서 선언한 이름이 선택 뒤에서 쓰이면 `extract-declaration-used-after`로 거부, 여러 줄 선택의 들여쓰기 보존, 감싸는 함수의 매개변수 타입 주석을 추출 함수에 유지(로컬 변수는 타입 없음).
- 인라인: 호출 하나만 인라인하면 선언이 지워져 남은 호출이 깨지던 문제(남은 호출이 있으면 선언 유지).
- 이동: 대상 파일이 이미 이동할 이름을 원본에서 import하고 있으면 그 import를 제거한다.
- 구조 가드: 변경 파일을 절대 경로로 비교해 적용 전 차단이 항상 통과하던 결함, 적용 직후 캐시로 새 위반을 놓치던 결함을 고쳤다. 기준선(`violations` 목록)에 올린 위반은 배치·의존 진단에서도 `accepted`로 표시한다.

미해결·결정 대기:

- 적용 전 차단 기준이 "변경 파일에 이미 새 확정 위반이 있는가"라서 위반을 고치는 변경(Undo 포함)도 막힌다. 제안은 Undo·다시 적용만 사후 검사로 처리하는 것이며 사용자 결정이 필요하다.
- 추출 함수의 로컬 변수 매개변수는 타입이 없어 `strict`(`noImplicitAny`)에서 오류가 난다.
- 가드가 그래프 빌드에 실패한 파일(`failedFiles`)을 "검사 불가"로 표시하지 않고 통과로 처리한다. 개발 호스트 분석기가 삭제된 파일을 계속 분석하려다 `FILE_NOT_FOUND`로 실패하는 로그가 있어 원인을 확인해야 한다.
- 이력 저장소(`.skein/history/repo.git`)가 실행 중 사라지면 창을 다시 불러오기 전까지 복구되지 않는다. 그때 "적용됐으나 기록 실패"라는 문구가 나왔지만 실제로는 아무것도 적용되지 않은 경우가 있었고 이유는 확인하지 못했다.
- 이동으로 원본이 비면 빈 파일이 남는다(DESIGN 13.2 "후속 후보"에 삭제 규칙 기록).
- 아키텍처 뷰 최상위 라벨이 `[unknown?] src 10 files`로 보인다(요소·역할 미지정 묶음의 기본 표기).
- E2E 주석·메시지에 제거된 `toggleViewMode` 이름이 남아 있다.
- 이 환경에서 `npm run test:change`·`test:refactor`·`test:vscode`는 실행하지 못했다. 적용 방식(디스크 직접 쓰기)과 미리보기 제거는 이 스위트의 가정과 맞는지 실제 VS Code 호스트에서 확인해야 한다.

## 7. 5·6단계 수동 확인

자동 검증은 마쳤고, 실제 화면·Dart 확장·실제 프로젝트가 필요한 항목만 남았다. 단계 순서대로 확인한다.

- 5단계: `docs/verification/step5-manual-checklist.md`
  - [x] M1 편집기 이름 변경·확인 모달·Undo (2026-11-05, 미리보기는 diff 없이 모달로 변경)
  - [ ] M2 Dart 실제 이름 변경 (Dart 확장 유무)
  - [x] M3 저장하지 않은 편집 거부 (2026-11-05)
  - [x] M4 이력 화면 (2026-11-05)
  - [x] M5 충돌 hunk 표시 (2026-11-05)
  - [ ] M7 에이전트 MCP 왕복 (이동의 계획·적용·되돌리기·이력은 2026-11-05 확인, 이름 변경 도구 호출은 아직)
  - [ ] M8·M9 사용자 Git 격리·중단 복구
- 6단계: `docs/verification/step6-manual-checklist.md`
  - [x] M1·M2 이동 UI·새 파일·공유 helper (2026-11-05)
  - [ ] M3 이동 차단 사유 (MCP로 `name-collision`·`entry-point`·`circular-import` 확인, 경로 별칭·재수출은 아직, UI 문구 미확인)
  - [ ] M4 Dart 실제 이동·private helper
  - [x] M5·M6 추출·인라인 UI (2026-11-05, 실패 사유 중 `extract-declaration-used-after`·`inline-exported-unsupported`는 MCP로 확인)
  - [x] M7 생성·삭제 Undo/Redo와 이후 편집 보존 (2026-11-05)
  - [ ] M8 에이전트 MCP 왕복(`kind`: move/extract/inline) (계획과 `callLine` 지정은 확인, 같은 `planId` 두 번 적용은 아직)
  - [ ] M9 ggultarae 실제 사례
- 7단계: `docs/verification/step7-manual-checklist.md` (자동 검증은 완료)
  - [x] M1 프로필 위반 방향·`strict` (2026-11-05)
  - [x] M2 예외 적용·만료 (2026-11-05)
  - [x] M3 기준선 v2·악화 (2026-11-05)
  - [x] M4 다섯 진단과 근거·한계 (2026-11-05, 의존 진단은 샘플에 해당 없음)
  - [x] M5 변경 차단·예외·사후 검증 (2026-11-05, 규칙 파일이 없는 프로젝트는 미확인)
  - [x] M6 `skein_diagnose_structure` 에이전트 MCP 왕복 (2026-11-05)
  - [ ] M7 대표 저장소 성능 (이 저장소 TS 약 720개 파일에서 진단 0.9~1.0초, 구조 검사 1.2초. 메모리 증가는 미측정)

## 8. 8단계 완료 후 남은 확인

- 대체표: `docs/verification/step8-replacement-table.md`
- 수용 기준 기록: `docs/verification/step8-acceptance.md`
- [x] 하단 패널과 에디터 탭이 같은 분석 세션·선택·배치를 공유하는가 (2026-11-05: 선택 공유, 호출 그래프 뷰포트 분리, 재오픈 복원 확인)
- [x] `skein.toggleViewMode` 제거 결정: 사용자가 기존 연결과 향후 사용 계획이 없음을 확인. 등록·기여·구현 제거, 테스트는 직접 모드 전환 명령 사용
- [x] Copilot 네이티브 언어 모델 도구 계속 지원: 기존 `LmToolsService`·`languageModelTools` 유지
- [x] 삭제한 렌더러·모듈 대신 현재 화면이 같은 기능을 제공하는가 (2026-11-05: 대체표 코드 근거 존재 확인, 각 화면 사용 확인)
- [x] 리로드로 사라진 창의 `windows` 항목 정리: 영역 전환·창 종료 시 해당 창 스냅샷을 지우고, 새 창은 이전 창의 `lastUserActionAt`을 물려받지 않는다. 비정상 종료처럼 정리 훅을 못 탄 경우는 여전히 7일(`WINDOW_SNAPSHOT_MAX_AGE_MS`) 뒤에 빠진다
- [x] `skein_control_view`에 뷰 모드 전환 명령 추가: `set_view_mode`(`file`·`list`·`symbol`·`callgraph`·`architecture`) 5개 모드 전환과 호출 그래프 복원 확인 (2026-11-05)
- [ ] 4~7단계 수동 항목을 실제 창에서 완료하고 수용 기준 표의 "수동 대기"를 갱신 (남은 항목: Dart 두 가지, ggultarae, 5단계 M7~M9, 6단계 M3·M8 일부, 7단계 M7 메모리, 4단계 M8·M10 일부, 6.5의 결정 대기)

### 실제 창 검증 진행 방식

MCP 왕복 확인은 특정 에이전트에 묶지 않는다. 이 환경의 에이전트(Claude Code)가 수행한 것으로 갈음하고, 에이전트별 확인 항목은 따로 남기지 않는다.

기존 단계별 체크리스트를 기준으로 한 번에 M 항목 1~2개만 안내하고, 사용자가 관찰한 결과를 기록한 뒤 다음 묶음으로 진행한다. 자동 통과를 수동 통과로 바꾸지 않는다.

1. 4단계 M1·M2: 개발 호스트 준비, 클릭/MCP 선택, 포커스 이동
2. 4단계 M3·M4: 필터와 펼침/접기 (`set_expanded` 포함)
3. 4단계 M5·M6: 재시작 배치 복원, 실제 클릭 우선
4. 4단계 M7·M8: 멀티루트·두 창, 에이전트 MCP 왕복
5. 4단계 M9·M10: 미리보기 탭 사용성, 모든 뷰 선택·검색·아키텍처 조작
6. 5단계 M1·M3 → M4·M5 → M6·M7 → M8·M9 → M2·M10
7. 6단계 M1·M2 → M3·M7 → M5·M6 → M4·M8 → M9
8. 7단계 M1·M2 → M3·M4 → M5·M6 → M7
9. 8단계 패널/에디터 탭 동등성·대체 기능 확인 → 수용 기준 갱신

5·6단계의 변경·충돌·강제 종료 검사는 테스트용 작업공간에서 실행한다. Dart 확장 유무와 ggultarae 실제 사례는 해당 묶음에서 환경을 확인한다. D4 반복 확인과 진단 성능 측정도 결과를 별도로 기록한다. Marketplace 게시 작업은 이 검증 범위에 포함하지 않는다.
