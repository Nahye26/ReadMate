// ReadMate 서버 쪽 핵심 로직 (순수 함수, 런타임 의존 없음)
// index.html 데모(v0.4)의 로직을 클라이언트에서 서버로 옮긴 것이다. Edge Function과 Node 테스트에서 같이 쓴다.
// 이식 대상: split / buildChunks / resolve / validateQuote / isCopy / cleanPlan / fadeAfter / 보정 판정

export type Chunk = { id: string; sec: string; s: string[]; t: string };
export type Pick = [chunkId: string, from: number, to: number];
export type QType = 'literal' | 'inferential' | 'evaluative';
export type Condition = 'A' | 'B';

export const QTYPES: QType[] = ['literal', 'inferential', 'evaluative'];
export const JOL_VALUES = [0.125, 0.375, 0.625, 0.875]; // 회상 예측 선택지
export const CALIB_THRESHOLD = 0.25; // 예측 − 실제 기준
export const READING_TYPE: Record<Condition, string> = { A: '발췌형', B: '맥락형' };

export const CONFIG = {
  missions: 3,
  maxMissions: 4,
  exSent: 3, // 발췌형(조건 A): 미션당 최대 문장 수
  cxSent: 8, // 맥락형(조건 B): 미션당 최대 문장 수
  supStart: 2,
};

/* ---------- 청킹 ---------- */

export function splitSentences(t: string): string[] {
  return t.split(/(?<=[.!?。])\s+/).filter(Boolean);
}

export function buildChunks(text: string, sec: string, prefix: string): Chunk[] {
  const sentences = splitSentences(text.replace(/\s+/g, ' ').trim());
  const out: Chunk[] = [];
  let cur: string[] = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({ id: prefix + (out.length + 1), sec, s: cur, t: cur.join(' ') });
    cur = [];
    len = 0;
  };
  for (const s of sentences) {
    cur.push(s);
    len += s.length;
    if (cur.length >= 3 || len > 300) flush();
  }
  flush();
  return out;
}

/* ---------- 발췌 해석과 검증 ---------- */

export function resolvePick(byId: Record<string, Chunk>, [id, a, b]: Pick) {
  const c = byId[id];
  if (!c) throw new Error('unknown chunk_id ' + id);
  const ss = c.s.slice(a - 1, b);
  const ok = ss.length === b - a + 1 && ss.every((s) => c.t.includes(s));
  return { id: c.id, sec: c.sec, text: ss.join(' '), range: a === b ? `문장 ${a}` : `문장 ${a}–${b}`, ok };
}

export function validateQuote(byId: Record<string, Chunk>, id: string, quote: string) {
  const c = byId[id];
  if (!c) return { ok: false, reason: 'unknown chunk_id' };
  const n = (s: string) => s.replace(/\s+/g, '');
  return n(c.t).includes(n(quote)) ? { ok: true } : { ok: false, reason: 'quote not found in chunk' };
}

