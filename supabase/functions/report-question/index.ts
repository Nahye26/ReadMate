// POST /report-question
// 입력: { session_id, mission_idx, qtype, reason: 'weird' | 'unanswerable' | 'mismatch' | 'too_easy', note? }
//   weird:        "이 질문이 이상해요" (읽기 작업 화면)
//   unanswerable: "답할 수 없어요"  mismatch: "원문과 달라요"  too_easy: "너무 쉬워요" (피드백 화면)
// 학생이 질문 품질을 신고한다. 진행 상태(턴, 힌트, 보완)에는 영향이 없고 events에만 기록한다.
// 같은 미션에 여러 번 보낼 수 있다. 이미 보여 준 미션(현재 미션까지)에만 보낼 수 있다.
// note는 답변 저장에 동의한 세션만 저장한다(200자). 요약 로그의 question_reports에 미션별 사유로 모인다.
import { currentMission, REPORT_REASONS, QTYPES } from '../_shared/core.ts';
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
  const { session_id, mission_idx, qtype, reason } = body ?? {};
  if (typeof session_id !== 'string' || !Number.isInteger(mission_idx) || mission_idx < 0) {
    return json({ error: 'bad_request', message: 'session_id와 mission_idx가 필요합니다' }, 400);
  }
  if (!QTYPES.includes(qtype)) return json({ error: 'bad_request', message: 'qtype이 올바르지 않습니다' }, 400);
  if (!REPORT_REASONS.includes(reason)) return json({ error: 'bad_request', message: 'reason이 올바르지 않습니다' }, 400);
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : '';

  const db = serviceClient();
  const { data: ses } = await db
    .from('sessions').select('id, owner, consent_answers, started_at, finished_at').eq('id', session_id).maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ error: 'session_finished' }, 409);

  const [{ data: missions }, { data: turns }] = await Promise.all([
    db.from('missions').select('idx, variants').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const mission = (missions ?? []).find((m) => m.idx === mission_idx);
  if (!mission) return json({ error: 'not_found', message: '없는 미션입니다' }, 404);
  if (!(mission.variants as { qtype: string }[]).some((v) => v.qtype === qtype)) {
    return json({ error: 'bad_request', message: '이 미션에 없는 질문 유형입니다' }, 400);
  }
  const current = currentMission(turns ?? [], missions!.length);
  if (current !== null && mission_idx > current) return json({ error: 'not_shown', message: '아직 보여 주지 않은 미션입니다' }, 409);

  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  const { error } = await db.from('events').insert({
    session_id, t, type: 'question_report',
    data: { m: mission_idx + 1, qtype, reason, ...(ses.consent_answers && note ? { note } : {}) },
  });
  if (error) return json({ error: 'db_error', message: error.message }, 500);
  return json({ ok: true });
});
