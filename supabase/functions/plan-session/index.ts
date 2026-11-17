// POST /plan-session
// 입력: { source_id, assignment, condition: 'A'|'B', experiment?, fast?, researcher?, paper_id?, consent_research?, consent_answers? }
// 동작:
//   1) 질문 세트 확보: (자료, 과제 안내문)마다 A 기준 계획을 한 번만 만들어 question_sets에 저장하고, 이후에는 그대로 다시 쓴다.
//      계획 = 과제 안내문 임베딩으로 찾은 상위 청크 → LLM → 서버 검증(cleanPlan). 미션마다 핵심 청크 하나 안의 1~3문장.
//   2) 조건 B: 같은 계획의 핵심 청크에 같은 절의 앞·뒤 청크를 붙인다(contextIds). 질문·판정 기준은 A와 같다.
//   3) sessions / missions / mission_secrets 저장
// 출력: 학생에게 보여 줄 미션(발췌 원문, 질문 변형). 판정 기준(key_points)은 응답에 포함하지 않는다.
import {
  cleanPlan, contextIds, DEFAULT_FLOW, estimateMins, EXPERIMENT_FLOW, normalizeAssignment, resolveExcerpts,
  type Chunk, type ChunkRef, type Condition, type PlanData,
} from '../_shared/core.ts';
import { embed, toVector } from '../_shared/embed.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildPlanPrompt } from '../_shared/prompts.ts';

const TOP_K = 16;
const PROMPT_VERSION = 'v0.5-chat'; // 로그 스키마 버전 (eval/ 과 동일)

type Db = ReturnType<typeof serviceClient>;
type Row = { id: string; idx: number; sec: string; sentences: string[] };
class PlanError extends Error {
  constructor(public status: number, public code: string, message = '') {
    super(message || code);
  }
}

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

const toChunk = (r: Row): Chunk => ({ id: r.id, sec: r.sec, s: r.sentences, t: r.sentences.join(' ') });

