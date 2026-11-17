// 실행: node --test supabase/functions/_shared/core.test.ts   (Node 22.18+ 의 타입 제거 기능 사용)
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  buildChunks, resolvePick, validateQuote, isCopy, cleanPlan, nextSupport, calibrate,
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
