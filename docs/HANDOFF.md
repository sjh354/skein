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

## 5. 남은 정리 후보

- `sonar-project.properties`와 `.vscode/settings.json`의 SonarCloud 설정은 원작자 계정(`magic5644`)을 가리킨다. 사용하지 않으면 삭제하고, 쓸 거면 새 프로젝트로 바꾼다. 의도적으로 이번 변경에서 제외했다.
- `.github/workflows/`는 검증만 수행하고 배포·비밀 값을 쓰지 않는다. 필요 없는 워크플로는 제거한다.
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
- [ ] `M10` 파일·리스트·아키텍처 뷰 선택을 `views`에 게시할 필요가 있는가

### 6.2 4단계 이후 코드 작업

- [ ] 파일·리스트·아키텍처 뷰가 선택을 공유 상태로 보내도록 각 뷰의 선택 모델 추가 (현재 `views.symbol`만 게시)
- [ ] DESIGN 10.1 검색 명령 추가 (DESIGN은 해당 단계에서 추가한다고 명시)
- [ ] 의존성 그래프 개별 노드 펼침/접기, 아키텍처 뷰 상태 조회·조작 (`set_expand_all` 외)
- [ ] `state.json`에 분석 결과·진단 데이터 추가 (현재 뷰 상태·버전·스키마만)
- [ ] D4(시작 시 워크스페이스 폴더 미탐지) 재현 조건 반복 확인

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
