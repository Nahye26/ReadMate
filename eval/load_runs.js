// runs/*.json 을 promptfoo 테스트로 불러온다. (기록-재생: 모델 호출 없음)
// 파일 형식은 eval/README.md 참고. "_"로 시작하는 파일은 건너뛴다.
const fs = require('fs');
const path = require('path');

module.exports = function loadRuns() {
  const dir = path.join(__dirname, 'runs');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => {
      const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const meta = run.meta || {};
      return {
        description: `${f.replace(/\.json$/, '')} (${meta.source || '?'} / ${meta.model || '?'} / 조건 ${meta.condition ?? '미지정'})`,
        vars: {
          run_id: meta.run_id || f,
          condition: meta.condition ?? '',
          log_json: JSON.stringify(run.log),
        },
        assert: [{ type: 'javascript', value: 'file://checks/check_log.js' }],
      };
    });
};
