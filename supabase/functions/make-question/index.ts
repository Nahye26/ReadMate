// POST /make-question
// 입력: { session_id, mission_idx }
// 미션을 시작할 때 학생이 읽을 글(앞·핵심·뒤 청크 전체)을 보고 질문을 만든다(계획 때 만들지 않는다: 단계가 앞 미션의 결과에 달려 있다).
//   - 단계(depth)는 과제 요구 항목의 유형과 앞선 미션 결과로 서버가 정한다(core.ts levelDepth). 학습자가 고르지 않는다.
//   - 이미 만든 미션이면 저장된 질문을 그대로 돌려준다(새로고침·중복 요청에 안전).
//   - 현재 진행 중인 미션만 만들 수 있다.
// 저장: missions.variants = [{qtype, question, cue, frame}] / mission_secrets.key_points = { [qtype]: 핵심 요소[], _ev: { [qtype]: 요소별 근거 문장 번호[][] } }
//   근거 번호는 화면과 같은 이어 붙인 번호이며, 학생이 고른 근거 문장과 견주는 기준이다. 응답에는 포함하지 않는다.
import {
  chunksTouched, currentMission, DEFAULT_FLOW, levelDepth, levelInfos, QTYPES, supportBefore, windowNums, type FlowOpts, type Pick, type QType,
} from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildQuestionPrompt } from '../_shared/prompts.ts';
import { loadWindow } from '../_shared/window.ts';

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
  const { session_id, mission_idx } = body ?? {};
  if (typeof session_id !== 'string' || !Number.isInteger(mission_idx) || mission_idx < 0) {
    return json({ error: 'bad_request', message: 'session_id와 mission_idx가 필요합니다' }, 400);
  }

  const db = serviceClient();
  const { data: ses } = await db
    .from('sessions').select('id, owner, source_id, config, started_at, finished_at').eq('id', session_id).maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ error: 'session_finished' }, 409);
  if (!ses.source_id) return json({ error: 'source_missing', message: '세션의 읽기 자료가 삭제되었습니다' }, 500);
  const cfg = (ses.config ?? {}) as { lazy?: boolean; reqs?: string[]; req_types?: unknown; adaptDepth?: boolean; fade?: boolean };
  if (!cfg.lazy) return json({ error: 'not_lazy', message: '질문이 이미 만들어진 세션입니다' }, 409);
  const flow: FlowOpts = { fade: cfg.fade ?? DEFAULT_FLOW.fade, adaptDepth: cfg.adaptDepth ?? DEFAULT_FLOW.adaptDepth };

  const [{ data: missions }, { data: turns }] = await Promise.all([
    db.from('missions').select('idx, req, picks, context_ids, variants').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const history = turns ?? [];
  const list = missions ?? [];
  const mission = list.find((m) => m.idx === mission_idx);
  if (!mission) return json({ error: 'not_found', message: '없는 미션입니다' }, 404);
  const current = currentMission(history, list.length);
  if (current === null) return json({ error: 'session_complete', message: '모든 미션이 끝났습니다' }, 409);
  if (mission_idx !== current) return json({ error: 'not_current', current }, 409);

  const levels = levelInfos(list, cfg.reqs ?? [], cfg.req_types);
  const support = supportBefore(history, mission_idx, flow, levels);
  const depth = levelDepth(history, mission_idx, levels, flow.adaptDepth);
  const qtype: QType = QTYPES[depth];
  const reqType = levels[mission_idx].type;

  const made = (mission.variants as { qtype: QType }[]) ?? [];
  if (made.length) {
    const v = made[0];
    return json({ mission_idx, qtype: v.qtype, depth: QTYPES.indexOf(v.qtype), req_type: reqType, support, variant: v, cached: true });
  }

  const ids = (mission.context_ids as string[]) ?? [];
  const loaded = await loadWindow(db, ses.source_id, ids);
  if (!loaded) return json({ error: 'chunk_missing' }, 500);
  const { win, chunks } = loaded;
  const picked = (mission.picks as Pick[])[0];
  const coreSp = win.spans.find((sp) => sp.id === picked[0]);
  if (!coreSp) return json({ error: 'chunk_missing' }, 500);
  const roles = win.spans.map((sp) => (sp.id === picked[0] ? 'core' : sp.from < coreSp.from ? 'before' : 'after')) as ('before' | 'core' | 'after')[];
  const core: [number, number] = [coreSp.from + picked[1] - 1, coreSp.from + picked[2] - 1];
  const reqText = cfg.reqs?.[mission.req - 1] ?? '';

  // 이전에 낸 질문(같은 세션)은 겹치지 않게 알려 준다.
  const prior = list.filter((m) => m.idx !== mission_idx).flatMap((m) => ((m.variants as { question?: string }[]) ?? []).map((v) => v.question ?? '')).filter(Boolean);

  let result: { question: string; cue: string; frame: string; keys: string[]; ev: number[][]; spanOk: boolean } | null = null;
  let note: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    try {
      const d = await askJson(buildQuestionPrompt({ req: reqText, reqType, depth: depth as 0 | 1 | 2, win, roles, core, prior, retryNote: note }), undefined, 'plan');
      const question = str(d?.question, 200);
      const kp = (Array.isArray(d?.key_points) ? d.key_points : []).slice(0, 3);
      const keys = kp.map((k: any) => str(k?.text, 120)).filter(Boolean);
      const ev = kp.filter((k: any) => str(k?.text, 120)).map((k: any) => windowNums(k?.evidence, win, 4));
      if (!question || keys.length < 2) throw new LlmError('invalid_json', '질문 또는 핵심 요소가 부족합니다');
      if (ev.some((e: number[]) => !e.length)) throw new LlmError('invalid_json', '핵심 요소마다 근거 문장 번호가 있어야 합니다');
      const spanOk = depth === 0 ? ev.some((e: number[]) => e.length >= 2) : chunksTouched(win, ev.flat()) >= 2;
      const candidate = { question, cue: str(d?.cue, 120), frame: str(d?.frame, 160), keys, ev, spanOk };
      if (!spanOk && attempt === 0) {
        note = depth === 0
          ? '핵심 요소의 근거가 한 문장뿐이었습니다. 같은 청크의 서로 다른 문장 2개 이상을 묶어야 답이 나오는 질문으로 다시 만드세요.'
          : '핵심 요소의 근거가 한 청크 안에만 있었습니다. 서로 다른 청크의 내용을 이어야 답이 나오는 질문으로 다시 만드세요.';
        result = null;
        lastErr = candidate; // 두 번째도 어긋나면 이 후보를 쓴다
        continue;
      }
      result = candidate;
    } catch (e) {
      lastErr = e;
      if (e instanceof LlmError && e.code === 'rate_limited') break;
      note = '이전 시도가 형식에 맞지 않았습니다. key_points는 2~3개, 각각 text와 evidence(위 번호) 배열을 포함하세요.';
    }
  }
  if (!result && lastErr && !(lastErr instanceof Error) && (lastErr as any).question) result = lastErr as any; // 근거 범위가 어긋났어도 형식은 맞은 후보
  if (!result) {
    const code = lastErr instanceof LlmError ? lastErr.code : 'llm_failed';
    return json({ error: code, message: (lastErr as Error)?.message ?? '질문을 만들지 못했습니다' }, code === 'rate_limited' ? 429 : 502);
  }

  const variant = { qtype, question: result.question, cue: result.cue, frame: result.frame };
  // 같은 미션에 요청이 겹치면 마지막 저장이 남는다. 화면이 응답이 올 때까지 다시 요청하지 않으므로 드문 경우다.
  const upd = await db.from('missions').update({ variants: [variant] }).eq('session_id', session_id).eq('idx', mission_idx);
  if (upd.error) return json({ error: 'db_error', message: upd.error.message }, 500);
  const sec = await db.from('mission_secrets').upsert(
    { session_id, idx: mission_idx, key_points: { [qtype]: result.keys, _ev: { [qtype]: result.ev } } },
    { onConflict: 'session_id,idx' },
  );
  if (sec.error) {
    await db.from('missions').update({ variants: [] }).eq('session_id', session_id).eq('idx', mission_idx); // 판정 기준 없이 질문만 남지 않게
    return json({ error: 'db_error', message: sec.error.message }, 500);
  }
  await db.from('events').insert({
    session_id, t: Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10, type: 'question_generated',
    data: { m: mission_idx + 1, level: depth + 1, req_type: reqType, window: chunks.length, span_ok: result.spanOk },
  }).then(() => {}, () => {});

  return json({ mission_idx, qtype, depth, req_type: reqType, support, variant });
});
