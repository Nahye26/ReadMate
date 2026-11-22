// POST /recall
// 입력: { session_id, action: 'start' | 'predict' | 'submit' | 'skip', jol?, answer? }
// 모든 미션이 끝난 뒤 통과한 미션들의 내용을 통합해 확인한다(프롬프트 v0.5 2절). 순서는 start → predict → submit. skip은 어느 단계에서든 가능하다.
//   start:   인출 안내와 예측 선택지를 돌려준다. 원문 발췌는 돌려주지 않는다(화면에서 가리는 단계). 이미 시작했으면 지금 단계를 돌려준다.
//   predict: 예측 선택(0.125 / 0.375 / 0.625 / 0.875)을 기록한다. 쓰기 전에 받아야 하므로 submit보다 먼저여야 한다.
//   submit:  원문을 보지 않고 쓴 글을 미션별 핵심 요소와 견준다. 떠올린 핵심 수(미션별·전체), 실제 비율, 예측과의 차이(과대/비슷/과소)를 돌려준다.
//            빠진 핵심 문장은 돌려주지 않고, 원문을 다시 보여 주며 고쳐 쓰게 하지도 않는다. 한 번 쓰면 끝이다.
//   skip:    인출을 건너뛴다.
// 채점 범위는 통과한 미션의 key_points뿐이다. 조건 B의 앞뒤 청크는 쓰지 않는다(new_info_in_recall = false).
// 상태는 turns 기록에서 되살린다(core.ts recallState).
import {
  calibrate, currentMission, JOL_VALUES, missionState, parseRecalled, recallState, recallTargets, tallyRecall,
} from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildRecallPrompt } from '../_shared/prompts.ts';
import { basisPick, type Basis, type Pick, type QType } from '../_shared/core.ts';
import { loadWindow } from '../_shared/window.ts';

