# ReadMate 웹앱 (사용성 테스트용)

빌드 없이 정적 파일로 배포하는 화면이다. 서버(Supabase Edge Function)를 호출하며, 조건은 B로 고정이다(A/B 선택 화면 없음).

## 배포 전에 할 일
1. `config.js`의 `SUPABASE_ANON_KEY`에 anon public key를 넣는다(공개되어도 되는 값). service role 키와 Gemini 키는 넣지 않는다.
2. Supabase → Authentication → Sign In / Providers에서 **Anonymous sign-ins**를 켠다.
3. 함수를 모두 배포하고 마이그레이션 세 개를 적용한다(`docs/DESIGN.md` 10절). 이 앱이 부르는 함수: `ingest-source`, `plan-session`, `submit-answer`, `report-question`, `recall`, `connect`, `finish-session`.
4. `web/` 폴더를 정적 호스팅(GitHub Pages, Netlify, Vercel 등)에 올린다. 로컬에서는 `npx serve web`.

## 주소 매개변수 (연구자용)
- `?source=<source_id>`: 연구자가 `sources.shared = true`로 표시해 둔 자료를 쓴다. PDF 업로드 칸이 사라진다.
- `?researcher=이름`, `?paper=논문ID`: 세션에 기록된다.

## 화면 흐름
시작(과제·PDF·동의 2개) → 읽기 계획 → 미션(읽기 작업, 힌트, 피드백) × N → 예측 → 정리 → 연결(선택) → 결과(읽기 부담, 끝내기). 어느 단계에서든 "중단"으로 이유와 읽기 부담을 남기고 그만둘 수 있다.

Figma에 없던 화면(연결, 중단 창, 불러오는 중, 오류와 다시 시도, 미해결 미션의 핵심 요점)은 같은 스타일로 임시로 만들었다. 디자인이 나오면 `style.css`와 `app.js`의 해당 함수만 바꾸면 된다.

## 알려진 한계
- 새로고침하면 진행 화면이 사라진다. 서버에는 기록이 남아 있지만 세션을 다시 불러오는 함수가 아직 없다.
- PDF는 40쪽 이하, 글자를 선택할 수 있는 파일만 읽는다(스캔본은 읽지 못한다).
- 서버 함수는 아직 실제로 실행해 본 적이 없다. 화면 흐름은 가짜 서버 응답으로만 확인했다.
