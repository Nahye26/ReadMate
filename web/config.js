// 배포 전에 채워 넣는 값. 둘 다 공개되어도 되는 값이다(Supabase 대시보드 → Project Settings → API 의 Project URL, anon public key).
// service role 키나 Gemini 키는 절대 여기에 넣지 않는다.
export const SUPABASE_URL = 'https://gcqpbjyjpiryviulbbyq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_kmADoFUOHHx6TBn63lMjYg_ZH7i2LoC'; // ← anon public key 를 붙여 넣는다
// 사용성 테스트는 조건 B만 쓴다. 효과성 검증 때 A/B 배정을 붙이려면 여기와 app.js 의 CONDITION 만 바꾸면 된다.
export const CONDITION = 'B';