// 질문 세트가 있으면 그대로 쓰고, 없으면 A 기준으로 한 번 만들어 저장한다.
async function questionSetFor(
  db: Db,
  a: { sourceId: string; assignment: string; fast: boolean; paperId: string | null },
): Promise<{ id: string; plan: PlanData }> {
  // fast(미션 2개)는 세트 모양이 다르므로 키에 넣어 정식 세트와 섞이지 않게 한다.
  const hash = await sha256(normalizeAssignment(a.assignment) + (a.fast ? '|fast' : ''));
  const find = () =>
    db.from('question_sets').select('id, plan').eq('source_id', a.sourceId).eq('assignment_hash', hash).maybeSingle();

  const found = await find();
  if (found.data) return found.data as { id: string; plan: PlanData };

  // 후보는 검색 결과 그대로다. 앞뒤 청크는 계획 단계에서 보여 주지 않는다(A 기준 입력).
  const { data: hits, error: hitErr } = await db.rpc('match_chunks', {
    p_source: a.sourceId,
    p_query: toVector(await embed(a.assignment)),
    p_k: TOP_K,
  });
  if (hitErr || !hits?.length) throw new PlanError(500, 'retrieval_failed', hitErr?.message);
  const candidates = (hits as Row[]).slice().sort((x, y) => x.idx - y.idx).map(toChunk);

  let plan: PlanData;
  try {
    const data = await askJson(buildPlanPrompt({ assignment: a.assignment, candidates, fast: a.fast }));
    plan = cleanPlan(data, candidates, { maxMissions: a.fast ? 2 : undefined });
  } catch (e) {
    const code = e instanceof LlmError ? e.code : 'invalid_plan';
    throw new PlanError(code === 'rate_limited' ? 429 : 502, code, (e as Error).message);
  }

  const ins = await db
    .from('question_sets')
    .insert({ source_id: a.sourceId, assignment_hash: hash, paper_id: a.paperId, model: Deno.env.get('GEMINI_MODEL') ?? null, plan })
    .select('id, plan')
    .single();
  if (!ins.error) return ins.data as { id: string; plan: PlanData };

  // 동시에 첫 요청 두 개가 오면 한쪽이 unique 위반(23505)으로 진다. 먼저 저장된 세트를 쓴다(세트가 두 개 생기면 안 된다).
  if (ins.error.code === '23505') {
    const again = await find();
    if (again.data) return again.data as { id: string; plan: PlanData };
  }
  throw new PlanError(500, 'db_error', ins.error.message);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const user = await authedUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  const { source_id, assignment, condition, experiment, fast, researcher, paper_id, consent_research, consent_answers } = body ?? {};
  if (typeof source_id !== 'string' || typeof assignment !== 'string' || !assignment.trim() || assignment.length > 4000) {
    return json({ error: 'bad_request', message: 'source_id와 assignment(4000자 이하)가 필요합니다' }, 400);
  }
  if (condition !== 'A' && condition !== 'B') {
    return json({ error: 'bad_request', message: 'condition은 A 또는 B여야 합니다' }, 400);
  }
  const cond = condition as Condition;

  const db = serviceClient();

  // service role은 RLS를 우회하므로 접근 권한을 직접 확인한다: 소유자이거나 연구자가 공유로 표시한 자료.
  const { data: src } = await db.from('sources').select('id, owner, shared').eq('id', source_id).maybeSingle();
  if (!src || (src.owner !== user.id && !src.shared)) return json({ error: 'not_found' }, 404);

  // 1) 질문 세트 (A 기준, 논문·과제별로 한 번만 생성)
  let qs: { id: string; plan: PlanData };
  try {
    qs = await questionSetFor(db, {
      sourceId: source_id,
      assignment,
      fast: !!fast,
      paperId: typeof paper_id === 'string' ? paper_id.slice(0, 80) : null,
    });
  } catch (e) {
    if (e instanceof PlanError) return json({ error: e.code, message: e.message }, e.status);
    throw e;
  }
  const plan = qs.plan;

  // 2) 제공 청크: 핵심 청크는 항상, 조건 B는 같은 절의 앞뒤 청크를 더한다.
  const coreIds = [...new Set(plan.missions.map((m) => m.pick[0]))];
  const { data: coreRows, error: coreErr } = await db
    .from('chunks').select('id, idx, sec, sentences').eq('source_id', source_id).in('id', coreIds);
  if (coreErr || (coreRows ?? []).length !== coreIds.length) {
    return json({ error: 'chunk_missing', message: coreErr?.message ?? '질문 세트의 핵심 청크를 찾지 못했습니다' }, 500);
  }
  let rows: Row[] = coreRows as Row[];

  if (cond === 'B') {
    const have = new Set(rows.map((r) => r.idx));
    const near = new Set<number>();
    rows.forEach((r) => [r.idx - 1, r.idx + 1].forEach((n) => n >= 0 && !have.has(n) && near.add(n)));
    if (near.size) {
      const { data: extra, error: exErr } = await db
        .from('chunks').select('id, idx, sec, sentences').eq('source_id', source_id).in('idx', [...near]);
      if (exErr) return json({ error: 'db_error', message: exErr.message }, 500);
      rows = rows.concat((extra ?? []) as Row[]);
    }
  }
  const byId: Record<string, Chunk> = Object.fromEntries(rows.map((r) => [r.id, toChunk(r)]));
  const refs: ChunkRef[] = rows.map(({ id, idx, sec }) => ({ id, idx, sec }));
  const refOf = (id: string) => refs.find((r) => r.id === id)!;

  const shown = plan.missions.map((m) => {
    const ctx = cond === 'B' ? contextIds(refOf(m.pick[0]), refs) : [m.pick[0]];
    const excerpts = resolveExcerpts(byId, m.pick, cond, ctx);
    return { ctx, excerpts, mins: estimateMins(excerpts.reduce((n, e) => n + e.text.length, 0)) };
  });

  // 3) 저장 (실패하면 세션을 지운다)
  const flow = experiment ? EXPERIMENT_FLOW : DEFAULT_FLOW;
  const { data: session, error: sesErr } = await db
    .from('sessions')
    .insert({
      owner: user.id,
      source_id,
      question_set_id: qs.id,
      condition: cond,
      experiment_mode: !!experiment,
      prompt_version: PROMPT_VERSION,
      researcher: typeof researcher === 'string' ? researcher.slice(0, 80) : null,
      paper_id: typeof paper_id === 'string' ? paper_id.slice(0, 80) : null,
      consent_research: !!consent_research,
      consent_answers: !!consent_answers,
      assignment: consent_answers ? assignment : null, // 답변 저장 동의가 없으면 과제 안내문도 남기지 않는다
      config: flow,
    })
    .select('id')
    .single();
  if (sesErr || !session) return json({ error: 'db_error', message: sesErr?.message }, 500);

  const missionRows = plan.missions.map((m, idx) => ({
    session_id: session.id,
    idx,
    req: m.req,
    picks: [m.pick], // 핵심 발췌(A 기준). 기존 형식([[chunkId, from, to], ...])을 유지한다.
    context_ids: shown[idx].ctx,
    variants: m.vars.map((v) => ({ qtype: v.qtype, question: v.q, cue: v.cue, frame: v.frame })), // key_points 제외
  }));
  const secretRows = plan.missions.map((m, idx) => ({
    session_id: session.id,
    idx,
    key_points: Object.fromEntries(m.vars.map((v) => [v.qtype, v.keys])),
  }));
  const m1 = await db.from('missions').insert(missionRows);
  const m2 = m1.error ? null : await db.from('mission_secrets').insert(secretRows);
  if (m1.error || m2?.error) {
    await db.from('sessions').delete().eq('id', session.id);
    return json({ error: 'db_error', message: (m1.error ?? m2?.error)?.message }, 500);
  }

  return json({
    session_id: session.id,
    reqs: plan.reqs,
    flow,
    missions: plan.missions.map((m, idx) => ({
      idx,
      req: m.req,
      mins: shown[idx].mins,
      text_units: shown[idx].ctx.length,
      excerpts: shown[idx].excerpts,
      variants: missionRows[idx].variants,
    })),
  });
});
