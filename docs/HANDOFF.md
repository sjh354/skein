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

- [ ] `M1` 선택 하이라이트와 상세 패널이 `select` 명령에 반응하는가
- [ ] `M2` `focus`가 뷰포트를 실제로 이동·확대하는가
- [ ] `M3` `set_filter`가 캔버스에서 노드·엣지를 실제로 숨기는가 (nodeType·folder·edgeType)
- [ ] `M4` `set_expand_all`이 의존성 그래프를 실제로 펼치고 접는가
- [ ] `M5` 재시작 후 노드 배치·줌·팬이 눈으로 같은 위치에 복원되는가
- [ ] `M6` `timeoutMs`가 긴 명령 대기 중 실제 클릭하면 `user-action-superseded`로 거부되는가
- [ ] `M7` 멀티루트 폴더 전환과 같은 폴더 두 창에서 상태가 분리되는가 (`windows`, `windowId` 대상 지정)
- [ ] `M8` Codex가 `get_view_state`의 `nodeId`·`filePath`·`windowId`를 그대로 `control_view`에 넘기는가
- [ ] `M9` `open_file`이 미리보기 탭으로 열리는 동작이 불편하지 않은가
- [ ] `M10` 파일·리스트·아키텍처 뷰의 선택·검색·조작이 `views`·`surface`와 일치하는가

### 6.2 남은 연결 구현 (2026-11-03)

- [x] 파일·리스트·심벌·아키텍처 화면의 선택을 `views`에 게시
- [x] `skein_control_view search`: 현재 렌더러가 로드한 노드의 ID·이름 검색, 첫 일치 대상 포커스. 전체 프로젝트 검색은 `skein_graph_context`의 검색 모드 사용
- [x] `set_expanded`: 파일 의존성 그래프의 개별 노드, 아키텍처의 개별 그룹 펼침/접기
- [x] `set_architecture`: graph/matrix·unit·folder·minImports 조작. 한 호출에 한 탐색 단계만 변경
- [x] `state.json`의 `surface`: 노드 ID·펼침·검색·분석 개수/최신성·아키텍처 revision·진단 참조 게시. 노드 ID 10,000개, 검색 결과·진단 참조 각 100개 제한. 진단 상세 근거는 `skein_diagnose_structure`, 분석 상세는 기존 조회 도구로 조회
- [x] 패널·에디터 탭에 같은 분석 결과 전달, 선택·펼침 상태와 호출 그래프 배치/뷰포트 동기화, 나중에 연 화면에 최근 결과 재전달
- [x] 새 화면 명령은 렌더러가 React 상태를 반영하고 상태를 게시한 뒤 응답. 없는 노드·숨겨진 노드·지원하지 않는 조작·무응답은 명시적 거부
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

## 7. 5·6단계 수동 확인

자동 검증은 마쳤고, 실제 화면·Dart 확장·실제 프로젝트가 필요한 항목만 남았다. 단계 순서대로 확인한다.

- 5단계: `docs/verification/step5-manual-checklist.md`
  - [ ] M1 편집기 이름 변경·미리보기·확인 모달
  - [ ] M2 Dart 실제 이름 변경 (Dart 확장 유무)
  - [ ] M3 저장하지 않은 편집 거부
  - [ ] M5 충돌 hunk 표시
  - [ ] M7 Codex 왕복
  - [ ] M8·M9 사용자 Git 격리·중단 복구
- 6단계: `docs/verification/step6-manual-checklist.md`
  - [ ] M1·M2 이동 UI·새 파일·공유 helper
  - [ ] M3 이동 차단 사유(진입점·이름 충돌·경로 별칭·재수출)
  - [ ] M4 Dart 실제 이동·private helper
  - [ ] M5·M6 추출·인라인 UI와 실패 사유
  - [ ] M7 생성·삭제 Undo/Redo와 이후 편집 보존
  - [ ] M8 Codex 왕복(`kind`: move/extract/inline)
  - [ ] M9 ggultarae 실제 사례
- 7단계: `docs/verification/step7-manual-checklist.md` (자동 검증은 완료)
  - [ ] M1 프로필 위반 방향·`strict`
  - [ ] M2 예외 적용·만료
  - [ ] M3 기준선 v2·악화
  - [ ] M4 다섯 진단과 근거·한계
  - [ ] M5 변경 차단·예외·사후 검증
  - [ ] M6 `skein_diagnose_structure` Codex 왕복
  - [ ] M7 대표 저장소 성능

## 8. 8단계 완료 후 남은 확인

- 대체표: `docs/verification/step8-replacement-table.md`
- 수용 기준 기록: `docs/verification/step8-acceptance.md`
- [ ] 하단 패널과 에디터 탭이 같은 분석 세션·선택·배치를 공유하는가
- [x] `skein.toggleViewMode` 제거 결정: 사용자가 기존 연결과 향후 사용 계획이 없음을 확인. 등록·기여·구현 제거, 테스트는 직접 모드 전환 명령 사용
- [x] Copilot 네이티브 언어 모델 도구 계속 지원: 기존 `LmToolsService`·`languageModelTools` 유지
- [ ] 삭제한 렌더러·모듈 대신 현재 화면이 같은 기능을 제공하는가
- [ ] 4~7단계 수동 항목을 실제 창에서 완료하고 수용 기준 표의 "수동 대기"를 갱신

### 실제 창 검증 진행 방식

기존 단계별 체크리스트를 기준으로 한 번에 M 항목 1~2개만 안내하고, 사용자가 관찰한 결과를 기록한 뒤 다음 묶음으로 진행한다. 자동 통과를 수동 통과로 바꾸지 않는다. 묶음별 준비·판정 기준은 `docs/verification/manual-walkthrough.md`에 있다.

1. 4단계 M1·M2: 개발 호스트 준비, 클릭/MCP 선택, 포커스 이동
2. 4단계 M3·M4: 필터와 펼침/접기 (`set_expanded` 포함)
3. 4단계 M5·M6: 재시작 배치 복원, 실제 클릭 우선
4. 4단계 M7·M8: 멀티루트·두 창, Codex 실제 왕복
5. 4단계 M9·M10: 미리보기 탭 사용성, 모든 뷰 선택·검색·아키텍처 조작
6. 5단계 M1·M3 → M4·M5 → M6·M7 → M8·M9 → M2·M10
7. 6단계 M1·M2 → M3·M7 → M5·M6 → M4·M8 → M9
8. 7단계 M1·M2 → M3·M4 → M5·M6 → M7
9. 8단계 패널/에디터 탭 동등성·대체 기능 확인 → 수용 기준 갱신

5·6단계의 변경·충돌·강제 종료 검사는 테스트용 작업공간에서 실행한다. Dart 확장 유무와 ggultarae 실제 사례는 해당 묶음에서 환경을 확인한다. D4 반복 확인과 진단 성능 측정도 결과를 별도로 기록한다. Marketplace 게시 작업은 이 검증 범위에 포함하지 않는다.
