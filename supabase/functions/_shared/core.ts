// ReadMate 서버 쪽 핵심 로직 (순수 함수, 런타임 의존 없음)
// index.html 데모(v0.4)의 로직을 클라이언트에서 서버로 옮긴 것이다. Edge Function과 Node 테스트에서 같이 쓴다.
// 이식 대상: split / buildChunks / resolve / validateQuote / isCopy / cleanPlan / fadeAfter / 보정 판정

// heads: 제목인 문장의 번호(1부터). 제목은 독립 문장이지만 핵심 발췌와 질문 대상에서는 빼고, 화면에서 굵게 보여 준다.
export type Chunk = { id: string; sec: string; s: string[]; t: string; heads?: number[] };
export type Pick = [chunkId: string, from: number, to: number];
// 질문·판정·힌트·인출이 근거로 삼는 범위. excerpt: 고른 1~3문장만(A 기준, 효과성 검증). chunk: 고른 문장이 속한 핵심 청크 전체(조건 B, 사용성 테스트).
// 앞뒤 청크는 어느 쪽이든 근거 범위가 아니다(context_used 판단에만 쓴다).
export type Basis = 'excerpt' | 'chunk';
export const basisPick = (basis: Basis | undefined, pick: Pick, len: number): Pick => (basis === 'chunk' ? [pick[0], 1, len] : pick);
// 사용성 테스트(실험 모드가 아니고 조건 B)만 청크 전체를 근거로 삼는다. 효과성 검증은 A/B가 같은 세트와 같은 기준을 써야 한다.
export const basisFor = (experiment: boolean, condition: Condition): Basis => (!experiment && condition === 'B' ? 'chunk' : 'excerpt');
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
  missions: 6, // 한 세션은 최소 30분(minMins)이 되도록 구성한다. 미션당 약 5분(조건 B) × 6 + 인출·연결 (2026-11-18)
  minMissions: 3, // 마무리(인출·예측·연결)를 뺀 미션 최소 개수. 요구 항목이 적어도 3개 미만으로 내보내지 않는다
  maxMissions: 6, // 전체 상한. 소요 시간(미션당 약 5분)과 LLM 호출(미션당 약 2~2.5회)이 함께 늘어난다
  minMins: 30, // 세션 소요 시간 하한(분). plan-session이 추정치를 응답에 담아 미달 여부를 알린다
  recallMins: 5, // 모든 미션 뒤 인출·예측·연결에 드는 시간 추정(분)
  perReqMax: 3, // 요구 항목 하나에 붙일 수 있는 미션 상한(항목이 2개여도 6개를 채울 수 있게). 같은 항목의 미션은 서로 다른 핵심 청크여야 한다
  topK: 24, // 과제 안내문 전체와 가까운 후보 청크 수(요구 항목을 뽑지 못했을 때의 대체 경로)
  perReqK: 8, // 요구 항목마다 가까운 후보 청크 수(요구 항목을 뽑았을 때)
  coreSent: 3, // 조건 A: 미션당 핵심 청크 안 최대 문장 수
  ctxBefore: 1, // 조건 B: 핵심 청크 앞에 붙이는 청크 수
  ctxAfter: 1, // 조건 B: 핵심 청크 뒤에 붙이는 청크 수
  supStart: 2,
  lastMinDepth: 1, // 마지막 미션은 최소 추론(1) 깊이로 올린다(적응 모드)
};
export const MAX_TEXT_UNITS = 1 + CONFIG.ctxBefore + CONFIG.ctxAfter; // 미션당 제공 청크 수 상한 (조건 B 기준 3)

/* ---------- 청킹 ---------- */

// 문장은 온점(. ! ? 。) 뒤 공백에서만 자른다(2026-11-22 확정). 쉼표는 기준이 아니고 한 문장의 글자 수도 보지 않는다.
// 자르지 않는 경우:
//   1) 괄호·따옴표가 열려 있는 동안: "다섯 가지(1. 비용 2. 시간)", "(김철수 외. 2021)". 짝이 안 맞아 문서 끝까지 열려 버리는 일을 막으려고
//      열린 지 OPEN_SPAN_MAX자가 지나면 짝이 없는 것으로 보고 닫는다(글자 수로 문장을 가르는 기준이 아니라 안전장치다).
//   2) 영문 약어 뒤(et al. / Fig. / pp. / vs. …)와 이니셜 뒤("J. H. Smith")
//   3) 문장 맨 앞의 번호 토큰 뒤("II." "3." "가."): 제목 번호는 뒤 글과 붙여 둔다. 제목은 PDF 쪽에서 굵기·크기로 따로 표시한다(HEAD_OPEN/HEAD_CLOSE).
const OPEN_CH = '([{（［〔〈《「『“‘';
const CLOSE_CH = ')]}）］〕〉》」』”’';
const OPEN_SPAN_MAX = 400;
const ABBR = new Set(['fig', 'figs', 'eq', 'eqs', 'no', 'nos', 'vs', 'pp', 'p', 'vol', 'vols', 'ed', 'eds', 'dr', 'prof', 'mr', 'mrs', 'ms', 'cf', 'e.g', 'i.e', 'ca', 'approx', 'jr', 'sr', 'st', 'inc', 'ltd', 'co', 'univ', 'ch', 'sec']);
const NUM_TOKEN = /^(?:[IVXivx]{1,5}|\d{1,3}|[가나다라마바사아자차카타파하])\.$/;

