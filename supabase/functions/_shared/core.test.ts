// 실행: node --test supabase/functions/_shared/core.test.ts   (Node 22.18+ 의 타입 제거 기능 사용)
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  buildChunks, resolvePick, validateQuote, isCopy, cleanPlan, extractReqs, nextSupport, calibrate,
  summarize, EXPERIMENT_FLOW, DEFAULT_FLOW, contextIds, resolveExcerpts, estimateMins, normalizeAssignment,
  CONFIG, MAX_TEXT_UNITS, MAX_HINT, missionState, currentMission, answerOutcome, leaksKey, sentenceNums, pickQtype, supportBefore,
} from './core.ts';

const require = createRequire(import.meta.url);
const { check } = require('../../../eval/checks/check_log.js');

const TEXT =
  '퀵리뷰는 오답 직후 해설을 띄운다. 실험에서 점수는 올랐다. 그러나 설문 응답은 부정적이었다. ' +
  '지속률은 낮아졌다. 저자는 점수만 보지 말라고 한다.';

test('청킹: 문장 3개 단위로 자르고 ID를 붙인다', () => {
  const chunks = buildChunks(TEXT, '본문 1문단', 't1-');
  assert.strictEqual(chunks.length, 2);
  assert.deepStrictEqual(chunks.map((c) => c.id), ['t1-1', 't1-2']);
  assert.strictEqual(chunks[0].s.length, 3);
});

test('발췌 해석·인용 검증', () => {
  const [c1] = buildChunks(TEXT, 's', 't1-');
  const by = { [c1.id]: c1 };
  assert.strictEqual(resolvePick(by, ['t1-1', 2, 3]).ok, true);
  assert.strictEqual(resolvePick(by, ['t1-1', 2, 3]).range, '문장 2–3');
  assert.throws(() => resolvePick(by, ['nope', 1, 1]));
  assert.strictEqual(validateQuote(by, 't1-1', '점수는   올랐다').ok, true); // 공백 무시
  assert.strictEqual(validateQuote(by, 't1-1', '없는 문장').ok, false);
});

test('복붙 감지: 발췌를 거의 그대로 옮기면 true, 자기 말이면 false', () => {
  const ex = '실험에서 점수는 올랐다. 그러나 설문 응답은 부정적이었다.';
  assert.strictEqual(isCopy('실험에서 점수는 올랐다. 그러나 설문 응답은 부정적이었다.', ex), true);
  assert.strictEqual(isCopy('성적 지표만 보면 성공처럼 보이지만 학생 경험은 나빴다는 뜻이에요.', ex), false);
  assert.strictEqual(isCopy('짧은 답', ex), false);
});

const plan = (picks: any[]) => ({
  reqs: ['데이터 해석'],
  missions: [{ req: 1, picks, variants: [
    { qtype: 'inferential', question: '왜?', key_points: ['a', 'b'], cue: 'c', frame: 'f ____' },
    { qtype: 'literal', question: '무엇?', key_points: ['a'] },
  ] }],
});

test('분량 상한은 청크 기준: A는 핵심 청크 안 3문장, B는 최대 청크 3개', () => {
  assert.strictEqual(CONFIG.coreSent, 3);
  assert.strictEqual(MAX_TEXT_UNITS, 3);
  assert.strictEqual('cxSent' in CONFIG, false); // 문장 상한 8은 폐기
});

test('계획 검증: 미션마다 핵심 청크 하나, 3문장 상한, 변형은 깊이순', () => {
  const chunks = [
    { id: 'p1', sec: 's', s: ['1.', '2.', '3.', '4.', '5.', '6.'], t: '1. 2. 3. 4. 5. 6.' },
    { id: 'p2', sec: 's', s: ['a.', 'b.', 'c.'], t: 'a. b. c.' },
  ];
  // 여러 청크에 걸쳐 길게 고른 경우: 첫 청크 하나만, 3문장으로 줄인다.
  const p = cleanPlan(plan([{ chunk_id: 'p1', from: 1, to: 6 }, { chunk_id: 'p2', from: 1, to: 3 }]), chunks);
  assert.deepStrictEqual(p.missions[0].pick, ['p1', 1, 3]);
  assert.deepStrictEqual(p.missions[0].vars.map((v: any) => v.qtype), ['literal', 'inferential']);
  assert.strictEqual('reason' in p, false);
  // 앞의 pick이 무효(없는 청크)면 다음 유효한 pick을 쓴다.
  const q = cleanPlan(plan([{ chunk_id: 'zzz', from: 1, to: 1 }, { chunk_id: 'p2', from: 2, to: 3 }]), chunks);
  assert.deepStrictEqual(q.missions[0].pick, ['p2', 2, 3]);
});

