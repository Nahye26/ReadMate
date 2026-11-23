// 실행: node --test web/pdfclean.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { cleanPages, stripUnsafe } from './pdfclean.mjs';

const H = 842;
const it = (s, y, x = 0, eol = true) => ({ s, x, y, eol });
// 머리말(y=707), 쪽번호(y=100), 본문(y=600~)
const page = (header, no, body) => ({ h: H, items: [it(header, 707), it('━━━━━', 699), it(String(no), 101), ...body.map((b, k) => it(b, 600 - k * 17))] });

test('머리말·구분선·쪽번호를 걷어 내고 본문은 남긴다', () => {
  const pages = [
    page('문화예술교육연구 (제9권 제3호)', 63, ['첫째 쪽 본문입니다.', '둘째 줄입니다.']),
    page('사례연구: 녹명윈드오케스트라', 64, ['셋째 쪽 본문입니다.']),
    page('문화예술교육연구 (제9권 제3호)', 65, ['다섯째 쪽 본문입니다.']),
    page('사례연구: 녹명윈드오케스트라', 66, ['여섯째 쪽 본문입니다.']),
    page('문화예술교육연구 (제9권 제3호)', 67, ['일곱째 쪽 본문입니다.']),
    page('사례연구: 녹명윈드오케스트라', 68, ['여덟째 쪽 본문입니다.']),
    page('문화예술교육연구 (제9권 제3호)', 69, ['아홉째 쪽 본문입니다.']),
  ];
  const out = cleanPages(pages);
  assert.ok(out.every((t) => !/문화예술교육연구|사례연구|━|^\d+ /.test(t)));
  assert.ok(out[0].includes('첫째 쪽 본문입니다.') && out[0].includes('둘째 줄입니다.'));
  assert.ok(out.every((t) => !/\b6[3-9]\b/.test(t)));
});

test('위쪽에 가까운 본문 첫 줄은 반복되지 않으면 지우지 않는다', () => {
  const firsts = ['가나다 첫 줄입니다.', '라마바 첫 줄입니다.', '사아자 첫 줄입니다.', '차카타 첫 줄입니다.'];
  const pages = firsts.map((f, n) => ({ h: H, items: [it(f, 700), it('머리말 반복', 707), it(String(n + 1), 100)] }));
  const out = cleanPages(pages);
  out.forEach((t, i) => { assert.ok(t.includes(firsts[i])); assert.ok(!t.includes('머리말 반복')); });
});

test('쪽이 적을 때(2쪽)는 쪽번호만 지우고 한 번 나온 줄은 남긴다', () => {
  const out = cleanPages([page('논문 제목', 1, ['본문 하나.']), page('논문 제목', 2, ['본문 둘.'])]);
  assert.ok(out.every((t) => !/^\d/.test(t.trim())));
  assert.ok(out.every((t) => !t.includes('논문 제목'))); // 2쪽 모두에서 반복되므로 머리말로 본다
});

/* ---------- 본문 정리(2026-11-23) ---------- */
import { HEAD_OPEN, HEAD_CLOSE, JOIN, imageRectsFromOps, joinDecision, boundaryProb } from './pdfclean.mjs';

// 글자 크기·너비를 가진 항목. 본문 10, 제목 14, 각주 9
const t = (s, y, o = {}) => ({ s, x: o.x ?? 100, y, eol: true, h: o.h ?? 10, w: o.w ?? s.length * 8, font: o.font ?? 'f1' });
const mk = (items) => ({ h: H, items });
const body = (n, y0 = 600) => Array.from({ length: n }, (_, k) => t(`본문 문장이 이렇게 한 줄씩 이어집니다 ${k}.`, y0 - k * 17));

test('캡션·자료 줄과 본문 속 "표 1에서"는 구분한다', () => {
  const out = cleanPages([mk([...body(3), t('<표 1> 심층면담 참여자 정보', 500), t('자료: 연구자 작성', 480), t('표 1에서 보듯 참여자는 열 명이다.', 460), t('그림 2. 운영 모형', 440), ...body(2, 420)])]);
  const s = out[0];
  assert.ok(!s.includes('<표 1>') && !s.includes('자료: 연구자') && !s.includes('그림 2.'));
  assert.ok(s.includes('표 1에서 보듯 참여자는 열 명이다.')); // 본문 문장은 남긴다
});

