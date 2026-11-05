// runs/*.json 을 조건·모델별로 집계하고, 같은 논문의 A/B 쌍을 비교한다.
//   실행: node aggregate.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'runs');
const runs = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const fmt = (v, d = 2) => (v == null ? '-' : v.toFixed(d));

function metrics(run) {
  const log = run.log || {};
  const m = /^(\d+)\/(\d+)$/.exec(String(log.missions_done ?? ''));
  const total = m ? Number(m[2]) : null;
  const done = m ? Number(m[1]) : null;
  const pred = num(log.recall_prediction);
  const actual = num(log.recall_actual);
  return {
    completion: total ? done / total : null,
    noHintRate: total && num(log.answered_without_hint) != null ? log.answered_without_hint / total : null,
    gap: pred != null && actual != null ? pred - actual : null, // 양수 = 과대
    actual,
    load: num(log.reading_load),
    calibration: log.calibration ?? null,
  };
}

const keyOf = (r) => `${(r.meta || {}).condition ?? '미지정'} / ${(r.meta || {}).model || (r.log || {}).model || '?'}`;
const groups = new Map();
for (const r of runs) {
  const k = keyOf(r);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(metrics(r));
}

console.log('## 조건 | 모델별 집계\n');
console.log('| 조건 / 모델 | n | 미션 완료율 | 힌트 없이 정답률 | 회상 실제(평균) | 예측−실제(평균) | 과대/비슷/과소 | 읽기 부담(평균) |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [k, ms] of [...groups].sort()) {
  const cal = (l) => ms.filter((x) => x.calibration === l).length;
  console.log(
    `| ${k} | ${ms.length} | ${fmt(mean(ms.map((x) => x.completion).filter((x) => x != null)))} | ` +
      `${fmt(mean(ms.map((x) => x.noHintRate).filter((x) => x != null)))} | ` +
      `${fmt(mean(ms.map((x) => x.actual).filter((x) => x != null)))} | ` +
      `${fmt(mean(ms.map((x) => x.gap).filter((x) => x != null)), 3)} | ` +
      `${cal('과대')}/${cal('비슷')}/${cal('과소')} | ` +
      `${fmt(mean(ms.map((x) => x.load).filter((x) => x != null)), 1)} |`,
  );
}

// 같은 논문·같은 모델에서 A/B가 모두 있는 쌍
const byPaper = new Map();
for (const r of runs) {
  const meta = r.meta || {};
  if (!['A', 'B'].includes(meta.condition) || !meta.paper_id) continue;
  const k = `${meta.paper_id} / ${meta.model || '?'}`;
  if (!byPaper.has(k)) byPaper.set(k, {});
  (byPaper.get(k)[meta.condition] ||= []).push(metrics(r));
}
const pairs = [...byPaper].filter(([, v]) => v.A && v.B);
console.log('\n## 같은 논문 A/B 쌍 (B − A)\n');
if (!pairs.length) {
  console.log('A/B 쌍이 아직 없습니다. meta.condition(A/B)과 meta.paper_id가 있는 run이 쌍으로 모이면 표시됩니다.');
} else {
  console.log('| 논문 / 모델 | 완료율 차 | 힌트 없이 정답률 차 | 회상 실제 차 |');
  console.log('|---|---|---|---|');
  const d = (key) => {
    return (v) => {
      const a = mean(v.A.map((x) => x[key]).filter((x) => x != null));
      const b = mean(v.B.map((x) => x[key]).filter((x) => x != null));
      return a == null || b == null ? null : b - a;
    };
  };
  for (const [k, v] of pairs) {
    console.log(`| ${k} | ${fmt(d('completion')(v), 2)} | ${fmt(d('noHintRate')(v), 2)} | ${fmt(d('actual')(v), 2)} |`);
  }
}