test('계획 검증: 후보에 없는 청크·범위 밖 문장은 버리고, 유효한 미션이 없으면 오류', () => {
  const chunks = [{ id: 'p1', sec: 's', s: ['1.', '2.'], t: '1. 2.' }];
  assert.throws(() => cleanPlan(plan([{ chunk_id: 'zzz', from: 1, to: 1 }]), chunks), /no valid mission/);
  assert.throws(() => cleanPlan(plan([{ chunk_id: 'p1', from: 1, to: 9 }]), chunks), /no valid mission/);
  assert.throws(() => cleanPlan({ reqs: [], missions: [] }, chunks), /no reqs/);
});

test('계획 검증: 요구 항목당 상한, 같은 청크는 한 번만, 항목 순서로 정렬, 전체 상한', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'p' + (i + 1));
  const chunks = ids.map((id) => ({ id, sec: 's', s: ['a.', 'b.'], t: 'a. b.' }));
  const mk = (req: number, id: string) => ({
    req, picks: [{ chunk_id: id, from: 1, to: 2 }],
    variants: [{ qtype: 'literal', question: 'q', key_points: ['k'], cue: 'c', frame: 'f ____' }],
  });
  // 항목 3이 먼저 나오고, 항목 1에는 상한보다 1개 더 많이, p2는 다른 항목에서 다시 고름(버림)
  const r1 = Array.from({ length: CONFIG.perReqMax + 1 }, (_, i) => mk(1, ids[i]));
  const data = { reqs: ['r1', 'r2', 'r3'], missions: [mk(3, 'p10'), ...r1, mk(2, 'p2'), mk(2, 'p11'), mk(3, 'p12')] };
  const p = cleanPlan(data, chunks);
  const reqs = p.missions.map((m) => m.req);
  assert.deepStrictEqual(reqs, [...reqs].sort((x, y) => x - y)); // 항목 순서
  assert.ok(reqs.filter((r) => r === 1).length <= CONFIG.perReqMax);
  const cores = p.missions.map((m) => m.pick[0]);
  assert.strictEqual(new Set(cores).size, cores.length); // 같은 청크 중복 없음
  assert.ok(p.missions.length <= CONFIG.maxMissions);
  // fast(maxMissions=2)는 항목당 상한 없이 앞에서 2개만
  assert.strictEqual(cleanPlan(data, chunks, { maxMissions: 2 }).missions.length, 2);
});

test('세션 구성: 기본 미션 수와 시간 추정이 최소 30분을 채운다(조건 B 청크 3개 ≈ 900자)', () => {
  const perMission = estimateMins(MAX_TEXT_UNITS * 300);
  assert.ok(CONFIG.missions * perMission + CONFIG.recallMins >= CONFIG.minMins);
  assert.ok(CONFIG.missions <= CONFIG.maxMissions);
});

test('요구 항목 추출: 번호 항목을 그대로 뽑고, 상황 설명 속 숫자는 무시한다', () => {
  const asg = `[상황] 당신은 2014년 사업을 검토하는 담당자입니다. 1500자 내외로 쓰세요.
[요구 항목]
1. 사례가 우수 운영 사례로 선정된 이유와 연구 방법을 설명하세요.
2. 교사의 역할과 지역사회 협업 체계를 정리하세요.
3. 학생에게 가져온 변화를 근거와 함께 설명하세요.
4. 적용할 때의 시사점과 연구의 한계를 쓰세요.
[유의] 평소처럼 AI를 써도 됩니다.`;
  const r = extractReqs(asg);
  assert.strictEqual(r.length, 4);
  assert.ok(r[0].startsWith('사례가 우수 운영 사례로'));
  assert.strictEqual(r[3], '적용할 때의 시사점과 연구의 한계를 쓰세요.'); // [유의] 머리말 이하는 마지막 항목에 붙지 않는다
  // 한 줄에 이어 붙인 번호, 괄호·원문자 번호도 읽는다
  assert.strictEqual(extractReqs('요구 항목: 1) 원인을 설명하세요. 2) 한계를 설명하세요.').length, 2);
  assert.strictEqual(extractReqs('① 배경을 정리하세요 ② 결과를 정리하세요 ③ 시사점을 정리하세요').length, 3);
  // 번호가 1부터 이어지지 않거나 항목이 하나뿐이면 못 뽑은 것으로 본다(LLM이 나눈다)
  assert.deepStrictEqual(extractReqs('이 논문을 읽고 3. 부분을 요약하세요.'), []);
  assert.deepStrictEqual(extractReqs('1. 논문의 핵심을 설명하세요.'), []);
  assert.deepStrictEqual(extractReqs('추천 시스템의 인기 편향 원인과 한계를 정리하세요.'), []);
  // 5개 이상이면 앞의 4개
  assert.strictEqual(extractReqs('1. 첫째 항목입니다 2. 둘째 항목입니다 3. 셋째 항목입니다 4. 넷째 항목입니다 5. 다섯째 항목입니다').length, 4);
});