export const HEAD_OPEN = '\uE000'; // 쪽 텍스트 안에서 제목을 감싸는 표시(사설 영역 문자). 서버가 읽고 지운다.
export const HEAD_CLOSE = '\uE001';
export const JOIN_MARK = '\uE002'; // 쪽 텍스트 맨 앞에 있으면 앞 쪽과 공백 없이 이어 붙인다(쪽 경계에서 어절이 끊긴 경우). web/pdfclean.mjs의 JOIN과 같은 값이다.
const MARKS = /[\uE000-\uE002]/g;

export function splitSentences(t: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let openedAt = 0;
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (OPEN_CH.includes(c)) {
      if (depth === 0) openedAt = i;
      depth++;
    } else if (CLOSE_CH.includes(c) && depth > 0) depth--;
    if (depth > 0 && i - openedAt > OPEN_SPAN_MAX) depth = 0;
    if (!/\s/.test(c) || (i > 0 && /\s/.test(t[i - 1]))) continue; // 공백 덩어리의 첫 칸에서만 본다
    let j = i - 1;
    while (j >= start && CLOSE_CH.includes(t[j])) j--;
    const term = t[j];
    if (depth > 0 || j < start || !'.!?。'.includes(term ?? '')) continue;
    if (term === '.') {
      const tok = t.slice(start, j + 1).split(/\s+/).pop()!.replace(/^[(\[{“‘"']+/, '');
      const word = tok.slice(0, -1);
      const rest = t.slice(i).trimStart();
      const next = rest[0] ?? '';
      if (NUM_TOKEN.test(t.slice(start, j + 1).trim().replace(/^[\uE000\uE001]+/, ''))) continue; // 문장 맨 앞 번호
      const lower = word.toLowerCase();
      if (lower === 'al') {
        if (/[a-z(\d]/.test(next)) continue; // et al. suggested / et al. (2014)
      } else if (ABBR.has(lower)) continue;
      else if (/^[A-Za-z]$/.test(word) && /[A-Z]/.test(next)) continue; // 이니셜: J. H. Smith
      else if (/^[A-Za-z]{2,}$/.test(word) && /[a-z]/.test(next)) continue; // 영어 단어 뒤 소문자: 약어로 본다
    }
    out.push(t.slice(start, i).trim());
    start = i + 1;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

// 괄호·따옴표가 열린 채 끝나는지(짝이 안 맞는 꼬리인지) 본다.
export function bracketDepth(t: string): number {
  let depth = 0;
  for (const c of t) {
    if (OPEN_CH.includes(c)) depth++;
    else if (CLOSE_CH.includes(c) && depth > 0) depth--;
  }
  return depth;
}

// 제목 표시(HEAD_OPEN…HEAD_CLOSE)가 있는 글을 문장 목록으로 만든다. 제목은 앞뒤 본문과 한 문장으로 합쳐지지 않는 독립 문장이다.
export function splitWithHeads(text: string): { t: string; head: boolean }[] {
  const out: { t: string; head: boolean }[] = [];
  const re = new RegExp(`${HEAD_OPEN}([^${HEAD_CLOSE}]*)${HEAD_CLOSE}`, 'g');
  let pos = 0;
  const body = (x: string) => splitSentences(x.replace(MARKS, '')).forEach((t) => out.push({ t, head: false }));
  for (const m of text.matchAll(re)) {
    body(text.slice(pos, m.index));
    const h = m[1].replace(/\s+/g, ' ').trim();
    if (h) out.push({ t: h, head: true });
    pos = m.index! + m[0].length;
  }
  body(text.slice(pos));
  return out;
}

// carry를 다음 배치 첫 섹션 맨 앞에 붙인다. 그 섹션이 JOIN_MARK로 시작하면 공백 없이 붙인다.
export function prependCarry(carry: string, text: string): string {
  if (!carry) return text;
  return text.startsWith(JOIN_MARK) ? carry + text.slice(1) : carry + ' ' + text;
}

// 업로드 배치 경계에서 문장이 끊기지 않게, 마지막 문장이 끝나지 않았으면(마침표가 없거나 괄호가 열린 채) 떼어 carry로 돌려준다.
// 클라이언트가 carry를 다음 배치 맨 앞에 붙여 보낸다("(김철수," 와 "2021)에서…"가 갈라지는 일을 막는다). 꼬리가 maxCarry보다 길면 떼지 않는다.
export function withholdTail(sections: { sec: string; text: string }[], maxCarry = 1500): { sections: { sec: string; text: string }[]; carry: string } {
  if (!sections.length) return { sections, carry: '' };
  const last = sections[sections.length - 1];
  const text = last.text.replace(/\s+$/, '');
  const cut = text.lastIndexOf(HEAD_CLOSE) + 1; // 제목 표시 뒤쪽만 본다
  const area = text.slice(cut);
  const parts = splitSentences(area);
  const tail = parts[parts.length - 1] ?? '';
  const complete = /[.!?。][)\]}）］〕〉》」』”’]*$/.test(tail) && bracketDepth(tail) === 0;
  if (!tail || complete || tail.length > maxCarry || parts.length === 0) return { sections, carry: '' };
  const body = text.slice(0, cut + area.lastIndexOf(tail)).trimEnd();
  return { sections: body ? [...sections.slice(0, -1), { sec: last.sec, text: body }] : sections.slice(0, -1), carry: tail };
}

// 청크 크기 (2026-11-18): 한국어 학술문은 3문장·300자 단위로 자르면 청크가 평균 160자로 너무 짧아(조건 B 발췌 약 490자) 읽기가 부족했다.
// 문장 수와 글자 수 둘 중 먼저 닿는 쪽에서 끊되, 짧은 조각은 이웃에 합친다. 글자 수 자체에 선행연구 근거는 없고 파일럿으로 조정하는 값이다.
export const CHUNK_CONFIG = {
  minSent: 5, // 한 청크의 문장 수 하한(자료 전체가 이보다 짧은 경우만 예외)
  maxSent: 10, // 한 청크의 문장 수 상한
  targetChars: 700, // 문장 수가 하한 이상일 때 이 글자 수에 닿으면 끊는다
  minChars: 400, // 이보다 짧은 청크는 이웃과 합친다
  // 글자 수 상한은 두지 않는다(문장 수 상한만 둔다).
};

// 쪽번호·구분선·한두 글자 조각처럼 읽을 내용이 없는 문장
export const isNoiseSentence = (s: string) => s.trim().length < 3 || /^[\d\s.,\-–—~·|━─=*]+$/.test(s.trim()) || NUM_TOKEN.test(s.trim());

type Sent = { t: string; page?: number; head?: boolean };

function packSentences(sents: Sent[], sec: (first: Sent, last: Sent) => string, prefix: string): Chunk[] {
  const { minSent, maxSent, targetChars, minChars } = CHUNK_CONFIG;
  const size = (g: Sent[]) => g.reduce((n, x) => n + x.t.length, 0);
  const short = (g: Sent[]) => g.length < minSent || size(g) < minChars;
  const groups: Sent[][] = [];
  let cur: Sent[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length) groups.push(cur);
    cur = [];
    len = 0;
  };
  for (const x of sents) {
    cur.push(x);
    len += x.t.length;
    if (cur.length >= maxSent || (len >= targetChars && cur.length >= minSent)) flush();
  }
  flush();
  // 짧은 조각(특히 쪽·자료 끝의 꼬리)은 이웃과 합친다. 합쳐서 문장 수 상한을 넘으면 반씩 나눠 두 청크 모두 하한을 지킨다.
  const join = (a: Sent[], b: Sent[]): Sent[][] => {
    const all = [...a, ...b];
    if (all.length <= maxSent) return [all];
    const h = Math.ceil(all.length / 2);
    return [all.slice(0, h), all.slice(h)];
  };
  const merged: Sent[][] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && short(g)) merged.splice(merged.length - 1, 1, ...join(prev, g));
    else merged.push(g);
  }
  if (merged.length > 1 && short(merged[0])) merged.splice(0, 2, ...join(merged[0], merged[1]));
  return merged.map((g, i) => {
    const heads = g.flatMap((x, k) => (x.head ? [k + 1] : []));
    return { id: prefix + (i + 1), sec: sec(g[0], g[g.length - 1]), s: g.map((x) => x.t), t: g.map((x) => x.t).join(' '), ...(heads.length ? { heads } : {}) };
  });
}

export function buildChunks(text: string, sec: string, prefix: string): Chunk[] {
  const sents = splitWithHeads(text.replace(/\s+/g, ' ').trim()).filter((x) => !isNoiseSentence(x.t));
  return packSentences(sents, () => sec, prefix);
}

// 쪽 번호 구간 레이블("3쪽", "3–4쪽")에서 쪽 범위를 읽는다.
const PAGE_SEC = /^(\d+)(?:[–-](\d+))?쪽$/;
export const isPageSec = (sec: string) => PAGE_SEC.test(sec);

// 여러 섹션을 올 때, 이어지는 쪽 섹션("N쪽")은 쪽 경계 없이 한 흐름으로 합쳐 청킹한다(쪽 끝에서 문장·청크가 끊기지 않게).
// 청크의 sec은 시작·끝 쪽으로 만든다("3쪽" 또는 "3–4쪽"). 그 밖의 섹션은 섹션마다 따로 자른다.
// 청크 ID 접두사는 한 흐름의 첫 섹션 번호(sectionOffset + 위치 + 1)를 쓴다. 호출마다 sectionOffset이 이어지므로 겹치지 않는다.
export function buildChunksFromSections(sections: { sec: string; text: string }[], sectionOffset = 0): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < sections.length) {
    const first = PAGE_SEC.exec(sections[i].sec);
    if (!first) {
      out.push(...buildChunks(sections[i].text, sections[i].sec, `p${sectionOffset + i + 1}-`));
      i++;
      continue;
    }
    let j = i;
    const pages: { n: number; text: string }[] = [];
    for (; j < sections.length; j++) {
      const m = PAGE_SEC.exec(sections[j].sec);
      if (!m) break;
      pages.push({ n: +m[1], text: sections[j].text.replace(/\s+/g, ' ').trim() });
    }
    let joined = '';
    const starts: { at: number; n: number }[] = [];
    pages.forEach((pg) => {
      const glue = pg.text.startsWith(JOIN_MARK); // 쪽 경계에서 어절이 끊겼으면 공백 없이 잇는다
      if (joined && !glue) joined += ' ';
      starts.push({ at: joined.length, n: pg.n });
      joined += glue ? pg.text.slice(1) : pg.text;
    });
    const sents: Sent[] = [];
    let pos = 0;
    for (const { t, head } of splitWithHeads(joined)) {
      const at = joined.indexOf(t, pos);
      pos = (at < 0 ? pos : at) + t.length;
      if (isNoiseSentence(t)) continue;
      let n = starts[0].n;
      for (const st of starts) if (st.at <= Math.max(at, 0)) n = st.n;
      sents.push({ t, page: n, head });
    }
    const label = (a: Sent, b: Sent) => (a.page === b.page ? `${a.page}쪽` : `${a.page}–${b.page}쪽`);
    out.push(...packSentences(sents, label, `p${sectionOffset + i + 1}-`));
    i = j;
  }
  return out;
}

