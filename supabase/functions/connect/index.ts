// POST /connect
// 입력: { session_id, action: 'start' | 'submit' | 'skip', connection? }
// 선택 단계(프롬프트 v0.5 3절). 인출이 끝났거나 건너뛴 뒤에, 통과한 미션이 2개 이상일 때만 제안한다.
//   start:  제안할 수 있으면 질문과 이어 볼 미션 목록을 돌려준다. 제안할 수 없으면 stage 'unavailable'.
//   submit: 학생이 쓴 연결(1500자)을 기록하고, 근거를 원문에서 다시 찾아보게 묻는 짧은 코멘트를 돌려준다. 연결 문장을 대신 쓰지 않는다.
//   skip:   건너뛴다. 이 단계는 세션 종료의 조건이 아니다.
// 연결 글 원문은 답변 저장에 동의한 세션만 저장한다.
import { connectState, CONNECT_MIN_MISSIONS, currentMission, missionState, recallState, recallTargets, QTYPES } from '../_shared/core.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { askJson, LlmError } from '../_shared/llm.ts';
import { buildConnectPrompt } from '../_shared/prompts.ts';

const MAX_CHARS = 1500;
const QUESTION = '앞에서 읽은 개념과 사례를 과제에서 어떻게 이어 볼 수 있을까요?';
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
  if (!['start', 'submit', 'skip'].includes(action)) return json({ error: 'bad_request', message: 'action이 올바르지 않습니다' }, 400);
  const connection = str(body?.connection, MAX_CHARS + 1);
  if (action === 'submit' && (!connection || connection.length > MAX_CHARS)) {
    return json({ error: 'bad_request', message: `connection은 1~${MAX_CHARS}자여야 합니다` }, 400);
  }

  const db = serviceClient();
  const { data: ses } = await db
    .from('sessions').select('id, owner, consent_answers, started_at, finished_at, config').eq('id', session_id).maybeSingle();
  if (!ses || ses.owner !== user.id) return json({ error: 'not_found' }, 404);
  if (ses.finished_at) return json({ error: 'session_finished' }, 409);

  const [{ data: missions }, { data: turns }] = await Promise.all([
    db.from('missions').select('idx, req, variants').eq('session_id', session_id).order('idx'),
    db.from('turns').select('mission_idx, kind, payload').eq('session_id', session_id).order('id'),
  ]);
  const history = turns ?? [];
  const total = missions?.length ?? 0;
  if (currentMission(history, total) !== null) return json({ error: 'missions_not_done' }, 409);

  const targets = recallTargets(history, total);
  const rs = recallState(history).stage;
  if (targets.length && rs !== 'answered' && rs !== 'skipped') return json({ error: 'recall_pending', stage: rs }, 409);
  const stage = connectState(history);
  if (stage !== 'none') return json({ error: 'connect_finished', stage }, 409);

  const t = Math.round(((Date.now() - new Date(ses.started_at).getTime()) / 1000) * 10) / 10;
  const event = (type: string) => db.from('events').insert({ session_id, t, type, data: {} }).then(() => {}, () => {});
  const record = async (payload: Record<string, unknown>) => {
    const { error } = await db.from('turns').insert({ session_id, mission_idx: null, kind: 'connect', payload });
    return error ? json({ error: 'db_error', message: error.message }, 500) : null;
  };

  if (action === 'skip') {
    const fail = await record({ stage: 'skip' });
    if (fail) return fail;
    await event('connect_skipped');
    return json({ action: 'skip', stage: 'skipped' });
  }

  const reqs = (ses.config as { reqs?: string[] } | null)?.reqs ?? [];
  const list = targets.map((idx) => {
    const m = missions!.find((x) => x.idx === idx)!;
    const qtype = missionState(history, idx).qtype;
    const question = (m.variants as { qtype: string; question: string }[]).find((v) => v.qtype === qtype && QTYPES.includes(v.qtype as never))?.question ?? '';
    return { n: idx + 1, req: reqs[m.req - 1] ?? '', question };
  });
  if (list.length < CONNECT_MIN_MISSIONS) return json({ action, stage: 'unavailable', message: '이어 볼 미션이 부족해 건너뜁니다' });

  if (action === 'start') {
    await event('connect_offered');
    return json({ action: 'start', stage: 'none', question: QUESTION, missions: list.map((x) => ({ mission: x.n, req: x.req })), optional: true });
  }

  let comment = '';
  try {
    const d = await askJson(buildConnectPrompt({ missions: list, connection }));
    comment = str(d?.comment, 400);
  } catch (e) {
    const code = e instanceof LlmError ? e.code : 'llm_failed';
    return json({ error: code, message: (e as Error).message }, code === 'rate_limited' ? 429 : 502); // 기록하지 않았으니 다시 낼 수 있다
  }
  const fail = await record({ stage: 'answer', len: connection.length, ...(ses.consent_answers ? { connection } : {}) });
  if (fail) return fail;
  await event('connect_submitted');
  return json({ action: 'submit', stage: 'answered', comment });
});