test('계획 검증: 요구 항목이 정해지면 항목 번호 없는 미션은 버리고, 후보 밖 청크는 거르고, 빠진 항목을 알린다', () => {
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const chunks = ids.map((id) => ({ id, sec: 's', s: ['a.', 'b.'], t: 'a. b.' }));
  const mk = (req: number | undefined, id: string) => ({
    req, picks: [{ chunk_id: id, from: 1, to: 2 }],
    variants: [{ qtype: 'literal', question: 'q', key_points: ['k'], cue: 'c', frame: 'f ____' }],
  });
  const reqs = ['요구 하나입니다 하나', '요구 둘입니다 둘', '요구 셋입니다 셋'];
  const allowed = { 1: new Set(['p1', 'p2']), 2: new Set(['p3', 'p4']), 3: new Set(['p5']) };
  const data = { reqs: ['LLM이 바꾼 항목'], missions: [mk(1, 'p1'), mk(undefined, 'p2'), mk(2, 'p1'), mk(2, 'p3')] };
  const p = cleanPlan(data, chunks, { reqs, allowed });
  assert.deepStrictEqual(p.reqs, reqs); // LLM이 나눈 항목이 아니라 정해진 항목을 쓴다
  assert.deepStrictEqual(p.missions.map((m) => [m.req, m.pick[0]]), [[1, 'p1'], [2, 'p3']]); // 번호 없음·후보 밖(p1은 요구 2의 후보가 아님)은 버려진다
  assert.deepStrictEqual(p.uncovered, [3]); // 요구 3에는 미션이 없다
  // 모두 덮이면 uncovered가 없다
  const ok = cleanPlan({ missions: [mk(1, 'p1'), mk(2, 'p3'), mk(3, 'p5')] }, chunks, { reqs, allowed });
  assert.strictEqual('uncovered' in ok, false);
  // 요구 항목을 주지 않은 대체 경로는 이전처럼 동작한다(번호가 없으면 1번)
  assert.strictEqual(cleanPlan({ reqs: ['a b c d e f g h'], missions: [mk(undefined, 'p1')] }, chunks).missions[0].req, 1);
});

// 한 절 'a'(idx 0~3)와 다음 절 'b'(idx 4~5)
const pool = [
  { id: 'a1', idx: 0, sec: 'a' }, { id: 'a2', idx: 1, sec: 'a' }, { id: 'a3', idx: 2, sec: 'a' }, { id: 'a4', idx: 3, sec: 'a' },
  { id: 'b1', idx: 4, sec: 'b' }, { id: 'b2', idx: 5, sec: 'b' },
];
const ref = (id: string) => pool.find((c) => c.id === id)!;