/* ---------- 발췌 해석과 검증 ---------- */

export function resolvePick(byId: Record<string, Chunk>, [id, a, b]: Pick) {
  const c = byId[id];
  if (!c) throw new Error('unknown chunk_id ' + id);
  const ss = c.s.slice(a - 1, b);
  const ok = ss.length === b - a + 1 && ss.every((s) => c.t.includes(s));
  return { id: c.id, sec: c.sec, text: ss.join(' '), range: a === b ? `문장 ${a}` : `문장 ${a}–${b}`, ok, from: a, sentences: ss, heads: (c.heads ?? []).filter((n) => n >= a && n <= b) }; // from·sentences: 화면에서 문장 번호를 붙이고 근거 문장을 고르게 하는 데 쓴다
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
export type PlanData = { reqs: string[]; missions: Mission[]; uncovered?: number[] };

// 과제 안내문에서 번호가 붙은 요구 항목(1. 2. 3. / 1) 2) 3) / ① ② ③)을 그대로 뽑는다. 2개 이상이어야 쓰고 최대 4개.
// "요구 항목"이라는 머리말이 있으면 그 뒤만 본다(상황 설명 속 숫자와 섞이지 않게). 못 뽑으면 빈 배열이고, 그때는 LLM이 요구 항목을 나눈다.
export function extractReqs(assignment: string): string[] {
  let t = assignment.replace(/\r/g, '');
  const head = [...t.matchAll(/요구\s*항목\s*\]?\s*[:：]?/g)].pop();
  if (head?.index != null) t = t.slice(head.index + head[0].length);
  const circled = '①②③④⑤⑥⑦⑧⑨⑩';
  const marks: { at: number; end: number }[] = [];
  const re = /(?:^|\n|\s)(?:([1-9])[.)]|([①-⑩])|\(([1-9])\))\s*/g;
  let want = 1;
  for (const m of t.matchAll(re)) {
    const n = m[1] ? +m[1] : m[2] ? circled.indexOf(m[2]) + 1 : +m[3];
    if (n !== want) continue; // 1, 2, 3... 순서로 이어지는 번호만 요구 항목으로 본다
    marks.push({ at: m.index!, end: m.index! + m[0].length });
    want++;
  }
  if (marks.length < 2) return [];
  const items = marks
    .map((mk, i) => t.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : undefined))
    .map((x) => x.split(/\n\s*\n|\n\s*\[[^\]\n]{1,20}\]/)[0]) // 빈 줄이나 다음 머리말([유의] 등)에서 항목을 끝낸다
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 8);
  return items.length >= 2 ? items.slice(0, 4) : [];
}

