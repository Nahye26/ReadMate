// 실행: node --test supabase/functions/_shared/core.test.ts   (Node 22.18+ 의 타입 제거 기능 사용)
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  buildChunks, resolvePick, validateQuote, isCopy, cleanPlan, nextSupport, calibrate,
  summarize, EXPERIMENT_FLOW, DEFAULT_FLOW, contextIds, resolveExcerpts, estimateMins, normalizeAssignment,
  CONFIG, MAX_TEXT_UNITS,
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

test('안내 수준·깊이: 기본 모드는 수행에 따라 변하고, 실험 모드는 고정된다', () => {
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 0 }, { hints: 0, cueAsked: false }, DEFAULT_FLOW), { sup: 1, depth: 1 });
  assert.deepStrictEqual(nextSupport({ sup: 1, depth: 1 }, { hints: 2, cueAsked: false }, DEFAULT_FLOW), { sup: 2, depth: 0 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 2 }, { hints: 1, cueAsked: false }, DEFAULT_FLOW), { sup: 2, depth: 2 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 0 }, { hints: 0, cueAsked: false }, EXPERIMENT_FLOW), { sup: 2, depth: 0 });
  assert.deepStrictEqual(nextSupport({ sup: 2, depth: 1 }, { hints: 3, cueAsked: true }, EXPERIMENT_FLOW), { sup: 2, depth: 1 });
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