function bigrams(s: string): Set<string> {
  const x = s.replace(/[\s.,?!'"“”]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
  return out;
}

// 학생 답이 발췌 문장을 거의 그대로 옮긴 것인지(복붙) 감지한다.
export function isCopy(answer: string, excerpt: string): boolean {
  if (answer.replace(/\s/g, '').length < 12) return false;
  const a = bigrams(answer);
  const b = bigrams(excerpt);
  if (!a.size) return false;
  let hit = 0;
  a.forEach((x) => {
    if (b.has(x)) hit++;
  });
  return hit / a.size >= 0.85;
}

/* ---------- LLM이 만든 읽기 계획 검증 ---------- */

export type Variant = { qtype: QType; q: string; keys: string[]; cue: string; frame: string };
export type Mission = { req: number; mins: number; pick: Pick[]; vars: Variant[] };

// 조건 A는 발췌형(짧게), 조건 B는 맥락형(앞뒤 문단 포함)으로 문장 상한이 달라진다.
export function cleanPlan(
  data: any,
  candidates: Chunk[],
  condition: Condition,
  opts: { maxMissions?: number; charsPerMin?: number; answerMin?: number } = {},
) {
  const byId: Record<string, Chunk> = {};
  candidates.forEach((c) => (byId[c.id] = c));
  const reqs: string[] = (data?.reqs ?? []).map(String).filter(Boolean).slice(0, 4);
  if (!reqs.length) throw new Error('no reqs');

  const cap = condition === 'A' ? CONFIG.exSent : CONFIG.cxSent;
  const per = condition === 'A' ? CONFIG.exSent : 5;
  const missions: Mission[] = [];

  (data?.missions ?? []).slice(0, opts.maxMissions ?? CONFIG.maxMissions).forEach((m: any) => {
    const picks: Pick[] = [];
    let total = 0;
    (m.picks ?? []).slice(0, 3).forEach((p: any) => {
      const c = byId[p.chunk_id];
      if (!c) return;
      const a = Math.round(+p.from);
      let b = Math.round(+p.to);
      if (!(a >= 1 && b >= a && b <= c.s.length)) return;
      if (b - a + 1 > per) b = a + per - 1;
      if (total + (b - a + 1) > cap) return;
      total += b - a + 1;
      picks.push([c.id, a, b]);
    });

    const raw: any[] = Array.isArray(m.variants) && m.variants.length ? m.variants : m.question ? [m] : [];
    const seen = new Set<string>();
    const vars: Variant[] = [];
    raw.forEach((v) => {
      const qtype: QType = QTYPES.includes(v?.qtype) ? v.qtype : 'literal';
      if (!v?.question || seen.has(qtype)) return;
      seen.add(qtype);
      vars.push({
        qtype,
        q: String(v.question),
        keys: (Array.isArray(v.key_points) ? v.key_points : []).map(String).filter(Boolean).slice(0, 3),
        cue: String(v.cue ?? '').slice(0, 160),
        frame: String(v.frame ?? '').slice(0, 160),
      });
    });
    vars.sort((x, y) => QTYPES.indexOf(x.qtype) - QTYPES.indexOf(y.qtype));
    if (!picks.length || !vars.length) return;

    const chars = picks.reduce((n, p) => n + resolvePick(byId, p).text.length, 0);
    missions.push({
      req: Math.min(reqs.length, Math.max(1, Math.round(+m.req) || 1)),
      mins: Math.max(1, Math.ceil(chars / (opts.charsPerMin ?? 400))) + (opts.answerMin ?? 2),
      pick: picks,
      vars,
    });
  });

  if (!missions.length) throw new Error('no valid mission');
  return { reqs, missions, reason: String(data?.reason ?? '') };
}

/* ---------- 안내 수준(스캐폴딩 페이딩)과 질문 깊이 ---------- */

export type FlowOpts = {
  fade: boolean; // 안내 수준 페이딩
  adaptDepth: boolean; // 질문 깊이 적응
};

// 실험 모드(A/B 비교)에서는 둘 다 꺼서 문항 흐름을 같게 유지한다.
export const EXPERIMENT_FLOW: FlowOpts = { fade: false, adaptDepth: false };
export const DEFAULT_FLOW: FlowOpts = { fade: true, adaptDepth: true };

export function nextSupport(
  prev: { sup: number; depth: number },
  used: { hints: number; cueAsked: boolean },
  flow: FlowOpts = DEFAULT_FLOW,
  supStart = CONFIG.supStart,
) {
  let sup = prev.sup;
  let depth = prev.depth;
  const noHelp = used.hints === 0 && !used.cueAsked;
  if (flow.fade) {
    if (noHelp) {
      if (sup > 0) sup -= 1;
    } else if (used.hints >= 2) {
      if (sup < supStart) sup += 1;
    }
  }
  if (flow.adaptDepth) {
    if (noHelp) depth = Math.min(2, depth + 1);
    else if (used.hints >= 2) depth = Math.max(0, depth - 1);
  }
  return { sup, depth };
}

/* ---------- 회상 보정 ---------- */

export type Calibration = '과대' | '비슷' | '과소';

export function calibrate(prediction: number, actual: number): Calibration {
  const d = prediction - actual;
  return d > CALIB_THRESHOLD ? '과대' : d < -CALIB_THRESHOLD ? '과소' : '비슷';
}

/* ---------- 세션 요약 로그 (eval/ 의 v0.5 스키마) ---------- */

export type MissionRecord = {
  supportLevel: number; // 0~2
  qtype: QType;
  hintLevel: number; // 0~3
  unresolved: boolean;
  textUnits: number;
  contextSufficient: boolean;
  contextUsed: boolean;
  evidenceCited: boolean;
  activity: string;
  recalled: number; // 인출에서 떠올린 핵심 수
  recallTotal: number; // 핵심 전체 수
};

export type SessionInput = {
  model: string;
  condition: Condition;
  paperId: string;
  missions: MissionRecord[];
  recallPrediction: number;
  newInfoInRecall: boolean;
  selfCorrections: string[];
  readingLoad: number;
  exitReason: string | null;
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function summarize(i: SessionInput) {
  const total = i.missions.length;
  const unresolved = i.missions.flatMap((m, k) => (m.unresolved ? [k + 1] : []));
  const answered = i.missions.filter((m) => !m.unresolved);
  const recalled = i.missions.reduce((n, m) => n + m.recalled, 0);
  const recallTotal = i.missions.reduce((n, m) => n + m.recallTotal, 0);
  const actual = recallTotal ? r3(recalled / recallTotal) : 0;
  return {
    prompt_version: 'v0.5-chat',
    model: i.model,
    condition: i.condition,
    paper_id: i.paperId,
    reading_type: READING_TYPE[i.condition],
    support_path: i.missions.map((m) => m.supportLevel),
    text_units_provided: i.missions.map((m) => m.textUnits),
    missions_done: `${total - unresolved.length}/${total}`,
    missions_unresolved: unresolved,
    answered_without_hint: answered.filter((m) => m.hintLevel === 0).length,
    answered_with_hint: answered.filter((m) => m.hintLevel > 0).length,
    hint_level: i.missions.map((m) => m.hintLevel),
    question_path: i.missions.map((m) => m.qtype),
    context_sufficient: i.missions.map((m) => m.contextSufficient),
    context_used: i.missions.map((m) => m.contextUsed),
    evidence_cited: i.missions.map((m) => m.evidenceCited),
    activity_type: i.missions.map((m) => m.activity),
    recall_per_mission: i.missions.map((m) => `${m.recalled}/${m.recallTotal}`),
    new_info_in_recall: i.newInfoInRecall,
    recall_done: recallTotal > 0,
    recall_prediction: i.recallPrediction,
    recall_actual: actual,
    calibration: calibrate(i.recallPrediction, actual),
    calibration_gap: r3(i.recallPrediction - actual),
    self_corrections: i.selfCorrections,
    reading_load: i.readingLoad,
    exit_reason: i.exitReason,
  };
}
