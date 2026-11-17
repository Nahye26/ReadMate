// 임베딩: Gemini 임베딩 API(gemini-embedding-001)를 384차원으로 줄여 쓴다.
// 내장 모델(gte-small)은 Edge Function의 CPU 시간 한도("CPU Time exceeded")에 걸려 PDF 업로드가 실패해서 서버 밖으로 옮겼다.
// 차원을 384로 맞춰 chunks.embedding / match_chunks 마이그레이션 없이 쓴다. GEMINI_API_KEY 를 그대로 쓴다.
// 주의: 모델이 달라 벡터 공간이 다르다. gte-small로 저장된 자료는 다시 올려야 검색이 맞는다.
export const EMBEDDING_DIM = 384;
const MODEL = () => Deno.env.get('GEMINI_EMBED_MODEL') || 'gemini-embedding-001';

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

function normalize(v: number[]): number[] {
  // 차원을 줄인 벡터는 길이가 1이 아니므로 직접 정규화한다.
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function call(texts: string[], task: EmbedTask): Promise<number[][]> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 비밀값이 필요합니다');
  const model = MODEL();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`;
  const body = JSON.stringify({
    requests: texts.map((t) => ({
      model: `models/${model}`,
      content: { parts: [{ text: t }] },
      taskType: task,
      outputDimensionality: EMBEDDING_DIM,
    })),
  });
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body });
    if (res.ok) {
      const data = await res.json();
      const out = (data.embeddings ?? []).map((e: { values: number[] }) => normalize(e.values));
      if (out.length !== texts.length) throw new Error('임베딩 응답 개수가 맞지 않습니다');
      return out;
    }
    last = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) break; // 503 "high demand" 같은 일시 과부하는 간격을 늘려 다시 시도 // 재시도해도 소용없는 오류
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw new Error(`임베딩 API 오류: ${last}`);
}

// 한 번에 최대 100개(API 한도). 호출 쪽은 이미 30개 이하로 나눠 보낸다.
export async function embedMany(texts: string[], task: EmbedTask = 'RETRIEVAL_DOCUMENT'): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 100) out.push(...(await call(texts.slice(i, i + 100), task)));
  return out;
}

export async function embed(text: string, task: EmbedTask = 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
  return (await call([text], task))[0];
}

// pgvector는 '[0.1,0.2,...]' 문자열 리터럴을 받는다.
export const toVector = (v: number[]) => `[${v.join(',')}]`;