test('조건 B 확장: 핵심 청크 + 앞 1개 + 뒤 1개, 같은 절 안에서만', () => {
  assert.deepStrictEqual(contextIds(ref('a2'), pool), ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(contextIds(ref('a1'), pool), ['a1', 'a2']); // 절의 첫 청크는 앞이 없다
  assert.deepStrictEqual(contextIds(ref('a4'), pool), ['a3', 'a4']); // 뒤는 다음 절(b1)이라 붙이지 않는다
  assert.deepStrictEqual(contextIds(ref('b1'), pool), ['b1', 'b2']); // 앞은 이전 절(a4)이라 붙이지 않는다
  assert.deepStrictEqual(contextIds(ref('b2'), pool), ['b1', 'b2']); // 자료의 마지막 청크
  assert.ok(pool.every((c) => contextIds(c, pool).length <= MAX_TEXT_UNITS));
  assert.deepStrictEqual(contextIds(ref('a2'), pool.filter((c) => c.id !== 'a3')), ['a1', 'a2']); // 이웃이 후보에 없으면 생략
});

test('발췌 해석: A는 핵심 문장만, B는 같은 핵심 위에 앞뒤 청크 전체를 얹는다', () => {
  const chunks = [
    { id: 'a1', sec: 'a', s: ['앞 1.', '앞 2.'], t: '앞 1. 앞 2.' },
    { id: 'a2', sec: 'a', s: ['핵심 1.', '핵심 2.', '핵심 3.'], t: '핵심 1. 핵심 2. 핵심 3.' },
    { id: 'a3', sec: 'a', s: ['뒤 1.'], t: '뒤 1.' },
  ];
  const by = Object.fromEntries(chunks.map((c) => [c.id, c]));
  const pick: [string, number, number] = ['a2', 1, 2];

  const a = resolveExcerpts(by, pick, 'A', ['a2']);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].text, '핵심 1. 핵심 2.');
  assert.strictEqual(a[0].range, '문장 1–2');

  const b = resolveExcerpts(by, pick, 'B', ['a1', 'a2', 'a3']);
  assert.deepStrictEqual(b.map((e) => e.role), ['before', 'core', 'after']);
  assert.deepStrictEqual(b.map((e) => e.id), ['a1', 'a2', 'a3']);
  assert.strictEqual(b[1].text, '핵심 1. 핵심 2. 핵심 3.'); // 핵심 청크는 전체
  assert.deepStrictEqual(b[1].focus, [1, 2]); // A가 보여 준 문장 범위는 표시용으로 남긴다
  assert.ok(b[1].text.includes(a[0].text)); // B는 A의 텍스트를 포함한다 (변인은 앞뒤 청크 하나)
  assert.ok(b.every((e) => e.ok));
  assert.throws(() => resolveExcerpts(by, pick, 'B', ['a1', 'a3']), /core chunk/);
});

test('읽기 시간·과제 안내문 키', () => {
  assert.strictEqual(estimateMins(0), 3);
  assert.strictEqual(estimateMins(401), 4);
  assert.strictEqual(normalizeAssignment('  두 문단\n  요약해  서 쓰세요 '), '두 문단 요약해 서 쓰세요');
});

const T = (mission_idx: number, kind: string, payload: object) => ({ mission_idx, kind, payload });

test('미션 상태: 힌트는 최고 단계, 보완은 답변 횟수로 따로 센다 (복붙은 세지 않음)', () => {
  assert.deepStrictEqual(missionState([], 0), { qtype: null, hintLevel: 0, attempts: 0, closed: null });
  const turns = [
    T(0, 'hint', { qtype: 'literal', level: 1 }),
    T(0, 'answer', { qtype: 'literal', copy: true, outcome: 'rewrite' }),
    T(0, 'answer', { qtype: 'literal', stage: 'first', verdict: 'partial', outcome: 'revise' }),
    T(0, 'hint', { qtype: 'literal', level: 2 }),
    T(1, 'hint', { qtype: 'inferential', level: 3 }), // 다른 미션은 섞이지 않는다
  ];
  assert.deepStrictEqual(missionState(turns, 0), { qtype: 'literal', hintLevel: 2, attempts: 1, closed: null });
  const closed = [...turns, T(0, 'answer', { qtype: 'literal', stage: 'revision', outcome: 'passed' })];
  assert.strictEqual(missionState(closed, 0).closed, 'passed');
  assert.strictEqual(missionState(closed, 0).attempts, 2);
  assert.strictEqual(MAX_HINT, 3);
});

test('진행 순서: 닫히지 않은 첫 미션이 현재 미션', () => {
  assert.strictEqual(currentMission([], 3), 0);
  const t0 = [T(0, 'answer', { qtype: 'literal', outcome: 'passed' })];
  assert.strictEqual(currentMission(t0, 3), 1);
  const t01 = [...t0, T(1, 'answer', { qtype: 'literal', outcome: 'revise' })];
  assert.strictEqual(currentMission(t01, 3), 1); // 보완 요청만으로는 닫히지 않는다
  const all = [0, 1, 2].map((i) => T(i, 'answer', { qtype: 'literal', outcome: i === 1 ? 'unresolved' : 'passed' }));
  assert.strictEqual(currentMission(all, 3), null);
});

test('보완 1회: 첫 답이 충분하면 보완 없음, 부족하면 한 번, 보완 뒤에도 부족하면 미해결', () => {
  assert.strictEqual(answerOutcome(0, 'pass'), 'passed');
  assert.strictEqual(answerOutcome(0, 'partial'), 'revise');
  assert.strictEqual(answerOutcome(0, 'fail'), 'revise');
  assert.strictEqual(answerOutcome(1, 'pass'), 'passed');
  assert.strictEqual(answerOutcome(1, 'partial'), 'unresolved'); // 두 번째 보완은 요구하지 않는다
  assert.strictEqual(answerOutcome(1, 'fail'), 'unresolved');
});

