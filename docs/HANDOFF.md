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