const MAX_ANSWER_CHARS = 3000;
const ACTIONS = ['start', 'predict', 'submit', 'skip'];
const JOL_LABEL: Record<number, string> = {
  0.125: '거의 못 떠올려요', 0.375: '일부만 떠올려요', 0.625: '대부분 떠올려요', 0.875: '거의 다 떠올려요',
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
    db.from('missions').select('idx, variants, picks, context_ids').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const history = turns ?? [];
  const total = missions?.length ?? 0;
  if (currentMission(history, total) !== null) return json({ error: 'missions_not_done', message: '미션을 모두 끝낸 뒤에 인출할 수 있습니다' }, 409);

  const state = recallState(history);
  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  const event = (type: string, data: Record<string, unknown>) =>
    db.from('events').insert({ session_id, t, type, data }).then(() => {}, () => {}); // 로그 실패는 진행을 막지 않는다
  const record = async (payload: Record<string, unknown>) => {
    const { error } = await db.from('turns').insert({ session_id, mission_idx: null, kind: 'recall', payload });
    return error ? json({ error: 'db_error', message: error.message }, 500) : null;
  };

  if (state.stage === 'answered' || state.stage === 'skipped') {
    return json({ error: 'recall_finished', stage: state.stage }, 409);
  }

  /* ---------- 건너뛰기 ---------- */
  if (action === 'skip') {
    const fail = await record({ stage: 'skip' });
    if (fail) return fail;
    await event('recall_skipped', {});
    return json({ action: 'skip', stage: 'skipped' });
  }

  // 인출 대상: 통과한 미션 전체와 그 미션에서 학생이 푼 질문 유형의 핵심 요소
  const targets = recallTargets(history, total);
  const { data: secrets } = await db.from('mission_secrets').select('idx, key_points').eq('session_id', session_id).in('idx', targets);
  const groups = targets.flatMap((idx) => {
    const qtype = missionState(history, idx).qtype as QType;
    const variants = missions!.find((m) => m.idx === idx)!.variants as { qtype: QType; question: string }[];
    const question = variants.find((v) => v.qtype === qtype)?.question;
    const keys = (secrets?.find((s) => s.idx === idx)?.key_points as Record<string, string[]> | undefined)?.[qtype] ?? [];
    return question && keys.length ? [{ m: idx, question, keys }] : [];
  });
  if (!groups.length) return json({ action, stage: 'unavailable', message: '통과한 미션의 핵심 요소가 없어 인출을 건너뜁니다' });

  /* ---------- 시작 ---------- */
  if (action === 'start') {
    if (state.stage === 'none') await event('recall_started', { missions: groups.map((g) => g.m + 1) });
    return json({
      action: 'start',
      stage: state.stage, // none: 예측 선택 / predicted: 쓰기
      missions: groups.map((g) => g.m),
      jol: state.jol,
      options: JOL_VALUES.map((v) => ({ value: v, label: JOL_LABEL[v] })),
    });
  }

  /* ---------- 예측 ---------- */
  if (action === 'predict') {
    if (state.stage !== 'none') return json({ error: 'wrong_stage', stage: state.stage }, 409);
    const fail = await record({ stage: 'predict', jol: body.jol });
    if (fail) return fail;
    await event('recall_prediction', { jol: body.jol });
    return json({ action: 'predict', stage: 'predicted' });
  }

  /* ---------- 기억해서 쓰기 ---------- */
  if (state.stage !== 'predicted' || state.jol === null) return json({ error: 'wrong_stage', stage: state.stage }, 409);

  // 미션마다 근거 범위의 텍스트를 가져온다(채점 보조용. 학생에게는 돌려주지 않는다).
  const basis = ((ses.config as { basis?: Basis } | null)?.basis) ?? 'excerpt';
  const items = [];
  for (const g of groups) {
    const mrow = missions!.find((m) => m.idx === g.m)!;
    if ((ses.config as { lazy?: boolean } | null)?.lazy) { // 질문이 읽은 글 전체를 근거로 하므로 채점 보조 텍스트도 읽은 글 전체다
      const loaded = await loadWindow(db, ses.source_id, (mrow.context_ids as string[]) ?? [(mrow.picks as Pick[])[0][0]]);
      if (!loaded) return json({ error: 'chunk_missing' }, 500);
      items.push({ question: g.question, keys: g.keys, core: { sentences: loaded.win.sentences, from: 1 } });
      continue;
    }
    const picked = (mrow.picks as Pick[])[0];
    const { data: row } = await db.from('chunks').select('sentences').eq('source_id', ses.source_id).eq('id', picked[0]).maybeSingle();
    if (!row) return json({ error: 'chunk_missing' }, 500);
    const s = row.sentences as string[];
    const pick = basisPick(basis, picked, s.length);
    items.push({ question: g.question, keys: g.keys, core: { sentences: s.slice(pick[1] - 1, pick[2]), from: pick[1] } });
  }

  const nKeys = groups.reduce((n, g) => n + g.keys.length, 0);
  let recalledNums: number[];
  try {
    const d = await askJson(buildRecallPrompt({ missions: items, answer }));
    recalledNums = parseRecalled(d?.recalled, nKeys);
  } catch (e) {
    // 판정이 없으면 기록하지 않는다. 학생은 같은 글을 다시 제출할 수 있다.
    const code = e instanceof LlmError ? e.code : 'llm_failed';
    return json({ error: code, message: (e as Error).message }, code === 'rate_limited' ? 429 : 502);
  }

  const tally = tallyRecall(groups.map((g) => ({ m: g.m, keys: g.keys.length })), recalledNums);
  const actual = r3(tally.recalled / tally.total);
  const calibration = calibrate(state.jol, actual);
  const fail = await record({
    stage: 'answer', ...tally, actual, len: answer.length,
    ...(ses.consent_answers ? { answer } : {}), // 답변 원문은 동의한 경우에만 저장한다
  });
  if (fail) return fail;
  await event('recall_calibration', { jol: state.jol, actual, calib: calibration });

  return json({
    action: 'submit',
    stage: 'answered',
    recalled: tally.recalled,
    total: tally.total,
    per_mission: tally.per,
    prediction: state.jol,
    prediction_label: JOL_LABEL[state.jol],
    actual,
    calibration,
    calibration_gap: r3(state.jol - actual),
  });
});
