# 7단계 수동 검증 — 프로필·진단·차단

`docs/DESIGN.md` 13.2 7단계의 완료 기준 중 자동 검증이 확인한 부분과, 실제 화면·프로젝트가 필요한 부분을 분리한다.

- 자동 검증: `npm run test:diagnostics`
- 단위 검증:
  - `tests/analyzer/diagnostics/structureDiagnostics.test.ts`
  - `tests/analyzer/architecture/architectureRules.test.ts`(프로필·예외·기준선 v2)
  - `tests/extension/ChangeService.test.ts`(변경 차단·not-configured·사후 검증)
  - `tests/mcp/tools/architecture.test.ts`, `tests/mcp/worker/invokeTool.test.ts`
  - `tests/webview/components/architecture/`(진단 패널)
- 기준: `docs/DESIGN.md` 6.1, 7, 8.4, 13.2 7단계

## 1. 자동 검증이 확인하는 것

- `profiles`/`areas`의 레이어 역방향 import가 `profile:<area>` 확정 위반으로 나온다
- `exceptions`의 `rule`·`diagnostic` 허용과 `until` 만료가 적용된다
- 기준선 v1은 그대로 읽히고, v2의 진단 값보다 커지면 `worsened`가 된다
- 다섯 진단이 각각 최소 1건의 근거를 내고, 선언 규칙이 없는 항목은 `candidate`만 나온다
- 같은 후보를 확정 위반으로 표시하지 않는다
- 변경 적용 전 확정·신규·악화 위반이 있으면 `architecture-blocked`로 파일을 건드리지 않는다
- 설정이 없으면 `not-configured`, 검사 불가는 `incomplete`로 남고 성공으로 표시하지 않는다
- 적용 후 새 확정 위반은 `verification-failed`(`architecture-violation`)가 되며 자동 롤백하지 않는다
- MCP `skein_diagnose_structure`가 revision·페이징·한계를 지킨다

## 2. 사용자가 직접 확인할 항목

사전 준비:

- [ ] `npm run build` 후 `F5`로 Extension Development Host 실행
- [ ] `skein.architecture.json`에 `profiles`·`areas`·`exceptions`를 넣은 프로젝트를 연다
- [ ] Architecture view를 열고 **Refresh**를 누른다

### M1. 프로필 위반

- [ ] `ui`가 `infra`를 import하는 정상 방향은 위반으로 나오지 않는가
- [ ] `infra`가 `ui`를 import하는 역방향은 `profile:<area>` 확정 위반으로 나오는가
- [ ] `strict: true`에서 프로필 밖 파일 import가 위반으로 나오는가
- [ ] 영역 규칙이 Rules 패널에 선언 규칙과 함께 표시되는가

### M2. 예외와 만료

- [ ] `rule` 예외를 넣으면 해당 위반이 `excepted`로 보이고 `check-architecture`가 통과하는가
- [ ] `diagnostic` 예외를 넣으면 진단 패널에서 `excepted`로 보이는가
- [ ] `until`을 지난 예외가 다시 `new` 위반으로 돌아오는가
- [ ] 예외 이유가 Rules/진단 근거에 표시되는가

### M3. 기준선 v2와 악화

- [ ] 기준선 v1 파일이 수정 없이 동작하는가
- [ ] 진단 값을 기준선에 기록한 뒤 파일이 커지면 `worsened`로 표시되는가
- [ ] 값이 같거나 작아지면 `accepted`로 유지되는가
- [ ] 사라진 항목이 `resolved`로 나오는가

### M4. 다섯 진단과 근거

- [ ] 책임 집중: 큰 파일에서 lines/imports/importers와 임계값이 보이는가
- [ ] 중복 구현: 두 파일이 닮았을 때 후보가 나오고 "확정"이 아닌가
- [ ] 기능 배치: 프로필 위반이 확정으로, 나머지는 후보로 구분되는가
- [ ] 과도한 추상화: 단일 위임 래퍼·단일 구현 인터페이스가 후보로 나오는가
- [ ] 의존성 문제: 선언 규칙 위반은 확정, 순환·과중 결합은 후보인가
- [ ] 각 결과의 한계 문구가 함께 보이는가
- [ ] 큰 그래프에서 진단 패널이 빌드를 다시 유발하지 않는가

### M5. 변경 차단

- [ ] 규칙을 깨는 이동/이름 변경 계획을 적용하면 미리보기 후 `architecture-blocked`로 거부되는가
- [ ] 거부 시 파일 내용·이력이 그대로인가
- [ ] 예외가 있는 위반은 차단하지 않는가
- [ ] 규칙이 없는 프로젝트에서 기존 변경이 그대로 동작하는가
- [ ] 적용 후 새 위반이 생기면 `verification-failed`로 남고 자동 롤백하지 않는가

### M6. MCP 왕복

- [ ] `skein_diagnose_structure`가 같은 revision의 진단을 반환하는가
- [ ] `kind`·`status`·`area`·`offset`/`limit`이 실제로 페이지를 나누는가
- [ ] revision이 바뀐 뒤 이전 offset을 넘기면 거부되는가
- [ ] 에이전트가 `candidate`를 확정 위반처럼 요약하지 않는가

### M7. 성능·규모

- [ ] 대표 저장소에서 진단 포함 Refresh 시간이 수용 가능한가
- [ ] 중복 탐지가 매우 큰 파일에서 건너뛰기 한계를 지키는가
- [ ] 메모리 사용이 재분석 전후로 누적되지 않는가

## 3. 이전 단계에서 남은 확인

4·5·6단계의 수동 항목은 `step4-manual-checklist.md`, `step5-manual-checklist.md`, `step6-manual-checklist.md`에 그대로 남아 있다. 7단계 자동 검증은 그 항목을 대체하지 않는다.
