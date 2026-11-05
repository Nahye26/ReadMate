// POST /plan-session
// 입력: { source_id, assignment, condition: 'A'|'B', experiment?, fast?, researcher?, paper_id?, consent_research?, consent_answers? }
// 동작: 과제 안내문 임베딩으로 관련 청크 검색(조건 B는 앞뒤 청크 추가) → LLM이 읽기 지도 생성 → 서버가 검증
//       → sessions / missions / mission_secrets 저장
// 출력: 학생에게 보여 줄 미션(발췌 원문, 질문 변형). 판정 기준(key_points)은 응답에 포함하지 않는다.
import { cleanPlan, DEFAULT_FLOW, EXPERIMENT_FLOW, resolvePick, type Chunk, type Condition } from '../_shared/core.ts';
import { embed, toVector } from '../_shared/embed.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildPlanPrompt } from '../_shared/prompts.ts';

const TOP_K = 16;
const PROMPT_VERSION = 'v0.5-chat'; // 로그 스키마 버전 (eval/ 과 동일)

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

  const db = serviceClient();

  // service role은 RLS를 우회하므로 소유자를 직접 확인한다.
  const { data: src } = await db.from('sources').select('id, owner').eq('id', source_id).maybeSingle();
  if (!src || src.owner !== user.id) return json({ error: 'not_found' }, 404);

  // 1) 검색: 과제 안내문과 가까운 청크 (조건 B는 앞뒤 청크를 후보에 추가)
  const { data: hits, error: hitErr } = await db.rpc('match_chunks', {
    p_source: source_id,
    p_query: toVector(await embed(assignment)),
    p_k: TOP_K,
  });
  if (hitErr || !hits?.length) return json({ error: 'retrieval_failed', message: hitErr?.message }, 500);

  let rows: { id: string; idx: number; sec: string; sentences: string[] }[] = hits;
  if (condition === 'B') {
    const have = new Set(rows.map((r) => r.idx));
    const near = new Set<number>();
    rows.forEach((r) => [r.idx - 1, r.idx + 1].forEach((n) => n >= 0 && !have.has(n) && near.add(n)));
    if (near.size) {
      const { data: extra } = await db.from('chunks').select('id, idx, sec, sentences').eq('source_id', source_id).in('idx', [...near]);
      rows = rows.concat(extra ?? []);
    }
  }
  rows.sort((a, b) => a.idx - b.idx);
  const candidates: Chunk[] = rows.map((r) => ({ id: r.id, sec: r.sec, s: r.sentences, t: r.sentences.join(' ') }));
  const byId: Record<string, Chunk> = Object.fromEntries(candidates.map((c) => [c.id, c]));

  // 2) LLM이 읽기 지도를 만들고, 서버가 검증한다.
  let plan;
  try {
    const data = await askJson(buildPlanPrompt({ assignment, candidates, condition: condition as Condition, fast: !!fast }));
    plan = cleanPlan(data, candidates, condition as Condition, { maxMissions: fast ? 2 : undefined });
  } catch (e) {
    const code = e instanceof LlmError ? e.code : 'invalid_plan';
    return json({ error: code, message: (e as Error).message }, code === 'rate_limited' ? 429 : 502);
  }

  // 3) 저장 (실패하면 세션을 지운다)
  const flow = experiment ? EXPERIMENT_FLOW : DEFAULT_FLOW;
  const { data: session, error: sesErr } = await db
    .from('sessions')
    .insert({
      owner: user.id,
      source_id,
      condition,
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
    picks: m.pick,
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
    reason: plan.reason,
    flow,
    missions: plan.missions.map((m, idx) => ({
      idx,
      req: m.req,
      mins: m.mins,
      excerpts: m.pick.map((p) => resolvePick(byId, p)),
      variants: missionRows[idx].variants,
    })),
  });
});
