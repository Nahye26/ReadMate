// POST /submit-answer
// 입력: { session_id, mission_idx, action: 'answer' | 'hint', qtype, answer?, evidence? }
//   evidence: 학생이 원문에서 눌러 고른 근거 문장 번호(근거 범위 안의 1부터 번호, 최대 5개). 선택 사항이며 판정에는 쓰지 않고 기록만 한다(로그의 evidence_cited, 결과표의 근거 문장 수).
//   answer: 학생 답변 제출. 복붙이면 다시 쓰게 하고, 아니면 판정(pass/partial/fail)한다.
//   hint:   학생이 막혀서 요청했을 때만. 서버가 자동으로 주지 않는다. 한 번에 한 단계씩 1 → 2 → 3.
// 규칙(프롬프트 v0.5 1-5, 1-6절):
//   - 보완은 미션당 1회. 첫 답이 판정 기준에 못 미치면 맞은 부분 + 빠진 한 가지 + 다시 확인할 위치를 안내한다(정답은 알려 주지 않는다).
//     보완 답도 부족하면 핵심 요점을 보여 주고 미해결로 넘어간다. 처음 답이 충분하면 보완을 요청하지 않는다.
//   - 힌트 횟수와 보완 횟수는 따로 센다. 복붙으로 다시 쓰게 한 것은 보완으로 세지 않는다.
//   - 미션은 순서대로만 진행한다.
//   - 미션이 끝나면(통과 또는 미해결) 다음 미션의 안내 수준·질문 깊이·질문 유형을 돌려준다(next_support). 기준은 core.ts nextSupport:
//     도움 없음 / 조금(힌트 1단계, 보완 받음) / 많이(힌트 2단계 이상). 실험 모드(config.fade/adaptDepth = false)에서는 바뀌지 않는다.
// 상태는 따로 저장하지 않고 turns 기록에서 되살린다(core.ts missionState). 같은 미션에 요청 두 개가 겹치면 둘 다 처리될 수 있으므로,
// 클라이언트는 응답이 올 때까지 제출 버튼을 막아야 한다.
// 판정은 조건(A/B)과 무관하게 핵심 발췌 + key_points만으로 한다. 복붙 감지도 핵심 발췌와 비교해, B의 추가 텍스트가 감지 기준을 바꾸지 않게 한다.
import {
  answerOutcome, basisPick, currentMission, isCopy, leaksKey, MAX_HINT, missionState, pickQtype, QTYPES, resolvePick, sentenceNums,
  supportBefore, type Basis, type Chunk, type FlowOpts, type Pick, type QType, type Verdict,
} from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildHintPrompt, buildJudgePrompt } from '../_shared/prompts.ts';

