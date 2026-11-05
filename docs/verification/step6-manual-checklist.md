# 6단계 수동 검증 — 이동·추출·인라인

`docs/DESIGN.md` 13.2 6단계의 완료 기준 중 자동화가 확인한 부분과, 실제 화면·언어 확장·실제 프로젝트가 필요한 부분을 분리한다.

- 자동 검증: `npm run test:refactor`
- 자동 검증 코드: `tests/vscode-e2e/suite/refactor.test.ts`, `scripts/verify-refactor.mjs`
- 단위 검증: `tests/analyzer/change/refactor.test.ts`, `tests/extension/ChangeService.test.ts`, `tests/mcp/changeTools.test.ts`
- 실행 환경: 실제 VS Code 확장 호스트 + 실제 `dist/mcpServer.mjs` stdio, `tests/fixtures/refactor-sandbox`의 임시 Git 사용자 저장소
- 기준: `docs/DESIGN.md` 8.1~8.3, 13.2 6단계

## 1. 자동 검증이 확인하는 것

`npm run test:refactor`는 실제 VS Code 확장 호스트와 MCP stdio로 다음을 확인한다.

### 이동 (TypeScript)

- 계획 단계에서 대상 파일을 만들지 않고 `preview-ready` 계획과 diff만 반환한다
- 공개 helper는 원래 파일에 남고 새 파일이 `import { helper } from "./app"`으로 가져온다
- 참조 파일의 `import` 경로가 새 파일로 바뀐다
- 적용 후 새 파일 생성이 이력에 `created`로 기록된다
- 되돌리기에서 생성 파일이 삭제되고 원래 파일·import가 복원된다
- 다시 적용에서 파일이 재생성된다
- 계획 후 원본이 바뀌면 `stale-plan`으로 거부된다
- 사용자 Git의 HEAD·인덱스가 변하지 않고 `.skein`이 추적되지 않는다

### 추출·인라인 (TypeScript)

- 선택한 식이 인자 `(a, b)`를 가진 함수로 추출되고 호출부가 바뀐다
- 인라인이 모든 호출을 식으로 바꾸고 원래 함수 선언을 제거한다
- 이력에 `move`·`extract`·`inline`·`undo`·`redo`가 남는다

### 단위 검증

- 이동 묶음: 대상만 쓰는 private helper는 함께 이동, 밖에서도 쓰는 helper는 유지, 공개 helper 유지
- 이동 차단: Dart private helper, 이름 충돌, 순환 import, 진입점, 해석되지 않은 import
- 추출: 식/문장 선택, 인자 추론, 명시적 실패 사유
- 인라인: 전체 호출 치환, exported·다중 return·외부 참조 거부

## 2. 사용자가 직접 확인할 항목

사전 준비:

- [ ] `npm run build` 후 `F5`로 Extension Development Host 실행
- [ ] 테스트용 TypeScript 파일과 Dart 파일을 각각 연다
- [ ] Codex에 `codex mcp add skein --env WORKSPACE_ROOT=<repo> -- node <repo>/dist/mcpServer.mjs` 등록
- [ ] Dart 확인 시 Dart/Flutter 확장과 `dart` CLI가 설치된 프로젝트 사용

### M1. 이동 — 새 파일 (UI)

- [ ] 콜 그래프에서 함수를 선택하고 `Skein: Move Selected Symbol to File` 실행
- [ ] 대상 경로 입력 창에서 상대 경로를 넣으면 워크스페이스 기준으로 해석되는가
- [ ] 미리보기에서 새 파일 탭이 "created"로 열리고 확인 후에만 파일이 생기는가
- [ ] 이동 후 원본·대상·참조 파일의 import가 실제 TypeScript 진단 오류 없이 유지되는가

### M2. 이동 — 기존 파일·공유 helper

- [ ] 이미 있는 파일로 이동했을 때 기존 import 문과 병합되고 중복 선언이 생기지 않는가
- [ ] bundle 밖에서도 쓰는 helper가 원래 파일에 남고 새 파일이 그것을 import하는가
- [ ] 공개 API helper가 이동하지 않고 원래 파일에 남는가
- [ ] 이동 결과가 순환 import를 만들면 `circular-import`로 거부되는가

### M3. 이동 — 차단 사유