test('정답 유출 방지와 문장 번호 정리', () => {
  const keys = ['저자는 점수 상승을 성공으로 보지 않는다'];
  assert.strictEqual(leaksKey('저자는 점수 상승을 성공으로 보지 않는다고 했어요.', keys), true);
  assert.strictEqual(leaksKey('저자는 점수 상승을, 성공으로 보지 않는다', keys), true); // 구두점 무시
  assert.strictEqual(leaksKey('두 결과가 어떻게 다른지 비교해 보세요.', keys), false);
  assert.strictEqual(leaksKey('짧은', ['짧은']), false); // 너무 짧은 기준은 오탐이 많아 보지 않는다
  const pick: [string, number, number] = ['c', 2, 4];
  assert.deepStrictEqual(sentenceNums(pick, [4, 9, 3, 3, 1], 2), [3, 4]); // 범위 밖·중복 제거, 최대 2개
  assert.deepStrictEqual(sentenceNums(pick, 'x', 2), [2, 3]); // 유효한 번호가 없으면 발췌 앞쪽
  assert.deepStrictEqual(sentenceNums(pick, [], 3), [2, 3, 4]);
});

test('안내 수준·깊이: 기본 모드는 수행에 따라 변하고, 실험 모드는 고정된다', () => {
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 0 }, { hints: 0, cueAsked: false }, DEFAULT_FLOW), { sup: 1, depth: 1 });
  assert.deepStrictEqual(nextSupport({ sup: 1, depth: 1 }, { hints: 2, cueAsked: false }, DEFAULT_FLOW), { sup: 2, depth: 0 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 2 }, { hints: 1, cueAsked: false }, DEFAULT_FLOW), { sup: 2, depth: 2 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 0 }, { hints: 0, cueAsked: false }, EXPERIMENT_FLOW), { sup: 2, depth: 0 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 1 }, { hints: 3, cueAsked: true }, EXPERIMENT_FLOW), { sup: 2, depth: 1 });
});

test('도움 정도: 보완을 받은 미션은 "조금" — 안내를 줄이거나 깊게 하지 않는다', () => {
  const start = { sup: 1, depth: 1 };
  // 힌트 없이 보완만 받음: 없음이 아니므로 그대로
  assert.deepStrictEqual(nextSupport(start, { hints: 0, cueAsked: false, revised: true }, DEFAULT_FLOW), start);
  // 보완 없이 힌트도 없음: 줄이고 깊게
  assert.deepStrictEqual(nextSupport(start, { hints: 0, cueAsked: false, revised: false }, DEFAULT_FLOW), { sup: 0, depth: 2 });
  assert.deepStrictEqual(nextSupport(start, { hints: 0, cueAsked: false }, DEFAULT_FLOW), { sup: 0, depth: 2 }); // revised 생략 = 보완 없음
  // 보완 + 힌트 2단계: 많이 (힌트 기준이 우선)
  assert.deepStrictEqual(nextSupport(start, { hints: 2, cueAsked: false, revised: true }, DEFAULT_FLOW), { sup: 2, depth: 0 });
  // 미해결(보완 뒤에도 실패): 힌트가 0이어도 "많이" — 안내를 늘리고 질문을 쉽게
  assert.deepStrictEqual(nextSupport(start, { hints: 0, cueAsked: false, revised: true, unresolved: true }, DEFAULT_FLOW), { sup: 2, depth: 0 });
  assert.deepStrictEqual(nextSupport({ sup: 0, depth: 2 }, { hints: 1, cueAsked: false, revised: true, unresolved: true }, DEFAULT_FLOW), { sup: 1, depth: 1 });
  // 실험 모드에서는 어떤 경우에도 고정
  assert.deepStrictEqual(nextSupport(start, { hints: 3, cueAsked: true, revised: true, unresolved: true }, EXPERIMENT_FLOW), start);
});

test('질문 유형 고르기: 깊이에 가장 가까운 유형, 같은 거리면 깊은 쪽, 마지막 미션은 최소 추론', () => {
  const all = ['literal', 'inferential', 'evaluative'] as const;
  const two = ['literal', 'inferential'] as const;
  assert.strictEqual(pickQtype([...all], 0, { adaptDepth: true, last: false }), 'literal');
  assert.strictEqual(pickQtype([...all], 2, { adaptDepth: true, last: false }), 'evaluative');
  assert.strictEqual(pickQtype([...two], 2, { adaptDepth: true, last: false }), 'inferential'); // 평가가 없으면 가까운 추론
  assert.strictEqual(pickQtype([...all], 0, { adaptDepth: true, last: true }), 'inferential'); // 마지막 미션 최소 추론
  assert.strictEqual(pickQtype([...all], 0, { adaptDepth: false, last: true }), 'inferential'); // 고정 모드는 깊이 1
  assert.strictEqual(pickQtype(['literal', 'evaluative'], 1, { adaptDepth: true, last: false }), 'evaluative'); // 동거리 → 깊은 쪽
});