test('그림 영역 안의 글자는 지우고 영역 밖 본문은 남긴다', () => {
  const pg = mk([...body(2), t('축 라벨', 400, { x: 200 }), t('영역 밖 본문입니다.', 300)]);
  pg.images = [[150, 380, 400, 520]];
  const s = cleanPages([pg])[0];
  assert.ok(!s.includes('축 라벨') && s.includes('영역 밖 본문입니다.'));
});

test('imageRectsFromOps: 변환 행렬을 따라 그림 사각형을 구하고 작은 그림·전면 배경은 거른다', () => {
  const OPS = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6 };
  const fn = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.transform, OPS.paintImageXObject];
  const args = [null, [200, 0, 0, 100, 50, 300], 'img1', null, null, [10, 0, 0, 10, 0, 0], 'tiny', null, [600, 0, 0, 800, 0, 0], 'bg'];
  const rects = imageRectsFromOps(fn, args, OPS, 612, 842);
  assert.deepStrictEqual(rects, [[50, 300, 250, 400]]); // 작은 그림(10x10)과 쪽 전체 배경(600x800)은 뺀다
});

test('쪽 아래의 각주와 본문 속 위첨자 번호를 지운다. 작은 글자의 인용문은 남긴다', () => {
  const quote = [t('A: 저는 이 활동이 정말 좋았어요.', 400, { h: 9 }), t('B: 저도 그렇게 생각해요 선생님.', 383, { h: 9 })];
  const out = cleanPages([mk([
    ...body(2), t('복지', 480, { x: 100, w: 16 }), { ...t('1)', 484, { x: 116, h: 7.4, w: 10 }) }, t('의 차원이다.', 480, { x: 126 }),
    ...quote, ...body(2, 300),
    t('1) 문화 복지란 국민의 삶의 질을 높이는 것이다.', 150, { h: 9 }), t('이어지는 각주 줄이다.', 133, { h: 9 }),
  ])]);
  const s = out[0];
  assert.ok(s.includes('복지 의 차원이다.') || s.includes('복지의 차원이다.') || /복지.{0,2}의 차원이다\./.test(s));
  assert.ok(!/복지\s?1\)/.test(s));
  assert.ok(!s.includes('문화 복지란') && !s.includes('이어지는 각주'));
  assert.ok(s.includes('A: 저는 이 활동이 정말 좋았어요.')); // 쪽 가운데의 작은 글자 인용문은 각주가 아니다
});

test('표: 짧은 작은 글자 줄이 3줄 이상 이어지면 지운다', () => {
  const cell = (s, y) => t(s, y, { h: 9, w: 30 });
  const out = cleanPages([mk([...body(3), cell('참여자', 500), cell('담당', 483), cell('경력', 466), cell('교사', 449), ...body(2, 420)])]);
  assert.ok(!/참여자|담당|경력|교사/.test(out[0]));
});

test('제목: 본문보다 큰 짧은 줄은 HEAD 표시로 감싼다. 마침표로 끝나는 큰 글자는 제목이 아니다', () => {
  const out = cleanPages([mk([t('II. 이론적 배경', 700, { h: 14 }), ...body(3, 660), t('큰 글자로 끝나는 문장이다.', 560, { h: 14 }), ...body(2, 520)])]);
  assert.ok(out[0].includes(HEAD_OPEN + 'II. 이론적 배경' + HEAD_CLOSE));
  assert.ok(!out[0].includes(HEAD_OPEN + '큰 글자로'));
});

test('제목: 글자 크기를 모르는 PDF는 번호 패턴과 앞 줄 마침표로 보완한다', () => {
  const nosize = (s, y) => ({ s, x: 100, y, eol: true });
  const out = cleanPages([{ h: H, items: [nosize('첫 문단이 여기서 끝난다.', 600), nosize('2. 연구 방법', 583), nosize('다음 문단이 시작된다.', 566)] }]);
  assert.ok(out[0].includes(HEAD_OPEN + '2. 연구 방법' + HEAD_CLOSE));
});

