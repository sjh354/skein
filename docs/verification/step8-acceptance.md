# 8단계 수용 기준 결과

`docs/DESIGN.md` 13.1의 수용 기준과 8단계 완료 기준을 이번 변경 뒤 상태로 기록한다. 원격 작업이라 실제 화면·실기기 확인이 필요한 항목은 완료로 표시하지 않는다.

- 측정일: 2026-11-03 (Asia/Seoul)
- 브랜치: `chore/8-prune-integration`
- 기준선: [step8-baseline.md](step8-baseline.md)
- 대체표: [step8-replacement-table.md](step8-replacement-table.md)

## 자동 검증 결과

| 검사 | 결과 |
|---|---|
| `npm run check:types` | 통과 |
| `npm run lint` | 통과 |
| `npm test` | 276 files, 4,302 passed, 17 skipped |
| `npm run test:coverage` | 기본 5초 제한에서 `SymbolAnalyzer` 5건 타임아웃; `npx vitest run --coverage --testTimeout=20000`으로 276 files·4,302 passed, lines 84.26% |
| `npm run test:diagnostics` | 23 files, 465 passed |
| `npm run test:viewstate` | 12 + 2 passed (MCP 왕복, 재시작 복원) |
| `npm run test:change` | 8 + 2 passed (계획→이력→적용→되돌리기→재적용→충돌) |
| `npm run test:refactor` | 8 passed (이동·생성/삭제·추출·인라인) |
| `npm run build -- --production` | 통과 |
| `npm run package` | 32 files, 9.89 MB |
| `npm run package:verify` | `.map` 0, 아이콘 포함 |
| VSIX 내용 | `.wasm` 8개, `.scm` 6개, `callgraph.js`·`.skein` 없음 |
| 전체 `npm run test:vscode` | 아래 "전체 E2E" 참고 |

### 전체 E2E

전체 스위트는 변경 전과 같은 12개 실패를 기준으로 비교한다. 단계별 스크립트는 별도 워크스페이스를 쓰므로 위 표의 결과가 우선이다.

- 변경 전: 184 passing, 3 pending, 12 failing
- 변경 후: 188 passing, 3 pending, 7 failing

변경 후 실패 7개는 모두 기준선과 같은 범주다.

- View State restore phase 2: 전체 실행에서는 phase 1이 만든 `verify-expected.json`이 없다.
- Move/extract/inline, Change recovery, Change history: 전체 실행에는 `E2E_WORKSPACE` 샌드박스가 설정되지 않는다.
- Architecture view 3건: 픽스처 기준 그룹·엣지 수가 하드코딩 기대값과 다르다.

기준선에 있던 View State 초기값·MCP 왕복·Architecture 2건은 이번 실행에서 통과했고, 새로 실패한 스위트는 없다.

## 13.1 수용 기준

| 영역 | 자동 증거 | 판정 | 남은 수동 확인 |
|---|---|---|---|
| 분석·표시 | 분석기·Dart·언어별 단위 테스트, E2E 언어 스위트 | 자동 통과 | 실제 화면에서 Dart·TS 영역 구분 |
| 코드 연결 | `fileGraphInteractions`, `symbolSelection`, `callGraph` E2E | 자동 통과 | 클릭 상세·더블클릭 이동·엣지 위치 선택 |
| UI | `viewModeCycle`, `toolbarCommands`, `fileGraphInteractions` E2E | 자동 통과 | 원형 무라벨·분할·배치 보존 시각 확인 |
| 최신성 | `test:viewstate`, 파일 저장·삭제 관련 E2E | 자동 통과 | 저장 전 편집·실패·미해결 표시 |
| 변경 | `test:change`, `test:refactor`(TS) | TS 자동 통과 | Dart 실제 이름 변경·이동·추출·인라인 |
| 이동 범위 | `refactor` 단위·E2E(보조 함수·공유·private·순환·이름 충돌) | 자동 통과 | ggultarae 실제 사례 |
| 구조 규칙 | `test:diagnostics`, `architectureRules` 단위 | 자동 통과 | 실제 프로젝트의 기준선·예외·악화 |
| 진단 | `test:diagnostics`(다섯 영역, candidate/confirmed 구분) | 자동 통과 | 실제 화면 근거·한계 표시 |
| 미리보기 | `test:change`(계획 지문·재계산·diff) | 자동 통과 | 편집기 미리보기와 확인 모달 |
| 이력 | `test:change`(undo/redo·3-way 병합·충돌·중단 복구) | 자동 통과 | 충돌 hunk 표시와 해결 흐름 |
| 격리 | `test:change`가 사용자 Git HEAD·인덱스·브랜치·`.skein` 비추적 확인 | 자동 통과 | 없음 |
| MCP | `test:viewstate` MCP 왕복, MCP 단위 테스트 | 자동 통과 | Codex 실제 대화 왕복 |
| 로컬성 | LLM 클라이언트 제거, 자동 LLM 호출 0, 재분석 설정 보존 테스트 | 자동 통과 | 없음(구조적 확인) |
| 확장성 | 어댑터 등록·기능 선언 단위 테스트 | 자동 통과 | 새 어댑터 추가 시 UI 분기 없음 확인 |

## 8단계 고유 확인

