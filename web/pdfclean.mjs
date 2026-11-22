// PDF 쪽 텍스트를 읽기 좋은 본문으로 정리한다. 브라우저(app.js)와 node 테스트가 같이 쓴다.
// 입력: pages = [{ h: 쪽 높이, items: [{ s, x, y, eol, h?, w?, font? }], images?: [[x0, y0, x1, y1], ...] }]
//   s: 문자열, x·y: pdf.js getTextContent 항목의 transform[4]·[5], h: 글자 크기(item.height), w: 너비(item.width), font: item.fontName
//   images: 쪽에서 그림이 그려진 영역(imageRectsFromOps). 없으면 그림 영역 제거는 건너뛴다.
// 출력: 쪽별 본문 텍스트 배열. 제목은 HEAD_OPEN…HEAD_CLOSE로 감싸 서버가 독립 문장으로 나누게 한다.
//
// 하는 일 (순서대로)
//   1) 머리말·꼬리말·쪽번호 제거: 쪽의 위 20%·아래 15% 안의 한 줄이 (a) 숫자·기호뿐인 짧은 줄이거나 (b) 숫자를 뺀 글이 여러 쪽에서 반복되면 버린다.
//   2) 본문이 아닌 줄 제거: 그림 영역 안의 글자, 표(칸이 3개 이상인 줄이 3줄 이상 이어짐), 그림·표 캡션(<표 1> [그림 1] Figure 1. …)과 "자료·출처·주:" 줄,
//      쪽 하단의 각주(본문보다 작은 글자), 본문 속 각주 번호(작은 위첨자 1) 2)).
//   3) 제목 감지: 본문(최빈 글자 크기)보다 1.1배 이상 크거나 굵은 짧은 줄. 글자 크기 정보가 없으면 "II. 이론적 배경" 같은 번호 패턴으로 보완한다.
//   4) 줄 잇기: 줄바꿈이 어절 사이인지 어절 중간인지를 같은 문서 안쪽의 글자 쌍으로 학습한 확률로 판정한다(아래 joinDecision).
// 기준 수치(1.1배, 0.92배, 확률 15%)는 정지영 외(2014) 논문 PDF 한 편으로 확인한 값이다. 다른 자료로 계속 점검한다(docs/REVISION_PLAN_2026-11-22.md).
export const HEAD_OPEN = '';
export const HEAD_CLOSE = '';
export const JOIN = ''; // 쪽 텍스트 맨 앞에 붙으면 앞 쪽과 공백 없이 이어진다(쪽 경계에서 어절이 끊긴 경우)

// DB에 저장할 수 없는 문자(NUL, 짝 없는 서로게이트, 제어 문자)를 지운다. 하나라도 남으면 서버 저장이 "unsupported Unicode escape sequence"로 실패한다.
// NUL은 PDF에서 공백 글리프로 나오는 경우가 많아 지우지 않고 공백으로 바꾼다(지우면 줄 끝에서 단어가 붙는다). 줄바꿈·탭은 그대로 둔다. supabase/functions/_shared/core.ts의 stripUnsafe와 같은 규칙이다.
const UNSAFE_CHARS = /\u0000|[\u0001-\u0008\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const stripUnsafe = (s) => String(s ?? '').replace(UNSAFE_CHARS, (m) => (m === '\u0000' ? ' ' : ''));

const TOP = 0.2;
const BOTTOM = 0.15;
const FOOT_ZONE = 0.35; // 쪽 아래쪽 35% 안의 작은 글자 줄을 각주로 본다
const HEAD_RATIO = 1.15;
const SMALL_RATIO = 0.92;
const JOIN_MAX_P = 0.15; // 어절 경계일 확률이 이 값 이하일 때만 줄바꿈을 붙인다

const isHangul = (c) => !!c && /[가-힣]/.test(c);
const trimmed = (items) => items.map((i) => i.s).join('').trim();

/* ---------- 그림 영역 (pdf.js 연산자 목록) ---------- */
// pdf.js의 getOperatorList() 결과(fnArray, argsArray)와 OPS 상수에서 그림이 그려진 사각형을 구한다. 좌표는 글자 항목과 같은 쪽 좌표계다.
const concat = (A, B) => [
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];
export function imageRectsFromOps(fnArray, argsArray, OPS, pageW, pageH) {
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintJpegXObject].filter((x) => x !== undefined));
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const rects = [];
  fnArray.forEach((fn, k) => {
    const a = argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = concat(a, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (a && a[0]) ctm = concat(a[0], ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (IMG.has(fn)) {
      const xs = [], ys = [];
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        xs.push(ctm[0] * u + ctm[2] * v + ctm[4]);
        ys.push(ctm[1] * u + ctm[3] * v + ctm[5]);
      }
      const r = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const w = r[2] - r[0], h = r[3] - r[1];
      if (w < 24 || h < 24) return; // 글머리 기호·장식선
      if (pageW && pageH && w * h > pageW * pageH * 0.85) return; // 쪽 전체 배경 이미지
      rects.push(r);
    }
  });
  return rects;
}

