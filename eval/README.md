# ReadMate 평가 (promptfoo, 기록-재생)

Claude 앱(채팅·아티팩트)에서 진행한 세션의 로그를 `runs/`에 모아 두고, promptfoo로 규칙 검사와 집계를 자동화한다.
모델을 호출하지 않으므로 **API 키가 필요 없다.** (`echo` 제공자가 저장된 로그를 그대로 되돌려 보낸다.)

## 실행

```bash
cd eval
node --test test/check_log.test.js                                   # 검사기 단위 테스트
npx promptfoo@latest eval -c promptfooconfig.yaml --no-cache          # runs/*.json 전체 검사
npx promptfoo@latest view                                             # 결과 화면
node aggregate.js                                                     # 조건·모델별 집계 + 같은 논문 A/B 쌍 비교
```

## runs/ 파일 형식

한 세션당 파일 하나. `_`로 시작하는 파일은 건너뛴다.

```json
{
  "meta": {
    "run_id": "A-paper01-opus-01",
    "source": "claude-chat",
    "model": "Claude Opus 5.5",
    "condition": "A",
    "paper_id": "paper01",
    "note": "선택"
  },
  "log": { "...세션 종료 시 출력된 JSON 로그 그대로..." }
}
```

- `meta.condition`이 `A`/`B`이고 `paper_id`가 같은 run이 쌍으로 모이면 `aggregate.js`가 쌍 비교를 보여 준다.
- `log.prompt_version`이 `v0.5-chat`이면 엄격 검사, `v0.4`/`v0.4-chat`이면 호환 검사를 적용한다.
- `runs/pilot-*.json`은 조건 도입 전(v0.4-chat) 파일럿 로그다.

## 검사 항목 (`checks/check_log.js`)

| 구분 | 항목 |
|---|---|
| 공통 | 필수 필드, 완료 수 = 전체 − 미해결 수, 안내 수준 0~2, 회상 예측이 선택지(0.125/0.375/0.625/0.875)인지, 보정 판정(예측 − 실제, ±0.25) |
| v0.5 | 조건 ↔ reading_type(A=발췌형, B=맥락형), 안내 수준 고정(모두 2), `new_info_in_recall=false`, `calibration_gap` 계산, 배열 길이 3, 힌트 단계 0~3 |

## 이 방식으로 확인하지 못하는 것

- 대화 내용의 질(힌트가 정답에 가까운지, 인출 범위를 지켰는지)은 로그의 자기 보고에 의존한다. 필요하면 대화 기록을 함께 저장해 사람이 표본 검토하거나, API 키를 연결해 `llm-rubric` 채점을 추가한다.
- Claude 앱에서는 온도 등을 고정할 수 없어서 같은 입력의 반복 실행 간 변동을 직접 확인해야 한다.

## 프롬프트

`prompts/readmate_prompt_v0.5.md`가 현재 프롬프트다. `prompt.js`는 이 파일에서 프롬프트 본문을 꺼내 입력값을 채우는 promptfoo 프롬프트 함수로, 나중에 API 키를 연결해 실시간 평가를 붙일 때 쓴다. (아직 어떤 설정 파일에서도 사용하지 않는다.)
