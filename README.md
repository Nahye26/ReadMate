# ReadMate

AI로 자료조사를 하는 대학생이 **원문을 직접 읽도록** 돕는 문해력 에듀테크 서비스. (팀 도란도란, Learning Engineering 프로젝트)

## 저장소 구성

| 경로 | 내용 |
|---|---|
| `index.html` | 데모(v0.4). 브라우저 안에서 PDF 처리부터 LLM 호출까지 한다. |
| `docs/DESIGN.md` | 웹앱 설계 (아키텍처, 데이터 모델, 이식 지도, 실험 모드, 보안, 마일스톤) |
| `supabase/migrations/` | DB 스키마 (pgvector, RLS) |
| `supabase/functions/` | Edge Function (`ingest-source`, `plan-session`, `submit-answer`, `report-question`, `recall`, `connect`, `finish-session`)과 공유 로직(`_shared/core.ts`) |
| `eval/` | promptfoo 기록-재생 평가, 프롬프트 v0.5, 로그 검사기·집계 스크립트 |

## 빠른 확인

```bash
node --test supabase/functions/_shared/core.test.ts     # 핵심 로직 (Node 22.18+)
cd eval && node --test test/check_log.test.js            # 로그 검사기
cd eval && npx promptfoo@latest eval -c promptfooconfig.yaml --no-cache   # 저장된 세션 로그 검사
cd eval && node aggregate.js                             # 조건·모델별 집계
```

Supabase 연결과 배포는 `docs/DESIGN.md` 10절을 본다. **비밀값(API 키)은 저장소에 커밋하지 않는다.**
