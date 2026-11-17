// promptfoo 프롬프트 함수: readmate_prompt_v0.5.md의 프롬프트 본문을 꺼내 입력값을 채우고,
// 테스트별 대화 이력(history)을 이어 붙여 chat 메시지 배열로 돌려준다.
const fs = require('fs');
const path = require('path');

const START = '=== 프롬프트 시작 ===';
const END = '=== 프롬프트 끝 ===';

// 프롬프트 파일의 입력 자리표시자 -> 테스트 변수
const SLOTS = [
  ['{학습자의 과제 설명}', 'TASK'],
  ['{읽기 자료 전문 또는 장/절 단위 텍스트}', 'SOURCE'],
  ['{A 또는 B}', 'CONDITION'],
  ['{미션 3개의 질문과 순서, 유형. 미리 고정된 세트}', 'QUESTION_SET'],
  ['{미션당 제공 텍스트의 상한. 단위와 값은 시행 전에 정함}', 'MAX_TEXT_UNITS'],
  ['{off 기본값. on이면 A/B 양쪽 모두 같은 형태로 제공}', 'FLOW_MAP'],
];

const DEFAULTS = {
  MAX_TEXT_UNITS: '미션당 청크 3개 이하. 조건 A는 핵심 청크 안 1~3문장, 조건 B는 핵심 청크 + 앞 1개 + 뒤 1개(같은 절 안에서만). 실험 중 예외 없음.',
  FLOW_MAP: 'off',
};

function buildSystemPrompt(vars) {
  const raw = fs.readFileSync(path.join(__dirname, 'prompts', 'readmate_prompt_v0.5.md'), 'utf8');
  const s = raw.indexOf(START);
  const e = raw.indexOf(END);
  if (s < 0 || e < 0) throw new Error('프롬프트 시작/끝 마커를 찾지 못했습니다.');
  let body = raw.slice(s + START.length, e).trim();

  for (const [slot, key] of SLOTS) {
    if (!body.includes(slot)) throw new Error(`자리표시자 없음: ${slot}`);
    const value = vars[key] ?? DEFAULTS[key];
    if (value === undefined) throw new Error(`변수 누락: ${key}`);
    body = body.split(slot).join(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  return body;
}

module.exports = function ({ vars }) {
  const history = vars.history || [{ role: 'user', content: '시작할게요.' }];
  return [{ role: 'system', content: buildSystemPrompt(vars) }, ...history];
};

module.exports.buildSystemPrompt = buildSystemPrompt;