// LLM이 만든 읽기 계획을 A 기준으로 검증한다. 조건 B는 이 계획에 앞뒤 청크만 더한다(contextIds).
// 미션마다 핵심 발췌는 한 청크 안의 1~CONFIG.coreSent문장이다. 첫 번째로 유효한 pick만 쓴다.
// opts.reqs: 안내문에서 뽑은 요구 항목. 주어지면 LLM이 나눈 항목 대신 이것을 쓰고, 미션의 req가 범위 밖이면 버린다(1번으로 몰지 않는다).
// opts.allowed: 요구 항목(1부터)별로 고를 수 있는 청크 ID. 주어지면 미션의 핵심 청크가 자기 요구 항목의 후보에 있어야 한다.
export function cleanPlan(
  data: any,
  candidates: Chunk[],
  opts: { maxMissions?: number; reqs?: string[]; allowed?: Record<number, Set<string>> } = {},
): PlanData {
  const byId: Record<string, Chunk> = {};
  candidates.forEach((c) => (byId[c.id] = c));
  const fixedReqs = !!opts.reqs?.length;
  const reqs: string[] = fixedReqs ? opts.reqs!.slice(0, 4) : (data?.reqs ?? []).map(String).filter(Boolean).slice(0, 4);
  if (!reqs.length) throw new Error('no reqs');

  const missions: Mission[] = [];

  (data?.missions ?? []).forEach((m: any) => {
    const rq = Math.round(+m.req);
    if (fixedReqs && !(rq >= 1 && rq <= reqs.length)) return; // 요구 항목이 정해져 있으면 항목 번호가 없는 미션은 버린다
    const reqNo = Math.min(reqs.length, Math.max(1, rq || 1));
    let pick: Pick | null = null;
    for (const p of m.picks ?? []) {
      const c = byId[p?.chunk_id];
      if (!c) continue;
      if (opts.allowed?.[reqNo] && !opts.allowed[reqNo].has(c.id)) continue;
      const a = Math.round(+p.from);
      let b = Math.round(+p.to);
      if (!(a >= 1 && b >= a && b <= c.s.length)) continue;
      if (b - a + 1 > CONFIG.coreSent) b = a + CONFIG.coreSent - 1;
      // 제목 문장은 핵심 발췌가 될 수 없다. 양 끝의 제목은 잘라 내고, 남는 문장이 없으면 이 pick은 버린다.
      const hs = c.heads ?? [];
      let lo = a;
      let hi = b;
      while (lo <= hi && hs.includes(lo)) lo++;
      while (hi >= lo && hs.includes(hi)) hi--;
      if (lo > hi) continue;
      pick = [c.id, lo, hi];
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
      req: reqNo,
      pick,
      vars,
    });
  });

  // 미션 고르기: 1) 요구 항목마다 먼저 하나씩(항목 순서대로) 담아 모든 항목이 덮이게 하고, 2) 남는 자리는 항목을 돌아가며 채운다.
  // 항목당 perReqMax개, 전체 maxMissions개. 같은 핵심 청크는 가능하면 한 번만 쓴다(항목을 덮을 다른 방법이 없을 때만 다시 쓴다).
  // 예전에는 항목 순서로 정렬한 뒤 앞에서 자르는 바람에 뒤쪽 항목의 미션이 통째로 잘려 나가 일부 항목만 읽게 됐다.
  // fast(maxMissions 지정)는 항목당 상한 없이 같은 순서로 채운다.
  const max = opts.maxMissions ?? CONFIG.maxMissions;
  const perReqCap = opts.maxMissions ? Infinity : CONFIG.perReqMax;
  const indexed = missions.map((m, i) => ({ m, i }));
  const chosen: { m: Mission; i: number }[] = [];
  const usedChunk = new Set<string>();
  const perReq = new Map<number, number>();
  const take = (x: { m: Mission; i: number }) => {
    chosen.push(x);
    usedChunk.add(x.m.pick[0]);
    perReq.set(x.m.req, (perReq.get(x.m.req) ?? 0) + 1);
  };
  for (let r = 1; r <= reqs.length && chosen.length < max; r++) {
    const mine = indexed.filter((x) => x.m.req === r);
    const first = mine.find((x) => !usedChunk.has(x.m.pick[0])) ?? mine[0];
    if (first) take(first);
  }
  for (let round = 0; chosen.length < max && round < 8; round++) {
    let added = false;
    for (let r = 1; r <= reqs.length && chosen.length < max; r++) {
      if ((perReq.get(r) ?? 0) >= perReqCap) continue;
      const next = indexed.find((x) => x.m.req === r && !chosen.includes(x) && !usedChunk.has(x.m.pick[0]));
      if (next) {
        take(next);
        added = true;
      }
    }
    if (!added) break;
  }
  const kept = chosen.sort((x, y) => x.m.req - y.m.req || x.i - y.i).map((x) => x.m);

  if (!kept.length) throw new Error('no valid mission');
  // 미션이 하나도 없는 요구 항목(1부터). 호출한 쪽이 한 번 더 시도하거나 기록한다.
  const uncovered = reqs.map((_, i) => i + 1).filter((n) => !kept.some((m) => m.req === n));
  return { reqs, missions: kept, ...(uncovered.length ? { uncovered } : {}) };
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
  // 쪽 번호 섹션("3쪽", "3–4쪽")은 논리적 경계가 아니므로 하나의 흐름으로 본다. 그 밖의 섹션은 같은 섹션 안에서만 이웃을 붙인다.
  const grp = (sec: string) => (isPageSec(sec) ? '\u0000pages' : sec);
  const at = new Map(pool.filter((c) => grp(c.sec) === grp(core.sec)).map((c) => [c.idx, c.id]));
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

