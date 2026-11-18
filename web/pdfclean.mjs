// PDF 쪽 텍스트에서 머리말·꼬리말·쪽번호를 걷어 낸다. 브라우저(app.js)와 node 테스트가 같이 쓴다.
// 입력: pages = [{ h: 쪽 높이, items: [{ s: 문자열, x, y, eol }] }]  (pdf.js getTextContent 항목의 transform[4], transform[5])
// 출력: 쪽별 본문 텍스트 배열.
// 기준: 쪽의 위 20%·아래 15% 안의 한 줄이 (a) 숫자·기호뿐인 짧은 줄(쪽번호)이거나 (b) 숫자를 뺀 글이 여러 쪽에서 반복되면 머리말·꼬리말로 보고 버린다.
// 반복을 함께 보므로 본문 첫 줄이 위쪽에 가까워도 지워지지 않는다. 쪽이 2~3개뿐이면 반복 기준을 낮춘다.
const TOP = 0.2;
const BOTTOM = 0.15;

const lineKey = (items) => items.slice().sort((a, b) => a.x - b.x).map((i) => i.s).join('').replace(/[\d\s]/g, '');
const lineText = (items) => items.slice().sort((a, b) => a.x - b.x).map((i) => i.s).join('').trim();

export function cleanPages(pages) {
  const need = Math.max(2, Math.min(3, pages.length));
  // 1) 쪽마다 줄(같은 y)로 묶고, 위·아래 여백 안의 줄을 모은다.
  const perPage = pages.map((pg) => {
    const lines = new Map();
    pg.items.forEach((it) => {
      const y = Math.round(it.y);
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push(it);
    });
    const margin = new Map(); // y -> { key, text }
    for (const [y, items] of lines) {
      if (y > pg.h * (1 - TOP) || y < pg.h * BOTTOM) margin.set(y, { key: lineKey(items), text: lineText(items) });
    }
    return { lines, margin };
  });
  // 2) 여백 줄의 글(숫자 제외)이 몇 쪽에서 나오는지 센다.
  const seen = new Map();
  perPage.forEach(({ margin }) => {
    new Set([...margin.values()].map((m) => m.key).filter(Boolean)).forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
  });
  // 3) 버릴 줄을 정하고, 남은 항목을 원래 순서대로 이어 붙인다.
  return pages.map((pg, i) => {
    const drop = new Set();
    for (const [y, m] of perPage[i].margin) {
      const pageNumber = m.key === '' && m.text.length <= 8; // 숫자·공백뿐인 짧은 줄
      const repeated = m.key !== '' && (seen.get(m.key) || 0) >= need;
      if (pageNumber || repeated) drop.add(y);
    }
    let t = '';
    pg.items.forEach((it) => {
      if (drop.has(Math.round(it.y))) return;
      t += it.s;
      if (it.eol) t += ' ';
    });
    return t;
  });
}
