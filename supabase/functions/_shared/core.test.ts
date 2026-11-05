// 실행: node --test supabase/functions/_shared/core.test.ts   (Node 22.18+ 의 타입 제거 기능 사용)
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import {
  buildChunks, resolvePick, validateQuote, isCopy, cleanPlan, nextSupport, calibrate,
  summarize, EXPERIMENT_FLOW, DEFAULT_FLOW,
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

test('계획 검증: 조건 A는 미션당 3문장 상한, B는 더 길게 허용', () => {
  const chunks = [
    { id: 'p1', sec: 's', s: ['1.', '2.', '3.', '4.', '5.', '6.'], t: '1. 2. 3. 4. 5. 6.' },
    { id: 'p2', sec: 's', s: ['a.', 'b.', 'c.'], t: 'a. b. c.' },
  ];
  const raw = [{ chunk_id: 'p1', from: 1, to: 6 }, { chunk_id: 'p2', from: 1, to: 3 }];
  const a = cleanPlan(plan(raw), chunks, 'A');
  const b = cleanPlan(plan(raw), chunks, 'B');
  const units = (p: any) => p.missions[0].pick.reduce((n: number, x: any) => n + (x[2] - x[1] + 1), 0);
  assert.strictEqual(units(a), 3);
  assert.strictEqual(units(b), 8);
  assert.deepStrictEqual(a.missions[0].vars.map((v: any) => v.qtype), ['literal', 'inferential']); // 깊이순 정렬
});

test('계획 검증: 후보에 없는 청크·범위 밖 문장은 버리고, 유효한 미션이 없으면 오류', () => {
  const chunks = [{ id: 'p1', sec: 's', s: ['1.', '2.'], t: '1. 2.' }];
  assert.throws(() => cleanPlan(plan([{ chunk_id: 'zzz', from: 1, to: 1 }]), chunks, 'A'), /no valid mission/);
  assert.throws(() => cleanPlan(plan([{ chunk_id: 'p1', from: 1, to: 9 }]), chunks, 'A'), /no valid mission/);
  assert.throws(() => cleanPlan({ reqs: [], missions: [] }, chunks, 'A'), /no reqs/);
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