| 항목 | 결과 |
|---|---|
| 제거 코드의 참조 0 | `HtmlExporter`, `useGraphData`, `clusterUtils`, `removedNameImporters`, `workspaceText`, LLM 클라이언트, `shared/index`, `callgraph` 엔트리 모두 grep 0 |
| 미사용 의존성 | `vis-network`, `ajv` 제거, 빌드·테스트 통과 |
| 빌드 산출물 | `dist/callgraph.js` 제거, `webview.js` 하나로 통합 |
| 캐시·통계 경로 | `.skein/cache`, `~/.skein/stats`; 기존 `.graph-it/cache` 1회 이동 테스트 통과 |
| 패키징 제외 | `.skein/**`, `dist/callgraph.js`, `**/*.map` 제외 확인 |
| 문서 | README·DEVELOPMENT·HANDOFF·DESIGN·architecture·AGENTS 갱신 |

## 남은 수동 확인 (4~7단계 이월)

- 4단계: `docs/verification/step4-manual-checklist.md` — 약 46개
- 5단계: `docs/verification/step5-manual-checklist.md` — 약 37개
- 6단계: `docs/verification/step6-manual-checklist.md` — 약 49개
- 7단계: `docs/verification/step7-manual-checklist.md` — 약 34개
- 8단계: [step8-replacement-table.md](step8-replacement-table.md)의 "남은 수동 확인"

위 항목을 완료하기 전에는 단계 8 또는 MVP 전체를 "완료"로 표시하지 않는다.


## 2026-11-03 후속 연결 구현 검증

- 파일·리스트·심벌·아키텍처 선택 게시, 현재 화면 검색, 개별 노드/그룹 펼침·접기, 아키텍처 화면 조작과 제한된 분석/진단 참조를 연결했다.
- `skein.toggleViewMode` 제거와 Copilot 네이티브 도구 계속 지원은 사용자 결정으로 확정했다.
- `test:viewstate`: 13 + 2 통과. 새 파일 그래프 검색·선택·개별 접기가 실제 VS Code + MCP 왕복에 포함된다.
- `test:change`: 8 + 2 통과. `test:refactor`: 8 통과. `test:diagnostics`: 467 통과.
- 전체 E2E에서 단계별 전용 스위트가 잘못 실행되던 구성을 수정했다. 일반 실행에서는 분리하고 Linux PR CI에서 전용 스크립트를 모두 실행한다. 검사를 생략하는 방식으로 대체하지 않는다.
- 현재 픽스처의 Louvain 그룹 28개·파일 엣지 216개를 기대값에 반영했다. 작은 패널에서 진단 상세가 캔버스 높이를 모두 차지하는 결함도 수정했다.
- 수동 항목은 아직 사용자 관찰 전이다. `HANDOFF.md`의 묶음 순서로 진행하며, 이 기록만으로 MVP 수용을 완료로 바꾸지 않는다.


### 화면 간 동기화 보완

- `SharedWebviewHub`가 패널·에디터 탭에 동일 분석 메시지를 전달하고, 새 화면에 최근 결과를 재전달한다.
- 실제 사용자 선택·개별 펼침·호출 그래프 배치/줌/팬을 다른 화면에 반영한다. 수신 상태는 사용자 조작으로 재게시하지 않는다.
- 전체 단위 검사: 279 files, 4,328 passed, 17 skipped. 타입 검사·린트와 공유 상태 왕복/재시작 검사 통과.
- 전체 일반 E2E: 178 passed, 3 pending, 1 failed. 남은 실패는 이전 세션의 `list` 복원을 무시한 초기값 기대였으며, 검사가 시작 모드를 명시하도록 수정했다. 해당 스위트와 아키텍처 화면은 수정 후 재검증한다.
- 실제 두 화면의 사용성·시각적 동등성은 사용자 수동 확인 전까지 대기로 유지한다.


### Windows 경로 검증 보완

Windows CI에서 원시 경로(`C:\…`)와 제품의 정규화 경로(`c:/…`)를 비교하던 테스트 fixture를 정규화했다. 실제 `VSCodeChangeHost.isDirty`도 같은 정규화 함수를 사용하도록 수정해, 드라이브 문자 표기가 다른 저장 전 편집을 놓치지 않게 했다. Windows 형식 경로를 사용하는 회귀 검사는 macOS에서도 실행한다.


### 지연 레이아웃과 뷰포트 보존

Windows 경로 보완 후 원격 macOS·Windows 검사는 통과했다. Linux 전체 E2E에서 같은 구조의 지연 재배치가 현재 포커스의 줌·팬을 덮는 사례를 확인했다. 구조가 바뀌지 않은 재배치는 뷰포트를 다시 맞추지 않고, 상세 상태는 배치 완료 후 게시하도록 수정했다. 위치 캐시의 크기 정보가 달라 강제 재배치되는 상황을 회귀 검사에 추가했으며 아키텍처 화면 단위 검사 77개가 통과했다.


### 패널·에디터 관측 대상 분리

전체 E2E에서 패널과 에디터 탭의 서로 다른 크기에서 나온 줌·팬 보고가 섞이는 경로도 확인했다. 동일 분석 결과는 계속 공유하되, 렌더·상세·뷰포트 보고는 현재 조작 대상 화면에서만 받는다. 실제 사용자 입력이 다른 화면에서 발생하면 그 화면으로 조작 대상을 바꾼다. 비활성 화면의 보고 제외와 실제 클릭 후 대상 전환을 회귀 검사로 확인했다. 화면 간 선택 해제도 연결했다.


### 초기 복원과 테스트 드라이버 대상

확장 활성화와 MCP 명령 큐 시작은 초기 뷰 복원 완료를 기다린다. 이전 세션의 모드가 첫 명령을 나중에 덮는 순서를 방지한다. 아키텍처 E2E 드라이버의 가짜 사용자 입력은 현재 화면 한 곳에만 전달하며, 분석 결과는 계속 모든 화면에 공유한다. 확장 계층 단위 검사 33 files·515개와 타입 검사·린트가 통과했다.
