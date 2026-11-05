// 임베딩: Supabase Edge Runtime 내장 모델(gte-small, 384차원). 외부 API 키와 비용이 없다.
// 주의: gte-small은 영어 중심 모델이다. 한국어 자료가 중심이 되면 다국어 모델로 바꾸고
// chunks.embedding 의 차원과 match_chunks 의 인자 차원을 함께 바꾸는 마이그레이션이 필요하다. (docs/DESIGN.md 8절)
export const EMBEDDING_DIM = 384;

let session: any;
function getSession() {
  // deno-lint-ignore no-explicit-any
  session ??= new (globalThis as any).Supabase.ai.Session('gte-small');
  return session;
}

export async function embed(text: string): Promise<number[]> {
  const v = await getSession().run(text, { mean_pool: true, normalize: true });
  return Array.from(v as ArrayLike<number>);
}

// pgvector는 '[0.1,0.2,...]' 문자열 리터럴을 받는다.
export const toVector = (v: number[]) => `[${v.join(',')}]`;