/* ---------- 줄 만들기 ---------- */
function bodySizeOf(pages) {
  const cnt = new Map();
  pages.forEach((pg) => pg.items.forEach((it) => {
    if (!(it.h > 0) || !it.s.trim()) return;
    const k = Math.round(it.h * 2) / 2;
    cnt.set(k, (cnt.get(k) || 0) + it.s.trim().length);
  }));
  let best = null;
  for (const [k, n] of cnt) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] : null;
}

function makeLines(pg, body) {
  const tol = body ? body * 0.5 : 1.5;
  const lines = [];
  let cur = null;
  for (const it of pg.items) {
    const small = body && it.h > 0 && it.h < body * 0.8;
    const same = cur && (Math.abs(it.y - cur.y) <= tol || (small && Math.abs(it.y - cur.y) <= (body || 10)));
    if (!same) {
      cur = { y: it.y, items: [] };
      lines.push(cur);
    }
    cur.items.push(it);
  }
  return lines.map((l) => ({ ...l, text: '', size: 0 }));
}

const lineKey = (items) => items.map((i) => i.s).join('').replace(/[\d\s]/g, '');
const CAPTION = /^\s*(?:[<〈〔\[＜(]\s*(?:그림|표|도표|Figure|Fig\.?|Table|Chart)\s*[\dIVX]+[^>〉〕\])＞)]{0,3}[>〉〕\])＞)]|(?:그림|표|도표|Figure|Fig\.?|Table|Chart)\s*[\dIVX]+\s*[.:：]\s)/i;
const SOURCE_LINE = /^\s*[*※]?\s*(?:자료|출처|주|Source|Note)\s*[:：]/i;
const TERMINAL = /[.!?。다요]\s*$/;

/* ---------- 줄 잇기 모델 ---------- */
// 같은 문서 안쪽(한 줄 안)의 글자 쌍에서 "어절 경계일 확률"을 배운다. 한 줄 안에서는 공백 항목의 유무로 정답이 정해져 있다.
// 앞 글자·뒷 글자·두 글자 쌍·뒤 두 글자의 빈도를 평활화·백오프로 합친다. 외부 사전은 쓰지 않는다.
function trainBoundary(lineTexts) {
  const mAB = new Map(), mA = new Map(), mB = new Map(), mB2 = new Map();
  let nb = 0, n = 0;
  const bump = (m, k, y) => { const v = m.get(k) || [0, 0]; v[y]++; m.set(k, v); };
  for (const raw of lineTexts) {
    const t = raw.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < t.length - 1; i++) {
      let a, b, b2, y;
      if (isHangul(t[i]) && isHangul(t[i + 1])) { a = t[i]; b = t[i + 1]; b2 = t.slice(i + 1, i + 3); y = 0; }
      else if (isHangul(t[i]) && t[i + 1] === ' ' && isHangul(t[i + 2])) { a = t[i]; b = t[i + 2]; b2 = t.slice(i + 2, i + 4); y = 1; }
      else continue;
      bump(mAB, a + b, y); bump(mA, 'a' + a, y); bump(mB, 'b' + b, y); bump(mB2, b2, y);
      n++; nb += y;
    }
  }
  return { mAB, mA, mB, mB2, n, prior: n ? nb / n : 0.26 };
}
const smooth = (m, k, back, w) => { const v = m.get(k) || [0, 0]; return (v[1] + w * back) / (v[0] + v[1] + w); };
export function boundaryProb(model, a, b, b2) {
  const pa = smooth(model.mA, 'a' + a, model.prior, 2);
  const pb = smooth(model.mB, 'b' + b, model.prior, 2);
  const pab = smooth(model.mAB, a + b, (pa + pb) / 2, 3);
  return smooth(model.mB2, b2 || b, pab, 2);
}

