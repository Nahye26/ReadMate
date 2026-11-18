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

// 임베딩 실패. code: quota_exhausted(하루 한도 소진 — 기다려도 소용없음), rate_limited(분당 한도 — 잠시 뒤 가능), embed_failed(그 밖).
export type EmbedErrorCode = 'quota_exhausted' | 'rate_limited' | 'embed_failed';
export class EmbedError extends Error {
  code: EmbedErrorCode;
  status?: number;
  constructor(code: EmbedErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Gemini 오류 본문에서 사람이 읽을 메시지, 일일 한도 여부, 권장 대기 시간(초)을 뽑는다. 본문이 JSON이 아니어도 동작한다.
export function parseGeminiError(text: string): { message: string; daily: boolean; retryAfterSec: number | null } {
  let message = text;
  let retryAfterSec: number | null = null;
  try {
    const e = JSON.parse(text)?.error;
    if (e?.message) message = String(e.message);
    for (const d of e?.details ?? []) {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ''));
      if (m) retryAfterSec = Math.ceil(+m[1]);
    }
  } catch (_) { /* 본문 그대로 쓴다 */ }
  // 일일 한도: quotaId에 PerDay가 있거나, 한도가 0으로 막힌 경우(무료 한도가 열리지 않은 계정)
  const daily = /PerDay|per day/i.test(text) || /limit:\s*0\b/.test(text);
  return { message: message.slice(0, 600), daily, retryAfterSec };
}

async function call(texts: string[], task: EmbedTask): Promise<number[][]> {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new EmbedError('embed_failed', 'GEMINI_API_KEY 비밀값이 필요합니다');
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
  let last: EmbedError | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body });
    if (res.ok) {
      const data = await res.json();
      const out = (data.embeddings ?? []).map((e: { values: number[] }) => normalize(e.values));
      if (out.length !== texts.length) throw new EmbedError('embed_failed', '임베딩 응답 개수가 맞지 않습니다');
      return out;
    }
    const info = parseGeminiError(await res.text());
    const detail = `임베딩 API 오류 ${res.status}: ${info.message}`;
    // 하루 한도는 기다려도 풀리지 않으므로 재시도하지 않는다(재시도도 한도를 쓴다). 초기화는 태평양시 자정이다.
    if (res.status === 429 && info.daily) throw new EmbedError('quota_exhausted', detail, 429);
    last = new EmbedError(res.status === 429 ? 'rate_limited' : 'embed_failed', detail, res.status);
    if (res.status !== 429 && res.status < 500) break; // 키 오류 등은 다시 보내도 같다
    // 분당 한도·일시 과부하(503)는 간격을 늘려 다시 시도한다. Google이 알려 준 대기 시간이 있으면 그것을 따른다(최대 30초).
    const wait = info.retryAfterSec != null ? Math.min(info.retryAfterSec, 30) * 1000 : 1500 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw last ?? new EmbedError('embed_failed', '임베딩 API 오류');
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