test('줄 잇기: 문장부호·괄호·숫자 앞은 띄우고, 영문 하이픈 줄바꿈은 붙인다', () => {
  const model = { mAB: new Map(), mA: new Map(), mB: new Map(), mB2: new Map(), n: 0, prior: 0.26 };
  assert.strictEqual(joinDecision('이렇게 끝난다.', '다음 줄', model, false), true);
  assert.strictEqual(joinDecision('앞 줄이다', '(김철수, 2021)', model, false), true);
  assert.strictEqual(joinDecision('앞 줄이다', '2021년', model, false), true);
  assert.strictEqual(joinDecision('exam-', 'ple text', model, false), 'dehyphen');
  // 학습한 것이 없으면 한글끼리는 띄운다(경계를 붙이는 오류가 더 해롭다)
  assert.strictEqual(joinDecision('교', '육', model, false), true);
  // 줄 끝 공백이 충분한 문서는 공백 유무를 그대로 따른다
  assert.strictEqual(joinDecision('조화로운 ', '인간', model, true), true);
  assert.strictEqual(joinDecision('조화로운', '인간', model, true), false);
});

test('줄 잇기: 같은 문서 안쪽 줄에서 배운 어절 경계 확률로 어절 중간 줄바꿈은 붙이고 어절 경계는 띄운다', () => {
  // 문서 안쪽에서 '교육'은 늘 붙어 있고(교+육), '목표를' 뒤에는 늘 띄어 쓴다
  const inner = Array.from({ length: 30 }, (_, k) => t('문화예술교육을 통해 교육적 목표를 이룬다 ' + k + '.', 640 - k * 12));
  const out = cleanPages([mk([
    ...inner,
    t('이 사업은 문화예술교', 270), t('육을 통해 목표를', 258), t('이룬다고 본다.', 246),
  ])]);
  assert.ok(out[0].includes('이 사업은 문화예술교육을 통해 목표를 이룬다고 본다.'), out[0].slice(-80));
});

test('쪽 경계에서 어절 중간이 끊기면 다음 쪽 맨 앞에 JOIN을 둔다', () => {
  const inner = Array.from({ length: 30 }, (_, k) => t('문화예술교육을 통해 교육적 목표를 이룬다 ' + k + '.', 640 - k * 12));
  const p1 = mk([...inner, t('이 사업은 문화예술교', 270)]);
  const p2 = mk([t('육을 통해 이루어진다.', 600)]);
  const out = cleanPages([p1, p2]);
  assert.ok(out[1].startsWith(JOIN), JSON.stringify(out[1]));
  assert.ok(boundaryProb !== undefined);
});

test('stripUnsafe: NUL·제어 문자·짝 없는 서로게이트를 지우고 정상 글자는 둔다', () => {
  assert.equal(stripUnsafe('교\u0001육'), '교육');
  assert.equal(stripUnsafe('aims\u0000to'), 'aims to');
  assert.equal(stripUnsafe('가\uD800나\uDC00다'), '가나다');
  assert.equal(stripUnsafe('😀 a\tb\n'), '😀 a\tb\n');
  assert.equal(stripUnsafe(undefined), '');
});

test('뒤쪽의 "참고문헌" 제목부터 끝까지 지우고, 앞쪽(목차)의 같은 글자는 남긴다', () => {
  const p1 = mk([t('참고문헌 1', 700), ...body(6, 600)]);
  const p2 = mk([...body(8, 600), t('【참고문헌】', 400, { h: 14 }), t('김도희 (2022). 갤러리 오픈런. 인문사회 21, 13(4), 79-94.', 380), t('윤소정 (2021). 팬덤의 웨이브 이론. 인문사회 21, 12(4).', 360)]);
  const p3 = mk([t('박OO (2020). 또 다른 문헌. 학술지, 1(1), 1-10.', 600)]);
  const out = cleanPages([p1, p2, p3]);
  const all = out.join('\n');
  assert.ok(!/김도희 \(2022\)|윤소정 \(2021\)|박OO/.test(all));
  assert.ok(!/【참고문헌】/.test(all));
  assert.ok(/참고문헌 1/.test(out[0]));
  assert.ok(/본문 문장이 이렇게/.test(out[1]));
});