/* ---------- 미션 진행: 힌트 사다리와 보완 1회 (submit-answer) ---------- */
// 프롬프트 v0.5 1-5, 1-6절.
//  - 힌트: 학습자가 요청할 때만, 한 번에 한 단계씩 1(볼 관점) → 2(위치 + 짧은 인용) → 3(대비 구조 설명). 자동으로 주지 않는다.
//  - 보완: 첫 답이 판정 기준에 못 미치면 미션당 한 번만 요청한다. 보완 뒤에도 부족하면 핵심 요점을 보여 주고 미해결로 넘어간다.
//  - 힌트 횟수와 보완 횟수는 따로 센다.

export const MAX_HINT = 3;
export type Verdict = 'pass' | 'partial' | 'fail';
export type AnswerOutcome = 'passed' | 'revise' | 'unresolved';
export type TurnRec = { mission_idx: number | null; kind: string; payload: any };
export type MissionState = {
  qtype: QType | null;
  hintLevel: number; // 사용한 최고 힌트 단계 (0~3). 로그의 hint_level
  attempts: number; // 복붙이 아닌 답변 제출 수. 0이면 다음 답은 첫 답, 1이면 보완 답
  closed: 'passed' | 'unresolved' | null;
};

// turns 기록에서 한 미션의 상태를 되살린다. 상태를 따로 저장하지 않으므로 기록과 어긋날 수 없다.
export function missionState(turns: TurnRec[], idx: number): MissionState {
  const st: MissionState = { qtype: null, hintLevel: 0, attempts: 0, closed: null };
  for (const t of turns) {
    if (t.mission_idx !== idx) continue;
    const p = t.payload ?? {};
    if (QTYPES.includes(p.qtype)) st.qtype ??= p.qtype;
    if (t.kind === 'hint') st.hintLevel = Math.max(st.hintLevel, Number(p.level) || 0);
    if (t.kind === 'answer') {
      if (!p.copy) st.attempts++;
      if (p.outcome === 'passed' || p.outcome === 'unresolved') st.closed = p.outcome;
    }
  }
  return st;
}

