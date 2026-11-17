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

// 분량 상한의 단위는 청크다 (2026-11-17 확정, docs/DESIGN.md 6절).
//   A = 핵심 청크 안 1~coreSent문장
//   B = 핵심 청크 + 앞 ctxBefore개 + 뒤 ctxAfter개 (최대 MAX_TEXT_UNITS개 청크)
export const CONFIG = {
  missions: 3,
  maxMissions: 4,
  coreSent: 3, // 조건 A: 미션당 핵심 청크 안 최대 문장 수
  ctxBefore: 1, // 조건 B: 핵심 청크 앞에 붙이는 청크 수
  ctxAfter: 1, // 조건 B: 핵심 청크 뒤에 붙이는 청크 수
  supStart: 2,
};
export const MAX_TEXT_UNITS = 1 + CONFIG.ctxBefore + CONFIG.ctxAfter; // 미션당 제공 청크 수 상한 (조건 B 기준 3)

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
// 질문 세트의 미션. 조건과 무관하게 A 기준(핵심 청크 하나 안의 1~3문장)으로만 만든다.
export type Mission = { req: number; pick: Pick; vars: Variant[] };
export type PlanData = { reqs: string[]; missions: Mission[] };

// LLM이 만든 읽기 계획을 A 기준으로 검증한다. 조건 B는 이 계획에 앞뒤 청크만 더한다(contextIds).
// 미션마다 핵심 발췌는 한 청크 안의 1~CONFIG.coreSent문장이다. 첫 번째로 유효한 pick만 쓴다.
export function cleanPlan(data: any, candidates: Chunk[], opts: { maxMissions?: number } = {}): PlanData {
  const byId: Record<string, Chunk> = {};
  candidates.forEach((c) => (byId[c.id] = c));
  const reqs: string[] = (data?.reqs ?? []).map(String).filter(Boolean).slice(0, 4);
  if (!reqs.length) throw new Error('no reqs');

  const missions: Mission[] = [];

  (data?.missions ?? []).slice(0, opts.maxMissions ?? CONFIG.maxMissions).forEach((m: any) => {
    let pick: Pick | null = null;
    for (const p of m.picks ?? []) {
      const c = byId[p?.chunk_id];
      if (!c) continue;
      const a = Math.round(+p.from);
      let b = Math.round(+p.to);
      if (!(a >= 1 && b >= a && b <= c.s.length)) continue;
      if (b - a + 1 > CONFIG.coreSent) b = a + CONFIG.coreSent - 1;
      pick = [c.id, a, b];
      break;
    }

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
    if (!pick || !vars.length) return;

    missions.push({
      req: Math.min(reqs.length, Math.max(1, Math.round(+m.req) || 1)),
      pick,
      vars,
    });
  });

  if (!missions.length) throw new Error('no valid mission');
  return { reqs, missions };
}

/* ---------- 조건 B: 계획에 앞뒤 청크만 더한다 ---------- */

export type ChunkRef = { id: string; idx: number; sec: string };

// 핵심 청크의 앞 before개·뒤 after개를 같은 절(sec) 안에서만 붙인다. 순서는 [앞…, 핵심, 뒤…].
// 절 경계를 넘는 청크는 이어지는 논리 단위가 아니므로 붙이지 않는다(절의 첫·끝 청크는 한쪽만 붙는다).
export function contextIds(
  core: ChunkRef,
  pool: ChunkRef[],
  before = CONFIG.ctxBefore,
  after = CONFIG.ctxAfter,
): string[] {
  const at = new Map(pool.filter((c) => c.sec === core.sec).map((c) => [c.idx, c.id]));
  const ids: string[] = [];
  for (let k = before; k >= 1; k--) {
    const id = at.get(core.idx - k);
    if (id) ids.push(id);
  }
  ids.push(core.id);
  for (let k = 1; k <= after; k++) {
    const id = at.get(core.idx + k);
    if (id) ids.push(id);
  }
  return ids;
}

export type Excerpt = {
  id: string;
  sec: string;
  text: string;
  range: string;
  ok: boolean;
  role: 'before' | 'core' | 'after';
  focus?: [from: number, to: number]; // 조건 B의 핵심 청크 안에서 A가 보여 주는 문장 범위
};

// 학생에게 보여 줄 발췌. 조건 A는 핵심 문장만, 조건 B는 ctx(앞·핵심·뒤 청크)를 청크 전체로 보여 준다.
export function resolveExcerpts(byId: Record<string, Chunk>, pick: Pick, condition: Condition, ctx: string[]): Excerpt[] {
  if (condition === 'A') return [{ ...resolvePick(byId, pick), role: 'core' }];
  const coreAt = ctx.indexOf(pick[0]);
  if (coreAt < 0) throw new Error('context must include the core chunk');
  return ctx.map((id, k) => {
    const c = byId[id];
    if (!c) throw new Error('unknown chunk_id ' + id);
    const full = resolvePick(byId, [id, 1, c.s.length]);
    const role = k < coreAt ? 'before' : k > coreAt ? 'after' : 'core';
    return role === 'core' ? { ...full, role, focus: [pick[1], pick[2]] as [number, number] } : { ...full, role };
  });
}

// 읽기 시간 추정(분): 글자 수 기준 읽기 + 답하기.
export function estimateMins(chars: number, charsPerMin = 400, answerMin = 2): number {
  return Math.max(1, Math.ceil(chars / charsPerMin)) + answerMin;
}

// 과제 안내문을 질문 세트의 키로 쓰기 위해 공백만 정리한다.
export const normalizeAssignment = (s: string) => s.replace(/\s+/g, ' ').trim();

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