test('미션 시작 시 안내 수준·깊이: 앞선 미션 기록에서 다시 계산한다', () => {
  // 시작은 안내 2, 깊이 0
  assert.deepStrictEqual(supportBefore([], 0, DEFAULT_FLOW), { sup: 2, depth: 0 });
  // 미션 1을 도움 없이 → 안내 1, 깊이 1
  const h1 = [T(0, 'answer', { qtype: 'literal', outcome: 'passed' })];
  assert.deepStrictEqual(supportBefore(h1, 1, DEFAULT_FLOW), { sup: 1, depth: 1 });
  // 미션 1은 보완만 받고 통과(시도 2회) → 그대로
  const h2 = [T(0, 'answer', { qtype: 'literal', outcome: 'revise' }), T(0, 'answer', { qtype: 'literal', outcome: 'passed' })];
  assert.deepStrictEqual(supportBefore(h2, 1, DEFAULT_FLOW), { sup: 2, depth: 0 });
  // 미션 1 힌트 2단계 + 통과 → 늘릴 수 없는 상태(2)라 안내 2 유지, 깊이 0 유지
  const h3 = [T(0, 'hint', { qtype: 'literal', level: 2 }), T(0, 'answer', { qtype: 'literal', outcome: 'passed' })];
  assert.deepStrictEqual(supportBefore(h3, 1, DEFAULT_FLOW), { sup: 2, depth: 0 });
  // 미션 1이 미해결(보완 뒤 실패) → 많이. 시작 수준이 최대(2)라 안내는 그대로, 깊이는 0 아래로 내려가지 않는다
  const h4 = [T(0, 'answer', { qtype: 'literal', outcome: 'revise' }), T(0, 'answer', { qtype: 'literal', outcome: 'unresolved' })];
  assert.deepStrictEqual(supportBefore(h4, 1, DEFAULT_FLOW), { sup: 2, depth: 0 });
  // 먼저 도움 없이 두 미션을 풀어 안내 0·깊이 2까지 간 뒤 미해결이면 안내 +1, 깊이 −1
  const two = [T(0, 'answer', { qtype: 'literal', outcome: 'passed' }), T(1, 'answer', { qtype: 'literal', outcome: 'passed' })];
  assert.deepStrictEqual(supportBefore(two, 2, DEFAULT_FLOW), { sup: 0, depth: 2 });
  const afterFail = [...two, T(2, 'answer', { qtype: 'literal', outcome: 'revise' }), T(2, 'answer', { qtype: 'literal', outcome: 'unresolved' })];
  assert.deepStrictEqual(supportBefore(afterFail, 3, DEFAULT_FLOW), { sup: 1, depth: 1 });
  // 실험 모드는 변하지 않는다
  assert.deepStrictEqual(supportBefore(h1, 1, EXPERIMENT_FLOW), { sup: 2, depth: 0 });
});

test('보정 판정: 파일럿 로그 두 건은 모두 비슷', () => {
  assert.strictEqual(calibrate(0.625, 0.667), '비슷');
  assert.strictEqual(calibrate(0.625, 0.5), '비슷');
  assert.strictEqual(calibrate(0.875, 0.5), '과대');
  assert.strictEqual(calibrate(0.125, 0.5), '과소');
});

const base = {
  model: 'synthetic', condition: 'A' as const, paperId: 'paper01', recallPrediction: 0.625,
  newInfoInRecall: false, selfCorrections: [], readingLoad: 2, exitReason: null,
};
const rec = (over: object = {}) => ({
  supportLevel: 2, qtype: 'literal' as const, hintLevel: 0, unresolved: false, textUnits: 3,
  contextSufficient: true, contextUsed: false, evidenceCited: true, activity: '근거 문장 찾기',
  recalled: 1, recallTotal: 2, ...over,
});

test('요약 로그는 eval 검사기(v0.5 엄격)를 통과한다 — 조건 A·B 모두', () => {
  for (const condition of ['A', 'B'] as const) {
    const log = summarize({ ...base, condition, missions: [rec(), rec({ qtype: 'inferential', hintLevel: 1 }), rec({ unresolved: true })] });
    const r = check(JSON.stringify(log), { condition });
    assert.strictEqual(r.pass, true, r.reason);
  }
});

