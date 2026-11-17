// POST /finish-session
// 입력: { session_id, reading_load: 1~5, exit_reason?: string }
//   reading_load: 오늘 읽기 분량과 난이도(1 가벼움 ~ 5 매우 부담). 프롬프트 v0.5 4절.
//   exit_reason:  중간에 그만둘 때만 보낸다. 있으면 미션·인출이 끝나지 않았어도 지금까지의 기록으로 요약한다.
// 서버가 turns 기록에서 eval/ 의 v0.5 로그 스키마(summary)를 만들어 sessions.summary에 저장하고 세션을 닫는다. 클라이언트가 보낸 값은 reading_load와 exit_reason뿐이다.
//   - 정상 종료는 모든 미션이 끝나고 인출이 끝났거나(고침까지) 건너뛴 뒤에만 가능하다. 통과한 미션이 없어 인출이 불가능한 경우는 인출 없이 종료할 수 있다.
//   - 시작하지 않은 미션은 요약에 넣지 않는다. 끝나지 않은 채 종료된 미션은 미해결로 센다.
//   - text_units_provided는 missions.context_ids의 길이다. 조건 B에서 절 경계 때문에 앞뒤 청크가 모자란 미션은 context_boundary에 true로 남겨 분석에서 따로 볼 수 있다.
//   - 같은 요청을 다시 보내면(이미 닫힌 세션) 저장된 요약을 그대로 돌려준다.
// 요약은 연구 동의(consent_research)와 관계없이 본인 세션에 저장된다. 연구자용 research_summaries 뷰는 동의한 세션만 보여 준다.
import {
  currentMission, DEFAULT_FLOW, missionRecords, pickRecallMission, recallState, summarize, type Condition, type FlowOpts,
} from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';

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
  const { session_id, reading_load } = body ?? {};
  const exitReason = typeof body?.exit_reason === 'string' ? body.exit_reason.trim().slice(0, 200) : '';
  if (typeof session_id !== 'string') return json({ error: 'bad_request', message: 'session_id가 필요합니다' }, 400);
  if (!Number.isInteger(reading_load) || reading_load < 1 || reading_load > 5) {
    return json({ error: 'bad_request', message: 'reading_load는 1~5의 정수여야 합니다' }, 400);
  }

  const db = serviceClient();
  const { data: ses } = await db
    .from('sessions')
    .select('id, owner, condition, paper_id, config, summary, started_at, finished_at')
    .eq('id', session_id)
    .maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ summary: ses.summary, already_finished: true });

  const [{ data: missions }, { data: turns }, { data: reports }] = await Promise.all([
    db.from('missions').select('idx, context_ids').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
    db.from('events').select('data').eq('session_id', session_id).eq('type', 'question_report').order('id'),
  ]);
  const history = turns ?? [];
  const total = missions?.length ?? 0;

  // 정상 종료 조건: 미션이 모두 끝났고 인출이 끝났다(또는 인출할 미션이 없다). 중간 종료는 이유를 한 번 받는다.
  if (!exitReason) {
    if (currentMission(history, total) !== null) {
      return json({ error: 'missions_not_done', message: '미션이 끝나지 않았습니다. 그만두려면 exit_reason을 보내세요' }, 409);
    }
    const rs = recallState(history).stage;
    if (pickRecallMission(history, total) !== null && rs !== 'done' && rs !== 'skipped') {
      return json({ error: 'recall_pending', stage: rs, message: '인출 확인을 끝내거나 건너뛴 뒤에 종료할 수 있습니다' }, 409);
    }
  }

  const cfg = (ses.config ?? {}) as { fade?: boolean; adaptDepth?: boolean };
  const flow: FlowOpts = { fade: cfg.fade ?? DEFAULT_FLOW.fade, adaptDepth: cfg.adaptDepth ?? DEFAULT_FLOW.adaptDepth };
  const condition: Condition = ses.condition === 'A' ? 'A' : 'B'; // 사용성 테스트는 B만 쓴다. 조건이 없는 일반 세션은 B로 본다.

  const { records, selfCorrections, boundary, evidenceCounts, idxs, recall } = missionRecords(history, missions ?? [], flow, condition);
  if (!records.length) return json({ error: 'nothing_to_summarize', message: '시작한 미션이 없습니다' }, 409);

  const s = summarize({
    model: Deno.env.get('GEMINI_MODEL') ?? 'unknown',
    condition,
    paperId: ses.paper_id ?? '',
    missions: records,
    recallPrediction: recall.jol ?? 0,
    newInfoInRecall: false, // 인출 채점은 핵심 발췌의 핵심 요소로만 한다(recall 함수). 서버 규칙상 항상 false.
    selfCorrections,
    readingLoad: reading_load,
    exitReason: exitReason || null,
  });
  // 인출을 하지 않았으면 예측·실제·보정은 값이 없다. 0으로 채우면 '과소'처럼 보이므로 null로 둔다.
  const noRecall = !s.recall_done;
  const summary = {
    ...s,
    ...(noRecall ? { recall_prediction: null, recall_actual: null, calibration: null, calibration_gap: null } : {}),
    // 미션별 질문 신고 사유(없으면 빈 배열). 사용성 테스트에서 질문 품질을 볼 때 쓴다.
    question_reports: idxs.map((i) => (reports ?? []).filter((r) => (r.data as { m?: number }).m === i + 1).map((r) => (r.data as { reason: string }).reason)),
    evidence_count: evidenceCounts, // 미션별 학생이 고른 근거 문장 수
    context_boundary: boundary, // B에서 같은 절 경계로 앞뒤 청크가 모자란 미션(분석에서 제외 후보)
  };

  const { data: closed, error } = await db
    .from('sessions')
    .update({ summary, finished_at: new Date().toISOString() })
    .eq('id', session_id)
    .is('finished_at', null) // 동시에 두 번 닫히지 않게
    .select('id');
  if (error) return json({ error: 'db_error', message: error.message }, 500);
  if (!closed?.length) {
    const { data: again } = await db.from('sessions').select('summary').eq('id', session_id).maybeSingle();
    return json({ summary: again?.summary ?? summary, already_finished: true });
  }

  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  await db.from('events').insert({ session_id, t, type: exitReason ? 'session_exited' : 'session_finished', data: {} }).then(() => {}, () => {});
  return json({ summary });
});
