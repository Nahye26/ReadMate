// 배포 전에 채워 넣는 값. 둘 다 공개되어도 되는 값이다(Supabase 대시보드 → Project Settings → API 의 Project URL, anon public key).
// service role 키나 Gemini 키는 절대 여기에 넣지 않는다.
export const SUPABASE_URL = 'https://gcqpbjyjpiryviulbbyq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_kmADoFUOHHx6TBn63lMjYg_ZH7i2LoC'; // ← anon public key 를 붙여 넣는다
// 사용성 테스트는 조건 B만 쓴다. 효과성 검증 때 A/B 배정을 붙이려면 여기와 app.js 의 CONDITION 만 바꾸면 된다.
export const CONDITION = 'B';

// 시작 화면에서 고를 수 있는 읽기 자료. 연구자가 미리 올려 둔 자료의 source_id를 sourceId에 넣는다(Supabase SQL 편집기: select id, title from sources order by created_at desc;).
// sourceId가 비어 있는 항목은 목록에 나오지 않는다. 모두 비어 있으면 기존처럼 PDF를 직접 올리는 화면이 나온다.
// 고른 자료는 sources.shared = true 여야 다른 사람도 쓸 수 있다: update sources set shared = true where id in ('…', '…');
// key는 로그의 paper_id로 남는다(?paper= 주소 값이 있으면 그것이 우선한다).
export const PAPERS = [
  { key: 'A', sourceId: '', short: '김도희(2022) 갤러리 오픈런', label: "김도희 (2022). MZ세대의 '갤러리 오픈런' 현상에 대한 비판적 고찰. 『인문사회 21』, 13(4), 79–94." },
  { key: 'B', sourceId: '', short: '윤소정(2021) 팬덤의 웨이브 이론', label: '윤소정 (2021). 컨버전스 시대의 팬 활동: 팬덤의 웨이브 이론을 중심으로. 『인문사회 21』, 12(4), 909–922.' },
];