test('요약 로그 값: 미해결·힌트 집계와 회상 계산', () => {
  const log = summarize({ ...base, missions: [rec({ recalled: 2, recallTotal: 2 }), rec({ hintLevel: 2, recalled: 1 }), rec({ unresolved: true, recalled: 0 })] });
  assert.strictEqual(log.missions_done, '2/3');
  assert.deepStrictEqual(log.missions_unresolved, [3]);
  assert.strictEqual(log.answered_without_hint, 1);
  assert.strictEqual(log.answered_with_hint, 1);
  assert.strictEqual(log.recall_actual, 0.5); // 3/6
  assert.strictEqual(log.calibration_gap, 0.125);
  assert.strictEqual(log.reading_type, '발췌형');
});

/* ---------- 인출 확인 · 세션 요약 ---------- */
import { recallState, recallTargets, tallyRecall, parseRecalled, missionRecords, ACTIVITY_BY_QTYPE } from './core.ts';

const ans = (m: number, p: object) => ({ mission_idx: m, kind: 'answer', payload: { qtype: 'literal', ...p } });
const hint = (m: number, level: number) => ({ mission_idx: m, kind: 'hint', payload: { qtype: 'literal', level } });

test('recallState: 기록에서 단계를 되살린다', () => {
  assert.strictEqual(recallState([]).stage, 'none');
  const p = { mission_idx: null, kind: 'recall', payload: { stage: 'predict', jol: 0.625 } };
  assert.strictEqual(recallState([p]).jol, 0.625);
  const a = {
    mission_idx: null, kind: 'recall',
    payload: { stage: 'answer', per: [{ m: 0, recalled: 1, total: 2 }, { m: 2, recalled: 2, total: 2 }], recalled: 3, total: 4 },
  };
  const st = recallState([p, a]);
  assert.strictEqual(st.stage, 'answered');
  assert.deepStrictEqual([st.recalled, st.total, st.per.length], [3, 4, 2]);
  assert.strictEqual(recallState([p, { mission_idx: null, kind: 'recall', payload: { stage: 'skip' } }]).stage, 'skipped');
});

test('recallTargets: 통과한 미션만(미해결 제외), tallyRecall: 이어 붙인 번호를 미션별로 센다', () => {
  const t = [
    ans(0, { qtype: 'literal', outcome: 'passed' }),
    ans(1, { qtype: 'inferential', outcome: 'unresolved' }),
    ans(2, { qtype: 'literal', outcome: 'passed' }),
  ];
  assert.deepStrictEqual(recallTargets(t, 3), [0, 2]);
  assert.deepStrictEqual(recallTargets([ans(0, { outcome: 'unresolved' })], 1), []);
  const r = tallyRecall([{ m: 0, keys: 2 }, { m: 2, keys: 2 }], [2, 3, 4]);
  assert.deepStrictEqual(r.per, [{ m: 0, recalled: 1, total: 2 }, { m: 2, recalled: 2, total: 2 }]);
  assert.deepStrictEqual([r.recalled, r.total], [3, 4]);
});

test('parseRecalled: 범위 밖·중복·문자열을 걸러 낸다', () => {
  assert.deepStrictEqual(parseRecalled([3, '1', 1, 0, 9, 'x'], 3), [1, 3]);
  assert.deepStrictEqual(parseRecalled('1', 3), []);
});