// 미션은 순서대로만 진행한다. 아직 닫히지 않은 첫 미션의 번호(0부터)를 돌려주고, 모두 끝났으면 null.
export function currentMission(turns: TurnRec[], total: number): number | null {
  for (let i = 0; i < total; i++) if (!missionState(turns, i).closed) return i;
  return null;
}

// 판정 → 결과. pass면 통과, 그렇지 않으면 첫 답은 보완 요청, 보완 답은 미해결(요점 공개 후 넘어감).
export function answerOutcome(attemptsBefore: number, verdict: Verdict): AnswerOutcome {
  if (verdict === 'pass') return 'passed';
  return attemptsBefore === 0 ? 'revise' : 'unresolved';
}

const squash = (s: string) => s.replace(/[\s.,?!'"“”]/g, '');

// 힌트·피드백 문장이 판정 기준(key_points)을 그대로 담고 있으면 true. 정답 유출 방지용 마지막 안전장치다.
export function leaksKey(text: string, keys: string[]): boolean {
  const t = squash(text);
  return keys.some((k) => squash(k).length >= 6 && t.includes(squash(k)));
}

// LLM이 고른 문장 번호를 핵심 발췌 범위 안으로 정리한다. 유효한 번호가 없으면 발췌의 앞쪽 max개를 쓴다.
export function sentenceNums(pick: Pick, nums: unknown, max: number): number[] {
  const [, from, to] = pick;
  const ok = (Array.isArray(nums) ? nums : [])
    .map((n) => Math.round(Number(n)))
    .filter((n, i, a) => n >= from && n <= to && a.indexOf(n) === i)
    .sort((x, y) => x - y)
    .slice(0, max);
  if (ok.length) return ok;
  const out: number[] = [];
  for (let n = from; n <= to && out.length < max; n++) out.push(n);
  return out;
}

/* ---------- 안내 수준(스캐폴딩 페이딩)과 질문 깊이 ---------- */

export type FlowOpts = {
  fade: boolean; // 안내 수준 페이딩
  adaptDepth: boolean; // 질문 깊이 적응
};

// 실험 모드(A/B 비교)에서는 둘 다 꺼서 문항 흐름을 같게 유지한다.
export const EXPERIMENT_FLOW: FlowOpts = { fade: false, adaptDepth: false };
export const DEFAULT_FLOW: FlowOpts = { fade: true, adaptDepth: true };

// 도움 정도: 없음(힌트 0 + 안내 요청 없음 + 보완 없음) / 조금(힌트 1단계, 안내 요청, 보완 받음) / 많이(힌트 2단계 이상, 미해결).
// 2026-11-17 결정: 보완을 받은 미션은 "조금"(안내를 줄이거나 질문을 깊게 하지 않는다), 미해결로 끝난 미션은 "많이".
// 힌트가 2단계 이상이면 보완과 무관하게 "많이".
export function nextSupport(
  prev: { sup: number; depth: number },
  used: { hints: number; cueAsked: boolean; revised?: boolean; unresolved?: boolean },
  flow: FlowOpts = DEFAULT_FLOW,
  supStart = CONFIG.supStart,
) {
  let sup = prev.sup;
  let depth = prev.depth;
  const noHelp = used.hints === 0 && !used.cueAsked && !used.revised && !used.unresolved;
  const heavy = used.hints >= 2 || !!used.unresolved;
  if (flow.fade) {
    if (noHelp) {
      if (sup > 0) sup -= 1;
    } else if (heavy) {
      if (sup < supStart) sup += 1;
    }
  }
  if (flow.adaptDepth) {
    if (noHelp) depth = Math.min(2, depth + 1);
    else if (heavy) depth = Math.max(0, depth - 1);
  }
  return { sup, depth };
}

// 질문 유형 고르기: 깊이(0 이해 / 1 추론 / 2 평가)에 가장 가까운 유형, 같은 거리면 더 깊은 쪽.
// 적응 모드가 아니면 깊이를 1(추론)로 고정하고, 적응 모드의 마지막 미션은 최소 lastMinDepth로 올린다. (index.html pickVariant 이식)
export function pickQtype(available: QType[], depth: number, opts: { adaptDepth: boolean; last: boolean }): QType {
  let d = opts.adaptDepth ? depth : 1;
  if (opts.adaptDepth && opts.last) d = Math.max(d, CONFIG.lastMinDepth);
  let best = available[0];
  for (const q of available) {
    const dq = Math.abs(QTYPES.indexOf(q) - d);
    const db = Math.abs(QTYPES.indexOf(best) - d);
    if (dq < db || (dq === db && QTYPES.indexOf(q) > QTYPES.indexOf(best))) best = q;
  }
  return best;
}

// idx번 미션을 보여 줄 때의 안내 수준·깊이. 앞선 미션들의 기록(turns)에서 처음부터 다시 계산하므로 서버가 기준이다.
// 안내 요청(cueAsked)은 서버에 기록이 없어 아직 반영하지 않는다.
export function supportBefore(turns: TurnRec[], idx: number, flow: FlowOpts) {
  let cur = { sup: CONFIG.supStart, depth: 0 };
  for (let i = 0; i < idx; i++) {
    const st = missionState(turns, i);
    cur = nextSupport(
      cur,
      { hints: st.hintLevel, cueAsked: false, revised: st.attempts >= 2, unresolved: st.closed === 'unresolved' },
      flow,
    );
  }
  return cur;
}

/* ---------- 인출 확인 (recall) ---------- */
// 미션을 모두 끝낸 뒤 세 미션 전체를 통합해 확인한다(프롬프트 v0.5 2절, Figma 흐름): 예측 → 원문을 가리고 기억나는 대로 쓰기 → 결과.
// 쓰고 나서 원문과 비교해 다시 고쳐 쓰게 하지 않는다. 학생 피드백("완전한 답을 낼 때까지 계속 다듬게 해서 답답함")을 반영했다.
// 상태는 turns 기록(kind 'recall')에서 되살린다.
//   recall {stage:'predict', jol} → recall {stage:'answer', per:[{m, recalled, total}], recalled, total, actual}
//   recall {stage:'skip'} 은 어느 단계에서든 가능하다.
// 범위는 통과한 미션의 key_points(근거 범위 안의 내용)로 한정한다. 미해결 미션은 이미 핵심을 보여 주었으므로 제외한다.
// 조건 B의 앞뒤 청크 내용은 채점하지 않는다(프롬프트 v0.5 2절).

export type RecallStage = 'none' | 'predicted' | 'answered' | 'skipped';
export type RecallPer = { m: number; recalled: number; total: number };
export type RecallState = {
  stage: RecallStage;
  jol: number | null;
  per: RecallPer[]; // 미션별 떠올린 핵심 수 / 전체 핵심 수
  recalled: number;
  total: number;
};

export function recallState(turns: TurnRec[]): RecallState {
  const st: RecallState = { stage: 'none', jol: null, per: [], recalled: 0, total: 0 };
  for (const t of turns) {
    if (t.kind !== 'recall') continue;
    const p = t.payload ?? {};
    if (p.stage === 'skip') st.stage = 'skipped';
    else if (p.stage === 'predict') {
      st.stage = 'predicted';
      st.jol = typeof p.jol === 'number' ? p.jol : null;
    } else if (p.stage === 'answer') {
      st.stage = 'answered';
      st.per = Array.isArray(p.per) ? p.per : [];
      st.recalled = Number(p.recalled) || 0;
      st.total = Number(p.total) || 0;
    }
  }
  return st;
}

// 인출 대상: 통과한 미션 전체(번호 순). 통과한 미션이 없으면 빈 배열이고 인출은 건너뛴다.
export function recallTargets(turns: TurnRec[], total: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < total; i++) if (missionState(turns, i).closed === 'passed') out.push(i);
  return out;
}

// 여러 미션의 핵심 요소에 이어서 붙인 번호(1부터)로 LLM이 돌려준 "떠올린 핵심"을 미션별로 센다.
export function tallyRecall(groups: { m: number; keys: number }[], recalled: number[]): { per: RecallPer[]; recalled: number; total: number } {
  let start = 0;
  const per = groups.map((g) => {
    const lo = start + 1;
    const hi = start + g.keys;
    start = hi;
    return { m: g.m, recalled: recalled.filter((k) => k >= lo && k <= hi).length, total: g.keys };
  });
  return { per, recalled: per.reduce((n, x) => n + x.recalled, 0), total: per.reduce((n, x) => n + x.total, 0) };
}

// LLM이 돌려준 "떠올린 핵심 번호"를 1..n 범위의 중복 없는 정수로 정리한다.
export function parseRecalled(raw: unknown, n: number): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(Number).filter((k) => Number.isInteger(k) && k >= 1 && k <= n))].sort((a, b) => a - b);
}

