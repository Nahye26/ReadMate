// POST /recall
// 입력: { session_id, action: 'start' | 'predict' | 'submit' | 'fix' | 'skip', jol?, answer?, changed? }
// 모든 미션이 끝난 뒤(통과 또는 미해결) 한 미션을 골라 인출을 확인한다. 순서는 start → predict → submit → fix. skip은 어느 단계에서든 가능하다.
//   start:   인출할 미션과 질문, 예측 선택지를 돌려준다. 원문 발췌는 돌려주지 않는다(화면에서 가리는 단계). 이미 시작했으면 지금 단계를 돌려준다.
//   predict: 예측 선택(0.125 / 0.375 / 0.625 / 0.875)을 기록한다. 쓰기 전에 받아야 하므로 submit보다 먼저여야 한다.
//   submit:  원문을 보지 않고 쓴 글을 핵심 요소와 견준다. 떠올린 핵심 수, 빠진 핵심, 예측 비교(과대/비슷/과소), 원문 발췌를 돌려준다.
//   fix:     원문과 비교해 고쳐 쓴 결과(answer). 답변 저장에 동의했으면 서버가 처음 글과 직접 비교해 changed를 정하고, 동의가 없으면 클라이언트가 보낸 changed를 쓴다. changed면 self_correction으로 센다.
//   skip:    인출을 건너뛴다.
// 채점 범위는 핵심 발췌의 key_points뿐이다. 조건 B의 앞뒤 청크는 쓰지 않는다(프롬프트 v0.5 1-7, new_info_in_recall = false).
// 상태는 turns 기록에서 되살린다(core.ts recallState).
import {
  basisPick, calibrate, currentMission, JOL_VALUES, missionState, parseRecalled, pickRecallMission, recallState, resolvePick,
  type Basis, type Chunk, type Pick, type QType,
} from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildRecallPrompt } from '../_shared/prompts.ts';

