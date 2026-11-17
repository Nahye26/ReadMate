// LLM 호출 (Gemini). 키는 Supabase 비밀값(secrets)에서만 읽는다. 브라우저로 내려보내지 않는다.
//   supabase secrets set GEMINI_API_KEY=... GEMINI_MODEL=...
// 호출 방식은 index.html 데모의 gemCall을 서버로 옮긴 것이다. 모델 이름은 코드에 고정하지 않는다.

export class LlmError extends Error {
  code: string;
  constructor(code: string, message = '') {
    super(message || code);
    this.code = code;
  }
}

export function parseJson(t: string) {
  const candidates = [t];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fenced) candidates.push(fenced[1]);
  const a = t.search(/[{[]/);
  const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (_) { /* 다음 후보 */ }
  }
  throw new LlmError('invalid_json', 'JSON 해석 실패: ' + t.slice(0, 80));
}

// 일시 과부하(503), 한도(429), 시간 초과는 간격을 두고 다시 시도한다. Edge Function 전체 제한(약 150초) 안에서 끝내도록 시간을 계산한다.
const TOTAL_BUDGET_MS = 125_000;
const ATTEMPT_MS = 45_000;

async function once(prompt: string, key: string, model: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', maxOutputTokens: 8192 },
        }),
      },
    );
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LlmError('timeout', `${timeoutMs / 1000}초`);
    throw new LlmError('network', String((e as Error).message));
  } finally {
    clearTimeout(timer);
  }
}

export async function askJson(prompt: string, timeoutMs = ATTEMPT_MS) {
  const key = Deno.env.get('GEMINI_API_KEY');
  const model = Deno.env.get('GEMINI_MODEL');
  if (!key || !model) throw new LlmError('not_configured', 'GEMINI_API_KEY / GEMINI_MODEL 비밀값이 필요합니다');
  // 주 모델이 계속 막히면(503/429/시간 초과) 예비 모델로 넘어간다. 예비 모델은 GEMINI_FALLBACK_MODELS(쉼표로 구분)로 바꿀 수 있다.
  const fallbacks = (Deno.env.get('GEMINI_FALLBACK_MODELS') ?? 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean);
  const models = [model, ...fallbacks.filter((m) => m !== model)];

  const started = Date.now();
  let res: Response | undefined;
  let lastErr: LlmError | undefined;
  outer: for (const mdl of models) {
    for (let attempt = 0; attempt < 2; attempt++) { // 모델마다 2번
      const left = TOTAL_BUDGET_MS - (Date.now() - started);
      if (left < 8000) break outer;
      try {
        res = await once(prompt, key, mdl, Math.min(timeoutMs, left));
      } catch (e) {
        lastErr = e as LlmError;
        res = undefined;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (res.ok) break outer;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) break outer; // 키 오류 등은 모델을 바꿔도 소용없다
      lastErr = new LlmError(res.status === 429 ? 'rate_limited' : 'error', `HTTP ${res.status} (${mdl})`);
      res = undefined;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!res) throw lastErr ?? new LlmError('timeout', '시간 초과');

  if (!res.ok) {
    const code = res.status === 429 ? 'rate_limited' : [400, 401, 403].includes(res.status) ? 'bad_key' : 'error';
    let msg = '';
    try {
      msg = (await res.json()).error.message;
    } catch (_) { /* 본문 없음 */ }
    throw new LlmError(code, msg || `HTTP ${res.status}`);
  }

  const j = await res.json();
  const cand = j.candidates?.[0];
  const text: string = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  if (!text) throw new LlmError('invalid_json', '빈 응답: ' + (cand?.finishReason ?? '알 수 없음'));
  if (cand?.finishReason === 'MAX_TOKENS') throw new LlmError('invalid_json', 'truncated');
  return parseJson(text);
}