/* ---------- 연결 제안 (connect, 선택) ---------- */
// 프롬프트 v0.5 3절: 앞선 미션 내용과 과제의 개념·사례·시사점이 이어질 수 있을 때만 학생에게 한 번 제안한다. 건너뛸 수 있고 억지로 연결하지 않는다.
// 서버는 통과한 미션이 2개 이상일 때만 제안한다(이어 볼 대상이 둘 이상 있어야 한다). 인출이 끝났거나 건너뛴 뒤에 한다.
// 상태는 turns 기록(kind 'connect')에서 되살린다: {stage:'answer', len} 또는 {stage:'skip'}.
export type ConnectStage = 'none' | 'answered' | 'skipped';
export function connectState(turns: TurnRec[]): ConnectStage {
  let st: ConnectStage = 'none';
  for (const t of turns) {
    if (t.kind !== 'connect') continue;
    st = t.payload?.stage === 'skip' ? 'skipped' : t.payload?.stage === 'answer' ? 'answered' : st;
  }
  return st;
}
export const CONNECT_MIN_MISSIONS = 2;

/* ---------- 세션 요약 조립 (finish-session) ---------- */
// R3 읽기 활동 이름. 질문 유형에서 정해 둔 대응이며, 학생이 실제로 한 활동을 판정한 값이 아니다. (연구팀 확인 필요)
// 질문 신고 사유(Figma: '이 질문이 이상해요', '답할 수 없어요', '원문과 달라요', '너무 쉬워요')
export const REPORT_REASONS = ['weird', 'unanswerable', 'mismatch', 'too_easy'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const ACTIVITY_BY_QTYPE: Record<QType, string> = {
  literal: '근거 문장 찾기',
  inferential: '생략된 의미 추론하기',
  evaluative: '주장과 근거 구분하기',
};

export type MissionRow = { idx: number; context_ids: string[] | null };

// turns와 미션 정보에서 세션 요약 입력을 만든다. 시작하지 않은 미션(기록이 없는 미션)은 요약에 넣지 않는다.
// 끝나지 않은 채 종료된 미션은 미해결로 센다.
export function missionRecords(turns: TurnRec[], missions: MissionRow[], flow: FlowOpts, condition: Condition | null) {
  const rec = recallState(turns);
  const records: MissionRecord[] = [];
  const selfCorrections: string[] = [];
  const idxs: number[] = []; // 요약에 들어간 미션 번호(0부터)
  const evidenceCounts: number[] = []; // 미션별로 학생이 고른 근거 문장 수(마지막 답 기준, 결과표의 '근거 문장')
  const boundary: boolean[] = []; // B에서 같은 절 경계 때문에 앞뒤 청크가 모자란 미션. 분석에서 따로 볼 수 있게 남긴다.
  for (const m of missions) {
    const st = missionState(turns, m.idx);
    const mine = turns.filter((t) => t.mission_idx === m.idx);
    if (!mine.length || !st.qtype) continue;
    const answers = mine.filter((t) => t.kind === 'answer' && !t.payload?.copy);
    const per = rec.stage === 'answered' ? rec.per.find((x) => x.m === m.idx) : undefined;
    const recalled = per?.recalled ?? 0;
    const recallTotal = per?.total ?? 0;
    const units = Math.max(1, m.context_ids?.length ?? 1);
    records.push({
      supportLevel: supportBefore(turns, m.idx, flow).sup,
      qtype: st.qtype,
      hintLevel: st.hintLevel,
      unresolved: st.closed !== 'passed',
      textUnits: units,
      contextSufficient: true, // 계획 단계에서 근거 범위(A 기준 핵심 발췌, B 사용성 테스트는 핵심 청크) 안에서 답할 수 있는 질문만 남긴다. 따로 점검한 값은 아니다.
      contextUsed: answers.some((t) => t.payload?.used_context === true),
      evidenceCited: answers.some((t) => t.payload?.evidence_cited === true),
      activity: ACTIVITY_BY_QTYPE[st.qtype],
      recalled,
      recallTotal,
    });
    idxs.push(m.idx);
    const lastEv = [...answers].reverse().find((t) => Array.isArray(t.payload?.evidence))?.payload?.evidence;
    evidenceCounts.push(Array.isArray(lastEv) ? lastEv.length : 0);
    boundary.push(condition === 'B' && units < MAX_TEXT_UNITS);
    if (answers.some((t) => t.payload?.stage === 'revision' && t.payload?.outcome === 'passed')) {
      selfCorrections.push(`미션 ${m.idx + 1} 보완`);
    }
  }
  return { records, selfCorrections, boundary, evidenceCounts, idxs, recall: rec };
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
