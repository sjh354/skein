# 5단계 수동 검증 — 이력·변경 공통 경로

`docs/DESIGN.md` 13.2 5단계의 완료 기준 중 자동화가 확인한 부분과 실제 화면·언어 확장이 필요한 부분을 분리한다.

- 자동 검증: `npm run test:change`
- 자동 검증 코드: `tests/vscode-e2e/suite/changeHistory.test.ts`, `tests/vscode-e2e/suite/changeRecovery.test.ts`, `scripts/verify-change.mjs`
- 단위 검증: `tests/analyzer/change/*`, `tests/extension/ChangeService.test.ts`, `tests/extension/CommandBridgeService.test.ts`, `tests/mcp/changeTools.test.ts`, `tests/shared/change.test.ts`
- 실행 환경: 실제 VS Code 확장 호스트 + 실제 `dist/mcpServer.mjs` stdio, 임시 Git 사용자 저장소가 있는 샌드박스

## 1. 자동 검증이 확인하는 것

### 1단계 — 계획·적용·되돌리기 (8개 검사)

- `skein_plan_change`가 파일을 수정하지 않고 `preview-ready` 계획과 diff를 반환한다
- `skein_apply_change`가 두 파일의 선언·import·호출을 바꾸고, `succeeded`와 이력 항목을 남긴다
- `skein_list_change_history`가 되돌릴 항목을 알려 준다
- `skein_undo_change`가 원래 이름을 복원하고 `undo` 이력을 추가한다
- `skein_redo_change`가 다시 적용하고 `redo` 이력을 추가한다
- 사용자가 이름을 바꾼 뒤 되돌리면 `conflict`로 거부되고 편집이 그대로 남는다 (첫 hunk 포함)
- 계획 후 파일이 바뀌면 적용이 `stale-plan`으로 거부된다
- 사용자 Git의 HEAD·브랜치·인덱스가 변하지 않고 `.skein`이 추적되지 않는다
- 내부 저장소에 before/after 스냅샷과 이력 3건 이상이 남는다

### 2단계 — 중단 복구 (2개 검사)

- `applying` 상태로 남은 작업을 다음 활성화가 `recovery`/`interrupted-after`로 분류한다
- 복구 과정에서 파일을 수정하거나 미완료 작업을 완료 이력으로 추가하지 않는다

### 실행 방법

```bash
npm run build
npm run test:change   # phase 1 → phase 2
```

## 2. 사용자가 직접 확인할 항목

사전 준비:

- [ ] `npm run build` 후 `F5`로 Extension Development Host 실행
- [ ] 테스트용 TS 파일을 열고 콜 그래프에서 심벌 선택
- [ ] Codex에 `codex mcp add skein --env WORKSPACE_ROOT=<repo> -- node <repo>/dist/mcpServer.mjs` 등록 (이미 있으면 생략)
- [ ] Dart 확인 시 Dart/Flutter 확장과 `dart` CLI가 설치된 프로젝트 사용

### M1. 편집기에서 이름 변경

- [ ] 심벌 선택 후 `Skein: Rename Selected Symbol` 실행 → 이름 입력 창
- [ ] 미리보기 diff가 열리고, 확인 모달에서 Apply를 눌러야만 파일이 바뀌는가
- [ ] 성공 후 "Undo is available" 안내가 나오고 `Skein: Undo Last Tool Change`로 복원되는가

### M2. Dart 실제 이름 변경

- [ ] Dart 파일의 함수/클래스 이름을 바꾼다
- [ ] Dart 확장이 없는 환경에서 `rename-provider-unavailable`로 명시 거부되는가
- [ ] Dart 확장이 있는 환경에서 선언·호출·import가 함께 바뀌는가
- [ ] `part`/라이브러리 private 등 지원 조건이 실제와 맞는가

### M3. 저장하지 않은 편집

- [ ] 파일을 수정하되 저장하지 않고 이름 변경 시도 → `unsaved-changes` 거부, 파일 무변경
- [ ] 저장 후 다시 시도하면 정상 적용되는가

### M4. 이력 화면

- [ ] `Skein: Show Change History`에서 항목·상태·파일 수가 보이는가
- [ ] 최신 항목만 Undo/Redo가 가능하고, 오래된 항목은 불가 안내가 나오는가

### M5. 충돌 표시

- [ ] 적용 후 사용자가 같은 줄을 직접 수정하고 되돌리기 → 충돌 hunk와 경로가 보이는가
- [ ] 파일이 덮어써지지 않고, 이력에 실패 항목이 남지 않는가

### M6. 멀티루트·영역 전환

- [ ] `Skein: Set Workspace Folder`로 다른 루트를 선택한 뒤 변경 이력이 그 루트의 `.skein/history`를 쓰는가
- [ ] 한 루트의 이력이 다른 루트에 섞이지 않는가

### M7. 에이전트 실제 호출

- [ ] `skein_get_view_state`의 `selection`에서 nodeId를 복사해 `skein_plan_change`에 그대로 넣는다
- [ ] 응답의 `plan.planId`로 `skein_apply_change`를 호출한다
- [ ] `skein_list_change_history` → `skein_undo_change` → `skein_redo_change` 흐름이 혼동 없이 이어지는가

### M8. 이력 격리

- [ ] 작업 전후 `git rev-parse HEAD`, `git ls-files -s`, `git status --porcelain`을 비교한다 (HEAD·인덱스 불변)
- [ ] `.skein/history/repo.git`에 before/after 커밋이 있고 원격이 없는가
- [ ] `.skein` 폴더가 사용자 저장소에서 untracked로 보이지 않는가

### M9. 프로세스 중단

- [ ] 적용 중 Extension Host를 강제 종료한다 (또는 큰 파일에서 적용 직후 `Developer: Reload Window`)
- [ ] 재시작 후 `tasks/<planId>.json`이 `recovery`로 바뀌고 파일이 자동 적용·자동 롤백되지 않는가
- [ ] 남은 파일 상태를 보고 수동으로 Undo할 수 있는가

### M10. 검증 실패 처리

- [ ] 적용 후 새 오류가 생기는 fixture에서 `verification-failed`가 기록되는가
- [ ] 자동 롤백 없이 diff와 이력이 남는가
- [ ] 프로젝트 테스트·구조 규칙이 `not-run`으로 표시되는가 (5단계 범위)

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
| M10 | | | | |

## 4. 완료 판정

- [ ] `npm run test:change` 통과
- [ ] M1·M3·M4·M5에서 화면 동작 확인
- [ ] M2에서 Dart 실제 이름 변경 확인 또는 미지원 사유 기록
- [ ] M7에서 에이전트 왕복 확인
- [ ] M8·M9에서 격리·복구 확인
- [ ] blocker 0건