const MAX_ANSWER_CHARS = 2000;
const VERDICTS: Verdict[] = ['pass', 'partial', 'fail'];

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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
  const { session_id, mission_idx, action, qtype } = body ?? {};
  const answer = str(body?.answer, MAX_ANSWER_CHARS + 1);
  if (body?.evidence !== undefined && !Array.isArray(body.evidence)) {
    return json({ error: 'bad_request', message: 'evidence는 문장 번호 배열이어야 합니다' }, 400);
  }
  if (typeof session_id !== 'string' || !Number.isInteger(mission_idx) || mission_idx < 0) {
    return json({ error: 'bad_request', message: 'session_id와 mission_idx가 필요합니다' }, 400);
  }
  if (action !== 'answer' && action !== 'hint') return json({ error: 'bad_request', message: 'action은 answer 또는 hint입니다' }, 400);
  if (!QTYPES.includes(qtype)) return json({ error: 'bad_request', message: 'qtype이 올바르지 않습니다' }, 400);
  if (action === 'answer' && (!answer || answer.length > MAX_ANSWER_CHARS)) {
    return json({ error: 'bad_request', message: `answer는 1~${MAX_ANSWER_CHARS}자여야 합니다` }, 400);
  }

  const db = serviceClient();

  // 1) 세션과 소유자 확인 (service role은 RLS를 우회하므로 직접 확인한다)
  const { data: ses } = await db
    .from('sessions')
    .select('id, owner, source_id, condition, consent_answers, started_at, finished_at, config')
    .eq('id', session_id)
    .maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ error: 'session_finished' }, 409);
  if (!ses.source_id) return json({ error: 'source_missing', message: '세션의 읽기 자료가 삭제되었습니다' }, 500);

  const [{ data: missions }, { data: turns }] = await Promise.all([
    db.from('missions').select('idx, req, picks, context_ids, variants').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const mission = (missions ?? []).find((m) => m.idx === mission_idx);
  if (!mission) return json({ error: 'not_found', message: '없는 미션입니다' }, 404);
  if (!(mission.variants as { qtype: string }[]).some((v) => v.qtype === qtype)) {
    return json({ error: 'bad_request', message: '이 미션에 없는 질문 유형입니다' }, 400);
  }

  // 2) 진행 순서와 상태
  const history = turns ?? [];
  const current = currentMission(history, missions!.length);
  if (current === null) return json({ error: 'session_complete', message: '모든 미션이 끝났습니다' }, 409);
  if (mission_idx !== current) return json({ error: 'not_current', current }, 409);
  const state = missionState(history, mission_idx);
  if (state.qtype && state.qtype !== qtype) return json({ error: 'qtype_mismatch', expected: state.qtype }, 409);

  // 3) 핵심 발췌 (A 기준). 판정·힌트·복붙 감지는 모두 이 텍스트를 기준으로 한다.
  const basis = ((ses.config as { basis?: Basis } | null)?.basis) ?? 'excerpt';
  const picked = (mission.picks as Pick[])[0];
  const { data: coreRow } = await db
    .from('chunks').select('id, sec, sentences').eq('source_id', ses.source_id).eq('id', picked[0]).maybeSingle();
  if (!coreRow) return json({ error: 'chunk_missing' }, 500);
  const core: Chunk = { id: coreRow.id, sec: coreRow.sec, s: coreRow.sentences, t: (coreRow.sentences as string[]).join(' ') };
  // 근거 범위 밖의 번호, 중복, 6번째 이후는 버린다. 선택은 비어 있어도 된다.
  const evidence: number[] = [...new Set<number>((body?.evidence ?? []).map((n: unknown) => Math.round(Number(n))))]
    .filter((n) => n >= 1 && n <= core.s.length).sort((a, b) => a - b).slice(0, 5);
  const pick = basisPick(basis, picked, core.s.length); // 근거 범위: excerpt면 고른 문장, chunk면 핵심 청크 전체
  const byId = { [core.id]: core };
  const coreView = { sentences: core.s.slice(pick[1] - 1, pick[2]), from: pick[1] };
  const coreText = coreView.sentences.join(' ');

  const variant = (mission.variants as { qtype: string; question: string }[]).find((v) => v.qtype === qtype)!;
  const { data: secret } = await db
    .from('mission_secrets').select('key_points').eq('session_id', session_id).eq('idx', mission_idx).maybeSingle();
  const keys: string[] = (secret?.key_points as Record<string, string[]> | undefined)?.[qtype] ?? [];
  const reqText = (ses.config as { reqs?: string[] } | null)?.reqs?.[mission.req - 1] ?? '';

  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  const record = async (payload: Record<string, unknown>, kind: 'answer' | 'hint') => {
    const { error } = await db.from('turns').insert({ session_id, mission_idx, kind, payload });
    return error;
  };
  const event = (type: string, data: Record<string, unknown>) =>
    db.from('events').insert({ session_id, t, type, data: { m: mission_idx + 1, ...data } }).then(() => {}, () => {}); // 로그 실패는 진행을 막지 않는다
  const llmFail = (e: unknown) => {
    const code = e instanceof LlmError ? e.code : 'llm_failed';
    return json({ error: code, message: (e as Error).message }, code === 'rate_limited' ? 429 : 502);
  };

  /* ---------- 힌트 ---------- */
  if (action === 'hint') {
    const level = state.hintLevel + 1;
    if (level > MAX_HINT) return json({ error: 'hints_exhausted', hint_level: state.hintLevel }, 409);

    let text = '';
    let location: string | undefined;
    let quote: string | undefined;
    let sentences: number[] | undefined;
    try {
      const data = await askJson(
        buildHintPrompt({ level: level as 1 | 2 | 3, req: reqText, question: variant.question, keys, core: coreView }),
      );
      if (level === 2) {
        // 인용문은 LLM이 쓴 글이 아니라 서버가 원문에서 꺼낸다. 위치만 알려 주고 끝내지 않는다.
        sentences = sentenceNums(pick, data?.sentences, 2);
        const r = resolvePick(byId, [core.id, sentences[0], sentences[sentences.length - 1]]);
        location = `${r.sec} · ${r.id} · ${sentences.length === 1 ? `문장 ${sentences[0]}` : `문장 ${sentences.join(', ')}`}`;
        quote = sentences.map((n) => core.s[n - 1]).join(' ');
        text = '이 부분을 다시 읽어 보세요.';
      } else {
        text = str(data?.text, 400);
        if (!text) throw new LlmError('invalid_json', '힌트가 비어 있습니다');
        if (leaksKey(text, keys)) text = level === 1
          ? '질문이 묻는 대상이 발췌에서 어떻게 설명되는지, 그 설명의 방향에 주목해 보세요.'
          : '발췌 안에서 앞부분과 뒷부분이 어떻게 이어지거나 대비되는지 직접 짚어 보세요.';
      }
    } catch (e) {
      return llmFail(e);
    }

    const err = await record({ qtype, level, text, ...(sentences ? { sentences } : {}) }, 'hint');
    if (err) return json({ error: 'db_error', message: err.message }, 500);
    await event('hint_given', { level });
    return json({ action: 'hint', level, hint_level: level, hints_left: MAX_HINT - level, text, location, quote });
  }

  /* ---------- 답변 ---------- */
  const stored = ses.consent_answers ? { answer } : {}; // 답변 원문은 동의한 경우에만 저장한다
  const total = missions!.length;
  const cfg = (ses.config ?? {}) as { fade?: boolean; adaptDepth?: boolean };
  const flow: FlowOpts = { fade: cfg.fade === true, adaptDepth: cfg.adaptDepth === true };

  if (isCopy(answer, coreText)) {
    const err = await record({ qtype, copy: true, outcome: 'rewrite', len: answer.length, ...stored }, 'answer');
    if (err) return json({ error: 'db_error', message: err.message }, 500);
    await event('copy_detected', {});
    return json({ action: 'answer', outcome: 'rewrite', message: '발췌를 거의 그대로 옮기셨어요. 핵심만 골라 자신의 말로 한 번 더 써 주세요.' });
  }

  // 조건 B: 앞뒤 맥락은 context_used 판단에만 쓴다. 판정에는 반영하지 않는다.
  let context: string | undefined;
  const extra = ((mission.context_ids as string[]) ?? []).filter((id) => id !== core.id);
  if (ses.condition === 'B' && extra.length) {
    const { data: rows } = await db.from('chunks').select('id, idx, sentences').eq('source_id', ses.source_id).in('id', extra);
    context = (rows ?? []).sort((a, b) => a.idx - b.idx).map((r) => (r.sentences as string[]).join(' ')).join('\n');
  }

  let verdict: Verdict;
  let praise = '';
  let gap = '';
  let recheckNums: unknown;
  let evidenceCited = false;
  let usedContext = false;
  try {
    const d = await askJson(
      buildJudgePrompt({
        req: reqText, qtype: qtype as QType, question: variant.question, keys, core: coreView, context, answer,
        revision: state.attempts > 0,
      }),
    );
    if (!VERDICTS.includes(d?.verdict)) throw new LlmError('invalid_json', '판정 값이 올바르지 않습니다');
    verdict = d.verdict;
    praise = str(d.praise, 300);
    gap = str(d.gap, 300);
    recheckNums = d.recheck;
    evidenceCited = d.evidence_cited === true;
    usedContext = !!context && d.used_context === true;
  } catch (e) {
    return llmFail(e); // 판정이 없으면 기록하지 않는다. 학생은 같은 답을 다시 제출할 수 있다.
  }

  const attemptsBefore = state.attempts;
  const outcome = answerOutcome(attemptsBefore, verdict);
  const stage = attemptsBefore === 0 ? 'first' : 'revision';
  const payload = {
    qtype, stage, copy: false, verdict, outcome, evidence_cited: evidenceCited || evidence.length > 0, evidence, used_context: usedContext,
    hints_before: state.hintLevel, len: answer.length, ...stored,
  };
  const err = await record(payload, 'answer');
  if (err) return json({ error: 'db_error', message: err.message }, 500);

  const done = outcome !== 'revise';
  const next = done && mission_idx + 1 < total ? mission_idx + 1 : null;

  // 미션이 끝났으면 다음 미션의 안내 수준·깊이·질문 유형을 정한다. 방금 쓴 기록까지 넣어 처음부터 다시 계산한다.
  let nextSupport: { sup: number; depth: number; qtype: QType } | null = null;
  if (next !== null) {
    const after = [...history, { mission_idx, kind: 'answer', payload }];
    const from = supportBefore(history, mission_idx, flow);
    const to = supportBefore(after, next, flow);
    const qtypes = ((missions!.find((m) => m.idx === next)!.variants as { qtype: QType }[]) ?? []).map((v) => v.qtype);
    nextSupport = { ...to, qtype: pickQtype(qtypes, to.depth, { adaptDepth: flow.adaptDepth, last: next === total - 1 }) };
    await event('support_changed', {
      from: from.sup, to: to.sup, depthFrom: from.depth, depthTo: to.depth, hints: state.hintLevel, revised: stage === 'revision',
    });
  }
  const base = { action: 'answer', outcome, verdict, hint_level: state.hintLevel, evidence_cited: evidenceCited || evidence.length > 0, evidence };

  if (outcome === 'passed') {
    await event('mission_passed', { stage, hints: state.hintLevel });
    // 보완한 답이 통과하면 학생이 이전 답을 고친 것으로 본다(로그의 self_corrections).
    return json({ ...base, praise, self_correction: stage === 'revision', next_mission: next, next_support: nextSupport, all_done: next === null });
  }

  if (outcome === 'revise') {
    // 정답은 알려 주지 않고 다시 확인할 위치만 안내한다.
    const nums = sentenceNums(pick, recheckNums, 3);
    const r = resolvePick(byId, [core.id, nums[0], nums[nums.length - 1]]);
    const safeGap = leaksKey(gap, keys) ? '' : gap;
    await event('revision_requested', { verdict });
    return json({ ...base, praise, gap: safeGap, recheck: { location: `${r.sec} · ${r.id} · ${r.range}` }, next_mission: null, all_done: false });
  }

  // unresolved: 보완 뒤에도 부족하면 핵심 요점을 짧게 보여 주고 다음으로 넘어간다.
  await event('mission_unresolved', { hints: state.hintLevel });
  return json({ ...base, praise, reveal: keys, next_mission: next, next_support: nextSupport, all_done: next === null });
});