// 줄 A 다음에 줄 B가 올 때 사이를 띄울지(true) 붙일지(false). 위에서부터 적용한다.
//   1) A가 문장부호로 끝나면 띄운다.  2) B가 여는 괄호·따옴표·숫자·영문으로 시작하면 띄운다.
//   3) 한글끼리 이어지면 모델 확률로 판정한다: 어절 경계일 확률이 JOIN_MAX_P 이하일 때만 붙이고, 아니면 띄운다(경계를 붙이는 쪽이 읽기에 더 해롭다).
//   4) 문서에 줄 끝 공백이 충분하면(어절 단위로 줄을 바꾸는 PDF) 공백 유무를 그대로 따른다(trustSpaces).
//   5) 영문 하이픈 줄바꿈("exam-" + "ple")은 하이픈을 지우고 붙인다.
export function joinDecision(A, B, model, trustSpaces) {
  const ta = A.replace(/\s+$/, '');
  const a = ta.slice(-1);
  const bt = B.replace(/^\s+/, '');
  const b = bt[0];
  if (!a || !b) return true;
  if (a === '-' && /[a-z]/.test(b) && /[A-Za-z]/.test(ta.slice(-2, -1))) return 'dehyphen';
  if (/[,.)\]}”’!?;:」』。、·…%]/.test(a)) return true;
  if (/[(\[{‘“「『<0-9A-Za-z]/.test(b)) return true;
  if (trustSpaces) return /\s$/.test(A) || /^\s/.test(B);
  if (isHangul(a) && isHangul(b)) return boundaryProb(model, a, b, bt.slice(0, 2)) > JOIN_MAX_P;
  return true;
}

/* ---------- 본문 정리 ---------- */
export function cleanPages(pages) {
  const body = bodySizeOf(pages);
  const need = Math.max(2, Math.min(3, pages.length));

  // 1) 쪽마다 줄로 묶고, 위·아래 여백 안의 줄 글(숫자 제외)이 몇 쪽에서 나오는지 센다.
  const perPage = pages.map((pg) => {
    const lines = makeLines(pg, body);
    const margin = new Map();
    lines.forEach((l, k) => {
      const y = Math.round(l.y);
      if (y > pg.h * (1 - TOP) || y < pg.h * BOTTOM) margin.set(k, { key: lineKey(l.items), text: trimmed(l.items) });
    });
    return { lines, margin };
  });
  const seen = new Map();
  perPage.forEach(({ margin }) => {
    new Set([...margin.values()].map((m) => m.key).filter(Boolean)).forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
  });

  // 2) 쪽마다 본문 줄만 골라 글자·크기를 계산한다.
  const kept = pages.map((pg, i) => {
    const { lines, margin } = perPage[i];
    const images = pg.images || [];
    const inImage = (it) => images.some(([x0, y0, x1, y1]) => {
      const cx = it.x + (it.w || 0) / 2, cy = it.y + (it.h || 0) / 2;
      return cx >= x0 - 2 && cx <= x1 + 2 && cy >= y0 - 2 && cy <= y1 + 2;
    });
    const out = [];
    lines.forEach((l, k) => {
      const m = margin.get(k);
      if (m) {
        const pageNumber = m.key === '' && m.text.length <= 8;
        const repeated = m.key !== '' && (seen.get(m.key) || 0) >= need;
        if (pageNumber || repeated) return;
      }
      const items = l.items.filter((it) => {
        if (inImage(it)) return false;
        // 본문 속 각주 번호: 본문보다 훨씬 작은 위첨자 숫자 (예: 복지¹⁾)
        if (body && it.h > 0 && it.h < body * 0.8 && /^\s*(?:\d{1,2}\)?|[*†‡]+)\s*$/.test(it.s)) return false;
        return true;
      });
      const text = items.map((it) => it.s).join('');
      if (!text.trim()) return;
      const size = Math.max(0, ...items.filter((it) => it.s.trim()).map((it) => it.h || 0));
      out.push({ y: l.y, items, text, size, tab: tabular(items, body) });
    });
    // 표: 칸이 3개 이상인 줄이 3줄 이상 이어지면 그 구간을 지운다.
    for (let a = 0; a < out.length;) {
      if (!out[a].tab) { a++; continue; }
      let b = a;
      while (b < out.length && out[b].tab) b++;
      if (b - a >= 3) out.splice(a, b - a);
      else a = b;
    }
    // 캡션·자료 줄과 그 이어지는 줄, 쪽 하단 각주
    // 본문보다 작은 글자 줄(0.92배 이하)은 둘 중 하나로 가른다. 면담 인용문·초록처럼 작은 글자의 본문도 있어서 글자 크기만으로 지우지 않는다.
    //   각주: 쪽 아래쪽에서 "1) …" "* …"로 시작하는 작은 줄부터 쪽 끝까지(이어지는 작은 줄 포함).
    //   표: 작은 글자가 3줄 이상 이어지고 줄이 짧거나(평균이 본문 줄의 0.6배 미만) 칸이 갈라진 줄이 40% 이상.
    const typical = median(out.filter((l) => !(body && l.size > 0 && l.size <= body * SMALL_RATIO)).map((l) => l.text.trim().length)) || 40;
    const isSmall = out.map((l) => !!body && l.size > 0 && l.size <= body * SMALL_RATIO);
    const dropAt = new Set();
    const fnAt = out.findIndex((l, k) => isSmall[k] && l.y < pg.h * FOOT_ZONE && footnoteStart(l.text.trim()));
    if (fnAt >= 0) for (let k = fnAt; k < out.length; k++) if (isSmall[k]) dropAt.add(k);
    for (let a = 0; a < out.length;) {
      if (!isSmall[a]) { a++; continue; }
      let b = a;
      while (b < out.length && isSmall[b]) b++;
      const run = out.slice(a, b);
      const avg = run.reduce((n, l) => n + l.text.trim().length, 0) / run.length;
      const split = run.filter((l) => cellCount(l.items, body) >= 2).length / run.length;
      if (run.length >= 3 && (avg < typical * 0.6 || split >= 0.4)) for (let c = a; c < b; c++) dropAt.add(c);
      a = b;
    }
    const res = [];
    for (let k = 0; k < out.length; k++) {
      const l = out[k];
      const t = l.text.trim();
      if (dropAt.has(k)) continue;
      if (!body && footnoteStart(t) && l.y < pg.h * 0.25) { // 글자 크기 정보가 없을 때: 아래쪽에서 "1) …"로 시작하는 줄부터 쪽 끝까지
        while (k < out.length) k++;
        break;
      }
      if (CAPTION.test(t) || SOURCE_LINE.test(t)) {
        while (!TERMINAL.test(out[k].text) && k + 1 < out.length && out[k + 1].text.trim().length < typical * 0.7 && out[k].y - out[k + 1].y < (body || 10) * 2) k++; // 여러 줄 캡션의 이어지는 줄
        continue;
      }
      res.push(l);
    }
    return res;
  });

  // 3) 제목을 정한다. 본문보다 크거나 굵은 짧은 줄. 글자 크기 정보가 없으면 번호 패턴으로 보완한다.
  const anyBySize = kept.some((ls) => ls.some((l) => isHeadBySize(l, body)));
  kept.forEach((ls) => ls.forEach((l, k) => {
    const t = l.text.trim();
    l.head = isHeadBySize(l, body) || (!anyBySize && isHeadByPattern(t, ls[k - 1]?.text));
  }));

  // 4) 줄 잇기 모델 학습: 한 줄 안의 한글 쌍(공백 항목 유무가 정답)
  const allLines = kept.flat();
  const model = trainBoundary(allLines.map((l) => l.text));
  const ends = allLines.filter((l) => /\s$/.test(l.text)).length;
  const trustSpaces = allLines.length >= 30 && ends / allLines.length >= 0.5;

  // 5) 쪽별로 줄을 이어 붙인다. 쪽 경계의 줄바꿈도 같은 규칙으로 판정해 붙이면 다음 쪽 맨 앞에 JOIN을 둔다.
  const norm = (x) => x.replace(/\s+/g, ' ').trim();
  const blocksOf = (ls) => {
    const out = [];
    let k = 0;
    while (k < ls.length) {
      const l = ls[k];
      if (l.head) { // 연달아 제목인 줄은 한 제목으로 묶는다(두 줄로 넘어간 제목)
        let text = norm(l.text);
        let j = k + 1;
        while (j < ls.length && ls[j].head && Math.abs(ls[j].size - l.size) < 0.6) { text += ' ' + norm(ls[j].text); j++; }
        out.push({ text: HEAD_OPEN + text + HEAD_CLOSE, head: true, raw: l.text });
        k = j;
      } else {
        out.push({ text: norm(l.text), head: false, raw: l.text });
        k++;
      }
    }
    return out;
  };
  let prev = null;
  return kept.map((ls) => {
    let t = '';
    let startJoin = false;
    for (const b of blocksOf(ls)) {
      if (prev === null) t = b.text;
      else {
        const d = prev.head || b.head ? true : joinDecision(prev.raw, b.raw, model, trustSpaces);
        if (!t) { startJoin = d === false; t = b.text; }
        else if (d === 'dehyphen') t = t.replace(/-\s*$/, '') + b.text;
        else t += (d ? ' ' : '') + b.text;
      }
      prev = b;
    }
    return (startJoin ? JOIN : '') + t;
  });
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
// 칸이 3개 이상(칸 사이 간격이 글자 크기의 2배를 넘는 항목 덩어리)이면 표의 줄로 본다. 항목 너비가 없으면 판단하지 않는다.
function cellCount(items, body) {
  const its = items.filter((i) => i.s.trim() && i.w > 0).sort((a, b) => a.x - b.x);
  if (its.length < 2) return 1;
  const em = body || 10;
  let cells = 1;
  for (let k = 1; k < its.length; k++) if (its[k].x - (its[k - 1].x + its[k - 1].w) > em * 2) cells++;
  return cells;
}
const tabular = (items, body) => cellCount(items, body) >= 3;
const footnoteStart = (t) => /^\d{1,2}\)\s*\S/.test(t) || /^[*†‡]\s*\S/.test(t);
const BOLD = /bold|black|heavy|semibold|-bd|_bd/i;
function isHeadBySize(l, body) {
  const t = l.text.trim();
  if (!t || t.length > 80 || /[.!?。]$/.test(t) || CAPTION.test(t)) return false;
  if (body && l.size >= body * HEAD_RATIO) return true;
  const fonts = l.items.filter((i) => i.s.trim()).map((i) => i.font || '');
  return t.length <= 60 && fonts.length > 0 && fonts.every((f) => BOLD.test(f));
}
// 글자 크기·굵기를 알 수 없는 PDF: "II. 이론적 배경", "3. 연구 방법", "제2장 …", 짧고 마침표가 없으며 앞 줄이 문장으로 끝났거나 쪽의 첫 줄일 때만.
function isHeadByPattern(t, prevText) {
  if (t.length > 35 || /[.!?。다요]$/.test(t)) return false;
  if (!/^(?:(?:[IVX]{1,5}|\d{1,2}(?:\.\d{1,2})*|[가나다라마바사아자차카타파하])\s*[.)]\s*\S|제\s?\d+\s?[장절편])/.test(t)) return false;
  return prevText === undefined || /[.!?。다요)]\s*$/.test(prevText);
}