const MAX_ANSWER_CHARS = 2000;
const ACTIONS = ['start', 'predict', 'submit', 'fix', 'skip'];
const JOL_LABEL: Record<number, string> = {
  0.125: '거의 못 쓸 것 같아요', 0.375: '절반쯤 쓸 것 같아요', 0.625: '대부분 쓸 것 같아요', 0.875: '거의 다 쓸 것 같아요',
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
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
  const { session_id, action } = body ?? {};
  if (typeof session_id !== 'string') return json({ error: 'bad_request', message: 'session_id가 필요합니다' }, 400);
  if (!ACTIONS.includes(action)) return json({ error: 'bad_request', message: 'action이 올바르지 않습니다' }, 400);
  const answer = str(body?.answer, MAX_ANSWER_CHARS + 1);
  if (action === 'submit' && (!answer || answer.length > MAX_ANSWER_CHARS)) {
    return json({ error: 'bad_request', message: `answer는 1~${MAX_ANSWER_CHARS}자여야 합니다` }, 400);
  }
  if (action === 'predict' && !JOL_VALUES.includes(body?.jol)) {
    return json({ error: 'bad_request', message: `jol은 ${JOL_VALUES.join(' / ')} 중 하나여야 합니다` }, 400);
  }
  if (action === 'fix' && typeof body?.changed !== 'boolean' && !answer) {
    return json({ error: 'bad_request', message: 'changed(true/false) 또는 고쳐 쓴 answer가 필요합니다' }, 400);
  }

  const db = serviceClient();

  const { data: ses } = await db
    .from('sessions')
    .select('id, owner, source_id, consent_answers, started_at, finished_at, config')
    .eq('id', session_id)
    .maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ error: 'session_finished' }, 409);
  if (!ses.source_id) return json({ error: 'source_missing', message: '세션의 읽기 자료가 삭제되었습니다' }, 500);

  const [{ data: missions }, { data: turns }] = await Promise.all([
    db.from('missions').select('idx, variants, picks').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const history = turns ?? [];
  const total = missions?.length ?? 0;
  if (currentMission(history, total) !== null) return json({ error: 'missions_not_done', message: '미션을 모두 끝낸 뒤에 인출할 수 있습니다' }, 409);

  const state = recallState(history);
  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  const event = (type: string, data: Record<string, unknown>) =>
    db.from('events').insert({ session_id, t, type, data }).then(() => {}, () => {}); // 로그 실패는 진행을 막지 않는다
  const record = async (kind: 'recall' | 'fix', mission_idx: number | null, payload: Record<string, unknown>) => {
    const { error } = await db.from('turns').insert({ session_id, mission_idx, kind, payload });
    return error ? json({ error: 'db_error', message: error.message }, 500) : null;
  };

  if (state.stage === 'done' || state.stage === 'skipped') {
    return json({ error: 'recall_finished', stage: state.stage }, 409);
  }

  /* ---------- 건너뛰기 ---------- */
  if (action === 'skip') {
    const fail = await record('recall', state.m, { stage: 'skip' });
    if (fail) return fail;
    await event('recall_skipped', {});
    return json({ action: 'skip', stage: 'skipped' });
  }

  // 인출 대상 미션. 시작한 뒤에는 기록에 남은 번호를 쓰고, 처음에는 규칙으로 고른다.
  const target = state.m ?? pickRecallMission(history, total);
  if (target === null) return json({ action, stage: 'unavailable', message: '통과한 미션이 없어 인출을 건너뜁니다' });
  const mission = missions!.find((m) => m.idx === target)!;
  const qtype = missionState(history, target).qtype as QType;
  const variant = (mission.variants as { qtype: QType; question: string }[]).find((v) => v.qtype === qtype);
  const { data: secret } = await db
    .from('mission_secrets').select('key_points').eq('session_id', session_id).eq('idx', target).maybeSingle();
  const keys: string[] = (secret?.key_points as Record<string, string[]> | undefined)?.[qtype] ?? [];
  if (!variant || !keys.length) return json({ action, stage: 'unavailable', message: '핵심 요소가 없어 인출을 건너뜁니다' });

  /* ---------- 시작 ---------- */
  if (action === 'start') {
    if (state.stage === 'none') await event('recall_started', { m: target + 1 });
    return json({
      action: 'start',
      stage: state.stage, // none: 예측 선택 / predicted: 쓰기 / answered: 원문 비교 후 고쳐 쓰기
      mission_idx: target,
      question: variant.question,
      jol: state.jol,
      options: JOL_VALUES.map((v) => ({ value: v, label: JOL_LABEL[v] })),
    });
  }

  /* ---------- 예측 ---------- */
  if (action === 'predict') {
    if (state.stage !== 'none') return json({ error: 'wrong_stage', stage: state.stage }, 409);
    const fail = await record('recall', target, { stage: 'predict', m: target, qtype, jol: body.jol });
    if (fail) return fail;
    await event('recall_prediction', { jol: body.jol });
    return json({ action: 'predict', stage: 'predicted', mission_idx: target, question: variant.question });
  }

  /* ---------- 기억해서 쓰기 ---------- */
  if (action === 'submit') {
    if (state.stage !== 'predicted' || state.jol === null) return json({ error: 'wrong_stage', stage: state.stage }, 409);

    const basis = ((ses.config as { basis?: Basis } | null)?.basis) ?? 'excerpt';
    const picked = (mission.picks as Pick[])[0];
    const { data: row } = await db
      .from('chunks').select('id, sec, sentences').eq('source_id', ses.source_id).eq('id', picked[0]).maybeSingle();
    if (!row) return json({ error: 'chunk_missing' }, 500);
    const core: Chunk = { id: row.id, sec: row.sec, s: row.sentences as string[], t: (row.sentences as string[]).join(' ') };
    const pick = basisPick(basis, picked, core.s.length);
    const view = { sentences: core.s.slice(pick[1] - 1, pick[2]), from: pick[1] };

    let recalled: number[];
    let comment = '';
    try {
      const d = await askJson(buildRecallPrompt({ question: variant.question, keys, core: view, answer }));
      recalled = parseRecalled(d?.recalled, keys.length);
      comment = str(d?.comment, 300);
    } catch (e) {
      // 판정이 없으면 기록하지 않는다. 학생은 같은 글을 다시 제출할 수 있다.
      const code = e instanceof LlmError ? e.code : 'llm_failed';
      return json({ error: code, message: (e as Error).message }, code === 'rate_limited' ? 429 : 502);
    }

    const actual = r3(recalled.length / keys.length);
    const calibration = calibrate(state.jol, actual);
    const gap = r3(state.jol - actual);
    const fail = await record('recall', target, {
      stage: 'answer', m: target, qtype, recalled, total: keys.length, actual, len: answer.length,
      ...(ses.consent_answers ? { answer } : {}), // 답변 원문은 동의한 경우에만 저장한다
    });
    if (fail) return fail;
    await event('recall_calibration', { jol: state.jol, actual, calib: calibration });

    const r = resolvePick({ [core.id]: core }, pick);
    return json({
      action: 'submit',
      stage: 'answered',
      recalled: recalled.length,
      total: keys.length,
      missing: keys.filter((_, i) => !recalled.includes(i + 1)), // 빠진 핵심은 서버가 원래 문장으로 돌려준다
      comment,
      prediction: state.jol,
      prediction_label: JOL_LABEL[state.jol],
      actual,
      calibration,
      calibration_gap: gap,
      source: { location: `${r.sec} · ${r.id} · ${r.range}`, text: view.sentences.join(' ') }, // 이제 원문을 다시 보여 준다
    });
  }

  /* ---------- 원문과 비교해 고쳐 쓰기 ---------- */
  if (state.stage !== 'answered') return json({ error: 'wrong_stage', stage: state.stage }, 409);
  // 답변 저장에 동의했으면 처음에 쓴 글이 기록에 있으므로 서버가 직접 비교한다. 동의가 없으면 클라이언트가 알려 준 값을 쓴다.
  const before = history.find((h) => h.kind === 'recall' && h.payload?.stage === 'answer')?.payload?.answer;
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  const changed = typeof before === 'string' && answer ? norm(before) !== norm(answer) : body.changed === true;
  const fail = await record('fix', target, {
    recall: true, m: target, changed, len: answer.length,
    ...(ses.consent_answers && answer ? { answer } : {}),
  });
  if (fail) return fail;
  if (changed) await event('self_correction', { recall: true });
  return json({ action: 'fix', stage: 'done', self_correction: changed });
});
