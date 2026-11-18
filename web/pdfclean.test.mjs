// 실행: node --test web/pdfclean.test.mjs
import test from 'node:test';
import assert from 'node:assert';
import { cleanPages } from './pdfclean.mjs';

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
