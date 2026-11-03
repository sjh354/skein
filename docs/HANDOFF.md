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

## 6. 4단계 남은 작업 (나중에 한 번에)

4단계 자동 검증은 `npm run test:viewstate`로 추가했다. 실제 VS Code 확장 호스트에서 `dist/mcpServer.mjs` stdio 클라이언트로 왕복하고, 재시작 복원은 VS Code를 두 번 실행해 확인한다. D1(경로 축약이 노드 ID를 깨뜨림), D2(없는 노드 선택 수용), D3(모드가 `file`일 때 복원 상태 미게시)은 수정했고 자동 검증에 포함했다.

아래는 아직 남은 항목이다. 상세 수동 절차와 기록 양식은 `docs/verification/step4-manual-checklist.md`에 있다.

### 6.1 수동 확인 (원격 작업 후 실제 창에서)

- [ ] `M1` 선택 하이라이트와 상세 패널이 `select` 명령에 반응하는가
- [ ] `M2` `focus`가 뷰포트를 실제로 이동·확대하는가
- [ ] `M3` `set_filter`가 캔버스에서 노드·엣지를 실제로 숨기는가 (nodeType·folder·edgeType)
- [ ] `M4` `set_expand_all`이 의존성 그래프를 실제로 펼치고 접는가
- [ ] `M5` 재시작 후 노드 배치·뷰포트가 복원되는가 (현재 미저장 → 4단계 잔여 범위 결정)
- [ ] `M6` `timeoutMs`가 긴 명령 대기 중 실제 클릭하면 `user-action-superseded`로 거부되는가
- [ ] `M7` 멀티루트 폴더 전환과 같은 폴더 두 창에서 상태가 섞이는가/덮어쓰는가
- [ ] `M8` Codex가 `get_view_state`의 `nodeId`·`filePath`를 그대로 `control_view`에 넘기는가
- [ ] `M9` `open_file`이 미리보기 탭으로 열리는 동작이 불편하지 않은가

### 6.2 코드 작업

- [ ] `state.json`을 복원 단일 원본으로 전환: 모드·파일이 아직 VS Code memento(`globalState`/`workspaceState`)에 있다
- [ ] 노드 배치·뷰포트 위치를 `state.json`에 저장하고 재시작 시 복원 (현재 `positionsRef` 메모리에만 있음)
- [ ] 파일·리스트·심벌·아키텍처 뷰의 선택 상태 게시 (현재 `state.json`은 콜 그래프 중심)
- [ ] `graphVersion` 통합: 의존성 그래프 재분석·파일 변경·인덱스 재구축에서도 증가, 재시작 후에도 유지, 사라진 노드 선택 처리 규칙
- [ ] `graphVersion`이 0으로 초기화되는 재시작 동작 정리 (D3 이후 남은 관찰)
- [ ] 멀티루트 영역별 상태 키와 영역 전환 시 분리·무효화
- [ ] 창/프로세스 식별자: 같은 폴더를 두 창에서 열 때 `state.json` 마지막 쓰기 덮어쓰기 방지
- [ ] DESIGN 10.1 검색 명령 추가
- [ ] 의존성 그래프 개별 노드 펼침/접기, 아키텍처 뷰 상태 조회·조작 (`set_expand_all` 외)
- [ ] `state.json`에 분석 결과·진단·스키마 전환 추가 (현재 뷰 상태 + 스키마 버전만)
- [ ] 자동화 환경에서 1회 관찰된 D4(시작 시 워크스페이스 폴더 미탐지 → 상태 파일 미생성) 재현 여부 확인

### 6.3 실행 명령

```bash
npm run build
npm run test:viewstate   # phase 1 왕복 + phase 2 재시작 복원
npm test                 # 단위 테스트
npm run check:types
npm run lint
```