- [ ] `main`/`build`/default export/프레임워크 진입점 이동이 `entry-point`로 거부되는가
- [ ] 대상 파일에 같은 이름이 있으면 `name-collision`으로 거부되는가
- [ ] 경로 별칭(`@/`), package import, 재수출, 동적 import처럼 import를 확신할 수 없는 참조가 `unresolved-import` 또는 명시적 실패로 끝나는가
- [ ] 거부 시 파일이 전혀 바뀌지 않는가

### M4. 이동 — Dart

- [ ] 공개 함수 이동이 성공하고 참조 파일에 새 파일 import가 추가되는가
- [ ] `_private` helper가 필요한 이동이 `access-restricted`로 거부되는가
- [ ] `part`/`library` 관계, `package:` URI, `show`/`hide` 조합에서 잘못된 import를 만들지 않는가
- [ ] Dart 확장이 없는 환경에서 심벌·참조 조회 실패가 명시적으로 표시되는가

### M5. 추출

- [ ] 편집기에서 식을 선택해 `Skein: Extract Selection as Function` 실행 → 인자·호출부가 맞는가
- [ ] 여러 줄 문장을 선택했을 때 `void` 호출로 추출되는가
- [ ] 선택 밖 지역 변수와 함수 인자가 매개변수로 올라오는가
- [ ] `this` 사용, 동기 함수 안의 `await`, 읽을 수 없는 매개변수 패턴이 명시적으로 거부되는가
- [ ] 추출 후 새 함수 위치가 읽기 좋은가 (enclosing 함수 뒤)

### M6. 인라인

- [ ] 여러 호출이 있는 단일 식 함수에서 `Skein: Inline Function`이 모든 호출을 바꾸는가
- [ ] 호출 인자의 우선순위가 괄호로 보존되는가
- [ ] exported 함수, 여러 return, async/제너레이터, 외부 파일 참조가 명시적으로 거부되는가
- [ ] MCP `skein_plan_change`에서 `callLine`/`callCharacter`로 특정 호출만 인라인할 수 있는가

### M7. 이력·복구

- [ ] 이동으로 만든 파일을 Undo하면 삭제되고, Redo하면 다시 생기는가
- [ ] 이동 후 사용자가 새 파일을 직접 수정하고 Undo하면 충돌로 보고되고 수정이 보존되는가
- [ ] 삭제된 파일을 편집기 탭이 열린 상태에서 Undo/Redo해도 `File Modified Since` 오류가 없는가
- [ ] 이동·추출·인라인이 `Show Change History`에서 종류별 아이콘·상태로 보이는가

### M8. 에이전트 실제 호출

- [ ] `skein_plan_change`에 `kind: "move"`, `path`, `name`, `line`, `newPath`를 넣어 계획을 받는가
- [ ] `kind: "extract"`에 `startLine`/`startCharacter`/`endLine`/`endCharacter`를 넣어 계획을 받는가
- [ ] `kind: "inline"`에서 `callLine` 생략 시 전체, 지정 시 해당 호출만 계획되는가
- [ ] 계획 응답의 `plan.analysis.bundle`에서 이동/유지 결정과 이유를 읽을 수 있는가
- [ ] 같은 `planId`를 두 번 적용하면 `plan-not-ready`로 거부되는가

### M9. 실제 프로젝트 (ggultarae)

- [ ] Dart 앱에서 함수 이동 1건, 추출 1건, 인라인 1건을 실제 코드로 수행
- [ ] TypeScript 서버에서 공유 helper가 있는 이동 1건, package/경로 별칭 참조 1건을 수행
- [ ] 실패한 사례는 이유와 함께 기록하고, 성공으로 표시하지 않는다

## 3. 기록 양식

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

## 4. 완료 판정

- [ ] `npm run test:refactor` 통과
- [ ] M1·M2·M5·M6에서 화면 동작과 diff 확인
- [ ] M4에서 Dart 실제 이동 성공 또는 미지원 사유 기록
- [ ] M3·M6에서 차단 사유가 파일을 바꾸지 않는지 확인
- [ ] M7에서 생성·삭제 Undo/Redo와 충돌 보존 확인
- [ ] M8에서 에이전트 왕복 확인
- [ ] M9에서 ggultarae 사례 결과 기록
- [ ] blocker 0건
