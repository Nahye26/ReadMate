// ReadMate 세션 로그 검사기 (규칙 기반, API 키 불필요)
// - v0.5 로그: 엄격 검사 (A/B 실험용)
// - v0.4 / v0.4-chat 로그: 느슨한 검사 (과거 시행 로그 호환)
// promptfoo에서는 module.exports 함수로, 단위 테스트에서는 check()로 쓴다.

const JOL = [0.125, 0.375, 0.625, 0.875]; // 앱의 회상 예측 선택지
const THRESH = 0.25; // 앱의 보정 판정 기준: 예측 − 실제
const EPS = 0.011; // recall_actual이 소수 둘째 자리로 반올림되는 점을 감안한 허용 오차
const READING = { A: '발췌형', B: '맥락형' };

const V05_REQUIRED = [
  'prompt_version', 'model', 'condition', 'paper_id', 'reading_type', 'support_path',
  'text_units_provided', 'missions_done', 'missions_unresolved', 'answered_without_hint',
  'answered_with_hint', 'hint_level', 'question_path', 'context_sufficient', 'context_used',
  'evidence_cited', 'activity_type', 'recall_per_mission', 'new_info_in_recall', 'recall_done',
  'recall_prediction', 'recall_actual', 'calibration', 'calibration_gap', 'self_corrections',
  'reading_load', 'exit_reason',
];
const LEGACY_REQUIRED = [
  'prompt_version', 'reading_type', 'missions_done', 'missions_unresolved',
  'answered_without_hint', 'answered_with_hint', 'support_path', 'recall_done',
  'recall_prediction', 'recall_actual', 'calibration', 'reading_load',
];

function extractJson(output) {
  const fenced = output.match(/```json\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  return JSON.parse(text);
}

function expectedLabel(pred, actual) {
  const d = pred - actual;
  if (Math.abs(Math.abs(d) - THRESH) < EPS) return null; // 경계값은 판정하지 않음
  return d > THRESH ? '과대' : d < -THRESH ? '과소' : '비슷';
}

function check(output, vars = {}) {
  let log;
  try {
    log = extractJson(output);
  } catch (err) {
    return { pass: false, score: 0, reason: `JSON 파싱 실패: ${err.message}` };
  }

  const strict = log.prompt_version === 'v0.5-chat' || log.prompt_version === 'v0.5';
  const problems = [];

  for (const k of strict ? V05_REQUIRED : LEGACY_REQUIRED) {
    if (!(k in log)) problems.push(`필드 누락: ${k}`);
  }

  // 공통: 미션 수 일관성 (완료 = 전체 − 미해결)
  const m = /^(\d+)\/(\d+)$/.exec(String(log.missions_done ?? ''));
  if (m && Array.isArray(log.missions_unresolved)) {
    const [done, total] = [Number(m[1]), Number(m[2])];
    if (done !== total - log.missions_unresolved.length) {
      problems.push(`missions_done(${log.missions_done})와 missions_unresolved(${log.missions_unresolved.length}건)가 맞지 않음`);
    }
    if (Number.isInteger(log.answered_without_hint) && Number.isInteger(log.answered_with_hint)
      && log.answered_without_hint + log.answered_with_hint > total) {
      problems.push('힌트 없이/힌트 응답 합이 미션 수를 넘음');
    }
  } else if ('missions_done' in log) {
    problems.push('missions_done 형식이 "완료/전체"가 아님');
  }

  // 공통: 안내 수준 값, 회상 예측 선택지, 보정 판정
  if (Array.isArray(log.support_path) && log.support_path.some((v) => ![0, 1, 2].includes(v))) {
    problems.push('support_path 값이 0~2 범위를 벗어남');
  }
  const p = log.recall_prediction;
  const a = log.recall_actual;
  if (p != null && !JOL.includes(p)) problems.push(`recall_prediction이 선택지(${JOL.join('/')})에 없음: ${p}`);
  if (typeof p === 'number' && typeof a === 'number') {
    if (a < 0 || a > 1) problems.push('recall_actual이 0~1 범위를 벗어남');
    const want = expectedLabel(p, a);
    if (want && log.calibration !== want) {
      problems.push(`calibration 판정 오류: 기대 ${want}(예측−실제=${(p - a).toFixed(3)}), 실제 ${log.calibration}`);
    }
    if (strict && typeof log.calibration_gap === 'number' && Math.abs(log.calibration_gap - (p - a)) > EPS) {
      problems.push(`calibration_gap 계산 오류: 기대 ${(p - a).toFixed(3)}, 실제 ${log.calibration_gap}`);
    }
  }

  if (strict) {
    if (!['A', 'B'].includes(log.condition)) problems.push('condition이 A/B가 아님');
    if (vars.condition && log.condition !== vars.condition) {
      problems.push(`condition 불일치: 로그 ${log.condition} / 메타 ${vars.condition}`);
    }
    if (READING[log.condition] && log.reading_type !== READING[log.condition]) {
      problems.push(`reading_type 불일치: 조건 ${log.condition}이면 ${READING[log.condition]}`);
    }
    if (Array.isArray(log.support_path) && log.support_path.some((v) => v !== 2)) {
      problems.push('실험 모드에서는 support_path가 모두 2여야 함(페이딩 꺼짐)');
    }
    if (log.new_info_in_recall !== false) problems.push('new_info_in_recall이 false가 아님');
    for (const k of ['hint_level', 'question_path', 'context_sufficient', 'text_units_provided', 'support_path']) {
      if (Array.isArray(log[k]) && log[k].length !== 3) problems.push(`${k} 길이가 3이 아님`);
    }
    if (Array.isArray(log.hint_level) && log.hint_level.some((v) => ![0, 1, 2, 3].includes(v))) {
      problems.push('hint_level 값이 0~3 범위를 벗어남');
    }
  }

  return problems.length
    ? { pass: false, score: 0, reason: problems.join(' / ') }
    : { pass: true, score: 1, reason: `${strict ? 'v0.5 엄격' : '호환'} 검사 통과` };
}

module.exports = (output, context) => check(output, (context && context.vars) || {});
module.exports.check = check;
module.exports.expectedLabel = expectedLabel;
