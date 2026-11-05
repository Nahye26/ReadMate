// 실행: cd eval && node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { check, expectedLabel } = require('../checks/check_log.js');

// 합성 데이터(실제 시행 로그 아님): 조건 A, 예측 0.625 / 실제 0.5 → 차이 0.125 → 비슷
const goodA = {
  prompt_version: 'v0.5-chat',
  model: 'synthetic',
  condition: 'A',
  paper_id: 'synthetic-001',
  reading_type: '발췌형',
  support_path: [2, 2, 2],
  text_units_provided: [2, 2, 2],
  missions_done: '3/3',
  missions_unresolved: [],
  answered_without_hint: 2,
  answered_with_hint: 1,
  hint_level: [0, 1, 0],
  question_path: ['literal', 'inferential', 'inferential'],
  context_sufficient: [true, true, true],
  context_used: [false, true, true],
  evidence_cited: [true, true, true],
  activity_type: ['근거 문장 찾기', '문단 연결하기', '의미 추론하기'],
  recall_per_mission: ['2/2', '1/2', '1/2'],
  new_info_in_recall: false,
  recall_done: true,
  recall_prediction: 0.625,
  recall_actual: 0.5,
  calibration: '비슷',
  calibration_gap: 0.125,
  self_corrections: [],
  reading_load: 2,
  exit_reason: null,
};
const run = (log, vars = { condition: log.condition }) => check(JSON.stringify(log), vars);
const mutate = (patch) => ({ ...goodA, ...patch });

test('유효한 v0.5 로그는 통과한다', () => assert.strictEqual(run(goodA).pass, true));

test('```json 펜스로 감싼 출력도 파싱한다', () => {
  assert.strictEqual(check('로그입니다\n```json\n' + JSON.stringify(goodA) + '\n```', {}).pass, true);
});

test('JSON이 아니면 실패한다', () => assert.strictEqual(check('JSON 없음', {}).pass, false));

for (const [name, patch, expected] of [
  ['조건과 reading_type 불일치', { reading_type: '맥락형' }, 'reading_type'],
  ['실험 모드인데 안내 수준이 바뀜', { support_path: [2, 1, 2] }, 'support_path'],
  ['보정 라벨 오류(과대여야 함)', { recall_prediction: 0.875, recall_actual: 0.5, calibration: '비슷', calibration_gap: 0.375 }, 'calibration 판정'],
  ['예측값이 선택지에 없음', { recall_prediction: 0.5, calibration_gap: 0 }, '선택지'],
  ['gap 부호 반대(실제−예측)', { calibration_gap: -0.125 }, 'calibration_gap'],
  ['인출에서 읽지 않은 내용 요구', { new_info_in_recall: true }, 'new_info_in_recall'],
  ['완료 수와 미해결 수 불일치', { missions_done: '3/3', missions_unresolved: [2] }, 'missions_done'],
  ['필수 필드 누락', { hint_level: undefined }, '필드 누락'],
  ['hint_level 범위 초과', { hint_level: [0, 4, 0] }, 'hint_level'],
]) {
  test(`실패해야 함: ${name}`, () => {
    const r = run(mutate(patch));
    assert.strictEqual(r.pass, false, r.reason);
    assert.ok(r.reason.includes(expected), `사유에 "${expected}" 포함 기대: ${r.reason}`);
  });
}

test('메타의 condition과 로그의 condition이 다르면 실패한다', () => {
  assert.strictEqual(run(goodA, { condition: 'B' }).pass, false);
});

test('보정 판정 경계: ±0.25 안쪽은 비슷, 바깥은 과대/과소', () => {
  assert.strictEqual(expectedLabel(0.625, 0.667), '비슷');
  assert.strictEqual(expectedLabel(0.875, 0.5), '과대');
  assert.strictEqual(expectedLabel(0.125, 0.5), '과소');
  assert.strictEqual(expectedLabel(0.625, 0.375), null); // 정확히 경계값은 판정하지 않음
});

test('저장된 파일럿 로그(v0.4-chat)는 호환 검사를 통과한다', () => {
  const dir = path.join(__dirname, '..', 'runs');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('pilot-') && f.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const { log } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const r = check(JSON.stringify(log), {});
    assert.strictEqual(r.pass, true, `${f}: ${r.reason}`);
  }
});

test('호환 검사에서도 잘못된 보정 라벨은 잡는다', () => {
  const bad = { prompt_version: 'v0.4-chat', reading_type: '맥락형', missions_done: '3/3', missions_unresolved: [],
    answered_without_hint: 3, answered_with_hint: 0, support_path: [2, 1, 0], recall_done: true,
    recall_prediction: 0.875, recall_actual: 0.25, calibration: '비슷', reading_load: 1 };
  assert.strictEqual(check(JSON.stringify(bad), {}).pass, false);
});