test('missionRecords: 힌트·보완·인출·경계 청크를 기록에서 모은다', () => {
  const turns = [
    hint(0, 1),
    ans(0, { stage: 'first', verdict: 'partial', outcome: 'revise' }),
    ans(0, { stage: 'revision', verdict: 'pass', outcome: 'passed', evidence_cited: true, used_context: true }),
    ans(1, { qtype: 'inferential', stage: 'first', verdict: 'fail', outcome: 'revise' }),
    ans(1, { qtype: 'inferential', stage: 'revision', verdict: 'fail', outcome: 'unresolved' }),
    { mission_idx: null, kind: 'recall', payload: { stage: 'predict', jol: 0.875 } },
    { mission_idx: null, kind: 'recall', payload: { stage: 'answer', per: [{ m: 0, recalled: 1, total: 2 }], recalled: 1, total: 2 } },
  ];
  const missions = [
    { idx: 0, context_ids: ['a', 'b', 'c'] },
    { idx: 1, context_ids: ['x', 'y'] }, // 절 끝이라 뒤 청크 없음
    { idx: 2, context_ids: ['z'] }, // 시작하지 않음
  ];
  const r = missionRecords(turns, missions, DEFAULT_FLOW, 'B');
  assert.strictEqual(r.records.length, 2); // 시작하지 않은 미션은 제외
  assert.deepStrictEqual(r.records.map((m) => m.textUnits), [3, 2]);
  assert.deepStrictEqual(r.boundary, [false, true]);
  assert.deepStrictEqual(r.records.map((m) => m.unresolved), [false, true]);
  assert.strictEqual(r.records[0].hintLevel, 1);
  assert.strictEqual(r.records[0].contextUsed, true);
  assert.strictEqual(r.records[0].evidenceCited, true);
  assert.deepStrictEqual([r.records[0].recalled, r.records[0].recallTotal], [1, 2]);
  assert.deepStrictEqual([r.records[1].recalled, r.records[1].recallTotal], [0, 0]);
  assert.strictEqual(r.records[1].activity, ACTIVITY_BY_QTYPE.inferential);
  assert.deepStrictEqual(r.selfCorrections, ['미션 1 보완']);
  const a = missionRecords(turns, missions, DEFAULT_FLOW, 'A');
  assert.deepStrictEqual(a.boundary, [false, false]); // 경계 표시는 B에서만
});

test('missionRecords → summarize: v0.5 로그 형식을 지킨다(실험 흐름)', () => {
  const turns = [0, 1, 2].map((i) => ans(i, { stage: 'first', verdict: 'pass', outcome: 'passed' }));
  turns.push(
    { mission_idx: null, kind: 'recall', payload: { stage: 'predict', jol: 0.625 } } as never,
    { mission_idx: null, kind: 'recall', payload: { stage: 'answer', per: [{ m: 0, recalled: 1, total: 1 }, { m: 1, recalled: 1, total: 1 }, { m: 2, recalled: 1, total: 1 }], recalled: 3, total: 3 } } as never,
  );
  const missions = [0, 1, 2].map((idx) => ({ idx, context_ids: ['a', 'b', 'c'] }));
  const r = missionRecords(turns, missions, EXPERIMENT_FLOW, 'B');
  const s = summarize({
    model: 'm', condition: 'B', paperId: 'p', missions: r.records, recallPrediction: 0.625, newInfoInRecall: false,
    selfCorrections: r.selfCorrections, readingLoad: 2, exitReason: null,
  });
  const res = check('```json\n' + JSON.stringify(s) + '\n```', { condition: 'B' });
  assert.strictEqual(res.pass, true, res.reason);
  assert.deepStrictEqual(s.text_units_provided, [3, 3, 3]);
  assert.strictEqual(s.recall_actual, 1);
});

test('근거 범위: 사용성 테스트(B)만 핵심 청크 전체, 효과성 검증은 고른 문장', async () => {
  const { basisFor, basisPick } = await import('./core.ts');
  assert.strictEqual(basisFor(false, 'B'), 'chunk');
  assert.strictEqual(basisFor(false, 'A'), 'excerpt');
  assert.strictEqual(basisFor(true, 'B'), 'excerpt'); // 실험 모드는 A/B가 같은 기준
  assert.deepStrictEqual(basisPick('chunk', ['p1-1', 2, 3], 3), ['p1-1', 1, 3]);
  assert.deepStrictEqual(basisPick('excerpt', ['p1-1', 2, 3], 3), ['p1-1', 2, 3]);
  assert.deepStrictEqual(basisPick(undefined, ['p1-1', 2, 3], 3), ['p1-1', 2, 3]);
});

test('missionRecords: 근거 문장 수는 마지막 답의 선택 수', () => {
  const t = [
    ans(0, { stage: 'first', outcome: 'revise', evidence: [1] }),
    ans(0, { stage: 'revision', outcome: 'passed', evidence: [1, 3] }),
    ans(1, { stage: 'first', outcome: 'passed' }),
  ];
  const r = missionRecords(t, [{ idx: 0, context_ids: ['a'] }, { idx: 1, context_ids: ['b'] }], DEFAULT_FLOW, 'B');
  assert.deepStrictEqual(r.evidenceCounts, [2, 0]);
});

test('connectState: 연결 단계 기록', async () => {
  const { connectState } = await import('./core.ts');
  assert.strictEqual(connectState([]), 'none');
  assert.strictEqual(connectState([{ mission_idx: null, kind: 'connect', payload: { stage: 'skip' } }]), 'skipped');
  assert.strictEqual(connectState([{ mission_idx: null, kind: 'connect', payload: { stage: 'answer' } }]), 'answered');
});
