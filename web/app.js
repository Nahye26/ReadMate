// ReadMate 웹앱 (사용성 테스트용, 조건 B 고정). 빌드 없이 정적 파일로 배포한다.
// 서버 함수: ingest-source → plan-session → submit-answer / report-question → recall → connect → finish-session
// 서버가 상태의 기준이다(진행 순서, 힌트·보완 횟수, 다음 안내 수준). 이 파일은 화면과 호출만 맡는다.
// 새로고침하면 화면 상태는 사라진다(서버에 세션을 다시 불러오는 함수는 아직 없다).
import { SUPABASE_URL, SUPABASE_ANON_KEY, CONDITION, PAPERS } from './config.js';
import { cleanPages, imageRectsFromOps, stripUnsafe, HEAD_OPEN, HEAD_CLOSE } from './pdfclean.mjs';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
const MAX_PAGES = 40;
const QLABEL = { literal: '이해', inferential: '추론', evaluative: '평가' };
// 질문 단계(학습자가 고르지 않는다. 과제 요구 항목의 유형과 앞 미션 결과로 서버가 정한다)
const LEVEL_LABEL = { literal: '1단계 · 정리', inferential: '2단계 · 추론', evaluative: '3단계 · 평가' };
const REQ_TYPE_LABEL = { info: '정보 정리', analysis: '분석·설명', opinion: '의견·평가' };
const evidenceMin = () => {
  const m = S.plan.missions[S.mi];
  const n = m.excerpts.reduce((c, e) => c + e.sentences.length - (e.heads || []).filter((h) => h >= (e.from || 1) && h < (e.from || 1) + e.sentences.length).length, 0);
  return S.plan.lazy ? Math.max(1, Math.min(2, n)) : 0; // 사용성 테스트(lazy)는 근거 문장 필수(2개 이상)
};
const HINT_NAME = { 1: '1단계 · 관점', 2: '2단계 · 위치', 3: '3단계 · 구조' };
const JOL_LABEL = { 0.125: '거의 못 떠올려요', 0.375: '일부만 떠올려요', 0.625: '대부분 떠올려요', 0.875: '거의 다 떠올려요' };
const EXIT_REASONS = ['너무 어려워요', '시간이 없어요', '내용이 과제와 맞지 않아요', '기타'];

const sb = SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const S = {
  screen: 'start', assignment: '', file: null, source: null, paperKey: null, // source: {id, title, pages, shared}. paperKey: 목록에서 고른 자료의 key('upload'이면 PDF 직접 올리기)
  consentResearch: false, consentAnswers: false,
  plan: null, mi: 0, support: null, qtype: null, rec: [], ui: null,
  recallRes: null, recallStage: null, connect: null, connectOffered: false, load: 0, finished: false, error: null,
};

/* ---------- 서버 호출 ---------- */
async function ensureAuth() {
  if (!sb) throw Object.assign(new Error('config.js 에 anon key 를 넣어야 합니다'), { code: 'no_config' });
  let { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw Object.assign(new Error('익명 로그인에 실패했어요. Supabase 설정에서 Anonymous sign-ins 가 켜져 있는지 확인해 주세요.'), { code: 'auth' });
    session = data.session;
  }
  return session.access_token;
}
async function call(name, body) {
  const token = await ensureAuth();
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
    });
  } catch (_) {
    throw Object.assign(new Error('네트워크에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.'), { code: 'network' });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || j.error || `HTTP ${r.status}`), { code: j.error || 'error', status: r.status, data: j });
  return j;
}
function errCopy(e) {
  const c = e?.code;
  if (c === 'rate_limited') return 'AI 요청이 몰려 있어요. 잠시 뒤에 다시 시도해 주세요.';
  if (c === 'quota_exhausted') return 'AI 임베딩의 하루 사용 한도를 다 썼어요. 한도는 한국 시간으로 오후 4~5시(태평양시 자정)에 초기화돼요. 그 뒤에 다시 시도하거나 연구자에게 알려 주세요.';
  if (c === 'embed_failed') return '자료를 분석하는 AI가 응답하지 않았어요. 잠시 뒤 다시 시도해 주세요.';
  if (c === 'timeout') return 'AI 응답이 늦어지고 있어요. 다시 시도해 주세요.';
  if (c === 'bad_key' || c === 'not_configured' || c === 'no_config') return '서비스 설정에 문제가 있어요. 연구자에게 알려 주세요.';
  if (c === 'invalid_json' || c === 'llm_failed') return 'AI 응답을 해석하지 못했어요. 다시 시도해 주세요.';
  if (c === 'batch_too_large') return '자료를 나눠 올리는 중 문제가 생겼어요. 다시 시도해 주세요.';
  if (c === 'ingest_failed') return `자료를 저장하지 못했어요. 잠시 뒤 다시 시도하거나 더 짧은 PDF로 해 보세요.${e?.message && e.message !== c ? ` (원인: ${String(e.message).slice(0, 300)})` : ''}`;
  if (c === 'too_large') return '자료가 너무 길어요. 필요한 쪽만 잘라서 다시 올려 주세요.';
  if (c === 'empty_text') return '자료에서 글자를 읽지 못했어요. 글자를 선택할 수 있는 PDF인지 확인해 주세요.';
  if (c === 'toolong') return `PDF가 ${MAX_PAGES}쪽을 넘어요. 필요한 쪽만 잘라서 올려 주세요.`;
  if (c === 'nopdf') return 'PDF 읽기 도구를 불러오지 못했어요. 새로고침 후 다시 시도해 주세요.';
  return e?.message || '문제가 생겼어요. 다시 시도해 주세요.';
}

/* ---------- 공통 화면 조각 ---------- */
function busy(msg) {
  $('#layer').innerHTML = `<div class="overlay" role="status" aria-live="polite"><div class="box2"><div class="spin"></div><div>${esc(msg)}</div></div></div>`;
  return () => { $('#layer').innerHTML = ''; };
}
async function withBusy(msg, fn) {
  const done = busy(msg);
  try { return await fn(); } finally { done(); }
}
const secLabel = (sec) => { const m = /^(\d+)(?:[–-](\d+))?쪽$/.exec(sec); return m ? (m[2] ? `p.${m[1]}–${m[2]}` : `p.${m[1]}`) : sec; };
const short = (s, n = 12) => (s.length > n ? s.slice(0, n) + '…' : s);
const pct = (v) => `${+(v * 100).toFixed(1)}%`;
function reqTitle(i) { const m = S.plan.missions[i]; return S.plan.reqs[m.req - 1] || `미션 ${i + 1}`; }

function steps(active) {
  if (!S.plan) return '';
  const items = S.plan.missions.map((m, i) => [`m${i}`, `${i + 1} ${short(reqTitle(i))}`]);
  items.push(['predict', '예측'], ['recall', '정리']);
  if (S.connectOffered) items.push(['connect', '연결']);
  items.push(['result', '결과']);
  const at = items.findIndex(([k]) => k === active);
  return `<nav class="stepper" aria-label="진행 단계">${items.map(([k, t], i) =>
    `${i ? '<span class="arrow">›</span>' : ''}<span class="st ${i === at ? 'on' : i < at ? 'done' : ''}">${esc(t)}</span>`).join('')}</nav>`;
}
function shell(where, active, inner, opts = {}) {
  $('#app').innerHTML = `<header class="top"><span class="brand">ReadMate</span><span class="sep">/</span><span class="where">${esc(where)}</span><span class="sp"></span>` +
    `${S.plan && !S.finished && !opts.noExit ? '<button class="btn ghost" id="exit" type="button">중단</button>' : ''}</header>` +
    (opts.noSteps ? '' : steps(active)) + `<main>${inner}</main>`;
  $('#exit')?.addEventListener('click', exitModal);
  window.scrollTo(0, 0);
}
function errBox(e, retryId) {
  return `<div class="err" role="alert">${esc(errCopy(e))}${retryId ? `<div class="bar"><button class="btn secondary" id="${retryId}" type="button">다시 시도</button></div>` : ''}</div>`;
}

/* ---------- 1. 시작 ---------- */
function startScreen() {
  S.screen = 'start';
  const shared = params.get('source');
  const papers = shared ? [] : PAPERS.filter((p) => p.sourceId); // 목록에 둘 자료(sourceId가 있는 것만). 없으면 PDF 업로드만 보인다
  const pickingPaper = papers.some((p) => p.key === S.paperKey);
  const paperList = papers.length
    ? `<div class="papers" role="radiogroup" aria-label="읽을 자료">${papers.map((p) => `<label class="consent paper"><input type="radio" name="paper" value="${esc(p.key)}" ${S.paperKey === p.key ? 'checked' : ''}><span><b>${esc(p.key)}.</b> ${esc(p.label)}</span></label>`).join('')}<label class="consent paper"><input type="radio" name="paper" value="upload" ${S.paperKey === 'upload' ? 'checked' : ''}><span>내 PDF 직접 올리기</span></label></div>`
    : '';
  const fileBox = shared
    ? `<div class="file has"><span class="tag">PDF</span><div class="meta"><div class="name">연구자가 제공한 자료</div></div></div>`
    : S.file
      ? `<div class="file has"><span class="tag">PDF</span><div class="meta"><div class="name">${esc(S.file.name)}</div></div><button class="link" id="pick" type="button">변경</button></div>`
      : `<div class="file"><div class="meta">PDF 파일을 선택해 주세요 (${MAX_PAGES}쪽 이하, 글자를 선택할 수 있는 PDF)</div><button class="btn secondary" id="pick" type="button">파일 선택</button></div>`;
  shell('새 읽기', '', `<div class="center">
    <h1>과제와 자료를 올려 주세요</h1>
    <label class="lbl" for="asg">과제 안내문</label>
    <textarea id="asg" rows="5" placeholder="예: 추천 시스템에서 인기 편향이 생기는 원인과 줄이려는 방법, 그 한계를 정리하세요.">${esc(S.assignment)}</textarea>
    <div class="hint-text">요구 분량과 필요한 항목을 함께 붙여 넣으면 더 잘 맞는 읽기 계획이 나와요.</div>
    <label class="lbl">읽을 자료</label>${paperList}${pickingPaper || (papers.length && S.paperKey !== 'upload') ? '' : fileBox}
    <input class="sr" type="file" id="file" accept="application/pdf">
    <div style="margin-top:20px">
      <label class="consent"><input type="checkbox" id="c1" ${S.consentResearch ? 'checked' : ''}><span>요약 로그(횟수·점수)를 익명으로 연구에 사용하는 것에 동의합니다.</span></label>
      <label class="consent"><input type="checkbox" id="c2" ${S.consentAnswers ? 'checked' : ''}><span>내 답변과 과제 안내문을 저장하는 것에 동의합니다. (동의하지 않으면 글은 저장되지 않아요.)</span></label>
    </div>
    ${S.error ? errBox(S.error, 'retry') : ''}
    <button class="btn primary" id="go" type="button" style="width:100%;margin-top:12px">읽기 계획 만들기</button>
  </div>`, { noSteps: true });
  $('#pick')?.addEventListener('click', () => $('#file').click());
  document.querySelectorAll('input[name=paper]').forEach((r) => r.addEventListener('change', () => {
    S.assignment = $('#asg').value; S.consentResearch = $('#c1').checked; S.consentAnswers = $('#c2').checked;
    S.paperKey = r.value; S.source = null; S.error = null; startScreen(); // 다른 자료를 고르면 앞서 만든 자료·업로드 파일 연결을 풀어 새로 시작한다
  }));
  $('#file').addEventListener('change', (e) => { S.file = e.target.files[0] || null; S.source = null; S.assignment = $('#asg').value; startScreen(); });
  const sync = () => { S.assignment = $('#asg').value; S.consentResearch = $('#c1').checked; S.consentAnswers = $('#c2').checked; };
  const go = () => {
    sync();
    if (!S.assignment.trim()) { S.error = { message: '과제 안내문을 입력해 주세요.' }; return startScreen(); }
    if (papers.length && !S.paperKey) { S.error = { message: '읽을 자료를 선택해 주세요.' }; return startScreen(); }
    if (!shared && !pickingPaper && !S.file && !S.source) { S.error = { message: '읽을 PDF를 선택해 주세요.' }; return startScreen(); }
    makePlan();
  };
  $('#go').addEventListener('click', go);
  $('#retry')?.addEventListener('click', go);
}

/* PDF → 쪽별 텍스트 (pdf.js는 필요할 때만 불러온다) */
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = ok; s.onerror = () => no({ code: 'nopdf' });
    document.head.appendChild(s);
  });
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return window.pdfjsLib;
}
async function readPdf(file) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > MAX_PAGES) throw { code: 'toolong' };
  // 쪽마다 글자 조각의 위치(x, y)·크기·너비·글꼴과 그림이 그려진 영역을 모아, 머리말·쪽번호·각주·표·캡션을 걷어 내고 제목을 찾고 줄을 잇는다(pdfclean.mjs).
  const raw = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const w = page.view[2] - page.view[0], h = page.view[3] - page.view[1];
    let images = [];
    try { // 그림 영역을 못 구해도(오류) 글 추출은 계속한다
      const ol = await page.getOperatorList();
      images = imageRectsFromOps(ol.fnArray, ol.argsArray, lib.OPS, w, h);
    } catch (_) { /* 그림 영역 없이 진행 */ }
    raw.push({ h, images, items: tc.items.map((it) => ({ s: stripUnsafe(it.str), x: it.transform[4], y: it.transform[5], eol: !!it.hasEOL, h: it.height, w: it.width, font: it.fontName })) });
  }
  const sections = [];
  cleanPages(raw).forEach((t, i) => { if (t.trim().length > 20) sections.push({ sec: `${i + 1}쪽`, text: t }); });
  const all = sections.map((s) => s.text).join('');
  const ko = (all.match(/[가-힣]/g) || []).length / Math.max(1, all.length);
  return { sections, pages: pdf.numPages, lang: ko > 0.2 ? 'ko' : 'en' };
}

// 자료를 나눠 올린다. 서버는 한 번에 청크 30개까지만 받는다. 청크는 약 400자이므로 6000자 배치는 청크 15개 안팎이다.
const BATCH_CHARS = 6000; // 임베딩을 외부 API로 받으므로 서버 계산 부담이 작다. 여러 쪽을 한 번에 보내 왕복을 줄이고, 쪽 경계에서 청크가 끊기는 곳도 줄인다(청크 약 15개).
// 아주 긴 쪽을 나눌 때 어절·제목 표시 한가운데서 자르지 않는다. 공백에서 자르고, 제목 표시가 열린 채면 그 앞에서 자른다.
function splitLong(text, max = 4500) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    const head = rest.slice(0, cut);
    if (head.split(HEAD_OPEN).length > head.split(HEAD_CLOSE).length) { const at = head.lastIndexOf(HEAD_OPEN); if (at > 0) cut = at; }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
async function uploadSource(title, pdf) {
  const batches = [];
  let cur = [], len = 0;
  pdf.sections.forEach((s) => {
    if (cur.length && len + s.text.length > BATCH_CHARS) { batches.push(cur); cur = []; len = 0; }
    // 한 쪽이 아주 길면 쪽 하나를 여러 섹션으로 나눈다(청크 ID는 섹션 번호 기준이라 겹치지 않는다).
    splitLong(s.text).forEach((part) => { cur.push({ sec: s.sec, text: part }); len += part.length; });
  });
  if (cur.length) batches.push(cur);
  // 빈 자료를 먼저 만들어 source_id를 확보한 뒤, 배치를 하나씩 이어 붙인다. 한 배치가 실패하면 그 배치만 다시 보낸다(서버는 같은 청크를 덮어쓴다).
  const created = await call('ingest-source', { title, lang: pdf.lang, pages: pdf.pages });
  const id = created.source_id;
  let sent = 0, idx = 0, carry = '';
  for (let b = 0; b < batches.length; b++) {
    const msg = $('#layer .box2 div:last-child');
    if (msg) msg.textContent = `자료를 올리는 중이에요… ${b + 1}/${batches.length}`;
    let r, lastErr;
    for (let attempt = 0; attempt < 4 && !r; attempt++) {
      try {
        // carry: 앞 배치 끝에서 아직 끝나지 않은 문장. 서버가 이 배치 맨 앞에 붙인다("(김철수,"와 "2021)에서"가 갈라지지 않게). 마지막 배치는 남김없이 저장한다.
        r = await call('ingest-source', { source_id: id, sections: batches[b], section_offset: sent, idx_start: idx, carry, last: b === batches.length - 1 });
      } catch (e) {
        lastErr = e;
        if (e.status && e.status < 500) throw e; // 요청 자체가 잘못된 경우는 다시 보내도 같다
        await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      }
    }
    if (!r) throw lastErr;
    idx = r.next_idx; sent += batches[b].length; carry = r.carry || '';
  }
  return { id, title, pages: pdf.pages };
}

async function makePlan() {
  S.error = null;
  try {
    const sharedId = params.get('source');
    const paper = sharedId ? null : PAPERS.find((p) => p.sourceId && p.key === S.paperKey);
    if (sharedId) S.source = { id: sharedId, title: '연구자가 제공한 자료', shared: true };
    else if (paper) S.source = { id: paper.sourceId, title: paper.short, shared: true }; // 올려 둔 자료를 그대로 쓴다(다시 올리거나 임베딩하지 않는다)
    if (!S.source) {
      S.source = await withBusy('자료를 읽는 중이에요…', async () => {
        const pdf = await readPdf(S.file);
        if (!pdf.sections.length) throw { code: 'empty_text' };
        const title = stripUnsafe(S.file.name.replace(/\.pdf$/i, ''));
        return await uploadSource(title, pdf);
      });
    }
    S.plan = await withBusy('읽기 계획을 만드는 중이에요. 30초 정도 걸릴 수 있어요…', () => call('plan-session', {
      source_id: S.source.id, assignment: S.assignment.trim(), condition: CONDITION, experiment: false,
      researcher: params.get('researcher') || undefined, paper_id: params.get('paper') || (paper ? paper.key : undefined),
      consent_research: S.consentResearch, consent_answers: S.consentAnswers,
    }));
    S.rec = S.plan.missions.map(() => ({ hint: 0, revised: false, evidence: 0, outcome: null }));
    planScreen();
  } catch (e) {
    S.error = e; S.plan = null;
    if (e?.code === 'not_found') S.source = null;
    startScreen();
  }
}

/* ---------- 2. 읽기 계획 ---------- */
function planScreen() {
  S.screen = 'plan';
  const ms = S.plan.missions;
  const pages = [...new Set(ms.map((m) => secLabel(m.excerpts.find((e) => e.role === 'core')?.sec || '')))];
  const total = ms.reduce((n, m) => n + m.mins, 0) + 3;
  shell('읽기 계획', '', `<div class="plan"><section>
    <h1>읽기 계획</h1>
    <p style="color:var(--sub)">시작 전에 확인하세요. 마음에 들지 않으면 다시 만들 수 있어요.</p>
    <div style="margin-top:24px">${ms.map((m, i) => {
      const core = m.excerpts.find((e) => e.role === 'core');
      return `${i ? '<div class="conn"></div>' : ''}<div class="step"><div class="no">${i + 1}</div><div class="body">
        <div class="row"><h2>${esc(reqTitle(i))}</h2><span class="fill"></span><span class="tag">약 ${m.mins}분</span></div>
        <p>${esc(secLabel(core.sec))} · ${m.text_units}문단</p>
        <p>문단을 읽고 근거 문장을 고르며 질문에 답해요.</p></div></div>`;
    }).join('')}<div class="conn"></div><div class="step"><div class="no">·</div><div class="body">
      <div class="row"><h2>마무리</h2><span class="fill"></span><span class="tag">약 3분</span></div>
      <p>읽은 범위만 정리하고, 떠올릴 수 있는 정도를 예측해 봐요.</p></div></div></div>
    <div class="actions"><button class="btn primary" id="start" type="button">계획대로 시작</button><button class="btn secondary" id="redo" type="button">다시 만들기</button></div>
  </section><aside class="scope"><div class="card"><h3>읽을 범위</h3>
    <div><span class="tag">PDF</span> ${esc(S.source.title)}</div>
    <div class="tags">${pages.map((p) => `<span class="tag">${esc(p)}</span>`).join('')}</div><hr>
    <h3>과제 요구 항목</h3>${ms.map((m, i) => `<div class="req"><span>${esc(reqTitle(i))}</span><span class="tag">${esc(REQ_TYPE_LABEL[m.req_type] || '')} · 미션 ${i + 1}</span></div>`).join('')}
    <hr><div class="hint-text">예상 시간 약 ${total}분</div></div></aside></div>`, { noSteps: true });
  $('#start').addEventListener('click', () => beginMission(0, S.plan.start_support));
  $('#redo').addEventListener('click', makePlan);
}

/* ---------- 3. 읽기 작업 ---------- */
async function beginMission(i, support) {
  S.mi = i; S.support = support; S.qtype = support.qtype;
  S.ui = { answer: '', evidence: [], hints: [], hintSents: [], fb: null, phase: 'answer', cue: support.sup >= 1, notice: '', reported: [], error: null, lastGap: '' };
  const m = S.plan.missions[i];
  if (S.plan.lazy && !m.variants.length) { // 질문은 미션을 시작할 때, 학생이 읽을 글을 보고 만든다
    try {
      const q = await withBusy('이번에 읽을 글에 맞춰 질문을 만드는 중이에요…', () => call('make-question', { session_id: S.plan.session_id, mission_idx: i }));
      m.variants = [q.variant]; S.qtype = q.qtype; S.support = { ...support, ...(q.support || {}), qtype: q.qtype };
    } catch (e) {
      S.ui.error = e; S.ui.retryMake = true;
      return questionFailScreen();
    }
  }
  workScreen();
}
// 질문을 만들지 못했을 때: 같은 미션을 다시 시도한다(진행 상태는 서버에 그대로 있다)
function questionFailScreen() {
  S.screen = 'work';
  shell(`${S.source.title} · 미션`, `m${S.mi}`, `<div class="work"><section class="reader" id="reader"></section><aside class="helper">
    <div class="head"><b>읽기 도우미</b><span class="tag">AI</span></div>${errBox(S.ui.error)}
    <div class="bar"><span class="sp"></span><button class="btn primary" id="retryq" type="button">질문 다시 만들기</button></div></aside></div>`);
  $('#retryq').addEventListener('click', () => beginMission(S.mi, S.support));
}
const variant = () => { const m = S.plan.missions[S.mi]; return m.variants.find((v) => v.qtype === S.qtype) || m.variants[0]; };

// 앞 문단·핵심 문단·뒤 문단을 구분 없이 하나의 글로 보여 주고, 문장 번호는 전체에 이어서 붙인다.
// (핵심 문장만 읽는 일을 막으려고 핵심 표시·흐린 글씨·강조를 두지 않는다.) 힌트가 가리키는 문장만 학생이 요청했을 때 표시한다.
function readerLayout() {
  const m = S.plan.missions[S.mi];
  let off = 0;
  // 조건 A(실험)는 핵심 문장 일부만 보여 주므로 원문 안의 시작 번호(e.from)를 반영한다.
  return m.excerpts.map((e) => { const o = off + ((e.from || 1) - 1); off += e.sentences.length; return { e, off: o }; });
}
function readerHtml() {
  const m = S.plan.missions[S.mi];
  const core = m.excerpts.find((e) => e.role === 'core');
  return `<div class="src">원문 · ${esc(secLabel(core.sec))}</div>` + readerLayout().map(({ e, off }) => `<div class="para">${e.sentences.map((s, k) => {
    const n = off + k + 1;
    // 제목 문장은 굵게 보여 주고 근거로 고를 수 없다(번호는 건너뛰지 않는다: 서버의 근거 번호와 맞아야 한다).
    if ((e.heads || []).includes((e.from || 1) + k)) return `<div class="sent head" data-n="${n}"><span class="n">${n}</span><span class="t"><b>${esc(s)}</b></span></div>`;
    const cls = ['sent', S.ui.evidence.includes(n) ? 'picked' : '', S.ui.hintSents.includes(n) ? 'hinted' : ''].join(' ');
    return `<div class="${cls}" data-n="${n}" role="button" tabindex="0" aria-pressed="${S.ui.evidence.includes(n)}"><span class="n">${n}</span><span class="t">${esc(s)}</span>${S.ui.hintSents.includes(n) ? '<span class="tag">힌트</span>' : ''}</div>`;
  }).join('')}</div>`).join('');
}

function workScreen() {
  S.screen = 'work';
  const m = S.plan.missions[S.mi], v = variant(), u = S.ui, r = S.rec[S.mi];
  const inFb = u.phase === 'feedback';
  const hintsLeft = 3 - r.hint;
  const cite = u.evidence.length
    ? `<div class="cite">${u.evidence.map((n) => `<span class="tag">문장 ${n}</span>`).join('')}</div>`
    : `<div class="hint-text">왼쪽 원문에서 문장을 눌러 근거로 추가해 보세요. ${evidenceMin() ? `(필수 · ${evidenceMin()}개 이상)` : '(선택)'}</div>`;
  const fb = u.fb;
  let fbHtml = '';
  if (fb) {
    fbHtml = `<div class="feed"><span class="tag accent">AI 피드백</span><div style="margin-top:10px">` +
      (fb.praise ? `<b>잘한 점</b><p>${esc(fb.praise)}</p>` : '') +
      (fb.outcome === 'revise' ? `${fb.gap ? `<b>보완할 점</b><p>${esc(fb.gap)}</p>` : ''}${fb.location ? `<b>다시 확인할 곳</b><p>${esc(fb.location)}</p>` : ''}<div class="hint-text">보완은 한 번만 요청해요.</div>` : '') +
      (fb.outcome === 'unresolved' ? `<b>이번에는 핵심 요점을 보여 드릴게요</b><ul style="margin:4px 0 0;padding-left:20px">${fb.reveal.map((k) => `<li>${esc(k)}</li>`).join('')}</ul><div class="hint-text">다음 미션으로 넘어가요.</div>` : '') +
      (fb.outcome === 'passed' && fb.self_correction ? '<div class="hint-text">보완해서 고쳤어요.</div>' : '') +
      '</div></div>';
  }
  const reportChips = inFb ? `<div class="bar" style="flex-wrap:wrap"><small style="color:var(--muted)">이 질문은 어땠나요?</small><div class="chips">${[['unanswerable', '답할 수 없어요'], ['mismatch', '원문과 달라요'], ['too_easy', '너무 쉬워요']].map(([k, t]) =>
    `<button class="chip ${u.reported.includes(k) ? 'on' : ''}" data-report="${k}" type="button" ${u.reported.includes(k) ? 'disabled' : ''}>${t}</button>`).join('')}</div></div>` : '';
  const nextLabel = fb?.outcome === 'revise' ? '보완해서 다시 쓰기' : fb?.all_done ? '정리하러 가기' : '다음 미션';
  const answerBlock = inFb
    ? `<div class="mine"><span class="tag">내 답</span><div style="margin-top:8px">${esc(u.answer)}</div>${u.evidence.length ? `<div class="cite">${u.evidence.map((n) => `<span class="tag">문장 ${n}</span>`).join('')}</div>` : ''}</div>`
    : `${u.lastGap ? `<div class="box"><b>보완할 점</b>${esc(u.lastGap)}</div>` : ''}${u.notice ? `<div class="box"><b>안내</b>${esc(u.notice)}</div>` : ''}
       <div><label class="lbl" style="margin:0 0 6px" for="ans">내 답</label><textarea id="ans" rows="5" placeholder="${esc(S.support.sup >= 2 ? v.frame : '자신의 말로 써 보세요.')}">${esc(u.answer)}</textarea></div>
       <div><b style="font-size:13px;color:var(--sub)">근거 문장</b>${cite}</div>`;
  shell(`${S.source.title} · 미션`, `m${S.mi}`, `<div class="work"><section class="reader" id="reader">${readerHtml()}</section>
    <aside class="helper" aria-label="읽기 도우미">
      <div class="head"><b>읽기 도우미</b><span class="tag">AI</span><span class="fill"></span><small>미션 ${S.mi + 1} / ${S.plan.missions.length}</small></div>
      ${u.cue ? `<div class="box"><b>읽기 전에 볼 점</b>${esc(v.cue)}</div>` : `<button class="link" id="cue" type="button">읽기 전에 볼 점 보기</button>`}
      <div class="q"><small>질문 · ${S.plan.lazy ? LEVEL_LABEL[S.qtype] : QLABEL[S.qtype]}${S.plan.missions[S.mi].req_type ? ` · ${REQ_TYPE_LABEL[S.plan.missions[S.mi].req_type]}` : ''}</small><p>${esc(v.question)}</p></div>
      ${u.hints.map((h) => `<div class="feed"><span class="tag accent">AI 힌트</span> <span class="tag">${HINT_NAME[h.level]}</span><p style="margin:10px 0 0">${esc(h.text)}</p>${h.quote ? `<p style="margin:6px 0 0;color:var(--sub)">“${esc(h.quote)}” <span class="tag">${esc(h.location)}</span></p>` : ''}</div>`).join('')}
      ${answerBlock}${fbHtml}${reportChips}
      ${u.error ? errBox(u.error) : ''}
      <div class="bar">
        ${inFb ? '' : `<button class="btn secondary" id="hint" type="button" ${hintsLeft <= 0 ? 'disabled' : ''}>힌트 ${r.hint}/3</button><button class="link" id="weird" type="button" ${u.reported.includes('weird') ? 'disabled' : ''}>${u.reported.includes('weird') ? '신고했어요' : '이 질문이 이상해요'}</button>`}
        <span class="sp"></span>
        ${inFb ? `<button class="btn primary" id="next" type="button">${nextLabel}</button>` : '<button class="btn primary" id="submit" type="button">제출</button>'}
      </div></aside></div>`);

  // 이벤트
  $('#cue')?.addEventListener('click', () => { u.cue = true; keep(); workScreen(); });
  const pickSent = (el) => {
    if (u.phase === 'feedback' && u.fb?.outcome !== 'revise') return;
    const n = +el.dataset.n;
    u.evidence = u.evidence.includes(n) ? u.evidence.filter((x) => x !== n) : [...u.evidence, n].slice(-5).sort((a, b) => a - b);
    keep(); workScreen();
  };
  document.querySelectorAll('.sent:not(.head)').forEach((el) => {
    el.addEventListener('click', () => { if (u.phase === 'answer') pickSent(el); });
    el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && u.phase === 'answer') { e.preventDefault(); pickSent(el); } });
  });
  $('#hint')?.addEventListener('click', getHint);
  $('#submit')?.addEventListener('click', submitAnswer);
  $('#weird')?.addEventListener('click', () => report('weird'));
  document.querySelectorAll('[data-report]').forEach((b) => b.addEventListener('click', () => report(b.dataset.report)));
  $('#next')?.addEventListener('click', onNext);
}
const keep = () => { const t = $('#ans'); if (t) S.ui.answer = t.value; };

async function getHint() {
  keep(); const u = S.ui;
  try {
    const h = await withBusy('힌트를 만드는 중이에요…', () => call('submit-answer', { session_id: S.plan.session_id, mission_idx: S.mi, action: 'hint', qtype: S.qtype }));
    S.rec[S.mi].hint = h.hint_level;
    u.hints.push(h); u.error = null;
    if (h.sentences?.length) u.hintSents.push(...h.sentences); // 위치 힌트(읽은 글 전체 번호): 해당 문장을 원문에서 표시한다
    else if (h.quote) {
      const lay = readerLayout().find((x) => x.e.role === 'core');
      lay.e.sentences.forEach((s, k) => { if (h.quote.includes(s)) u.hintSents.push(lay.off + k + 1); });
    }
  } catch (e) { u.error = e.code === 'hints_exhausted' ? { message: '힌트를 모두 사용했어요.' } : e; }
  workScreen();
}

async function submitAnswer() {
  keep(); const u = S.ui;
  if (!u.answer.trim()) { u.error = { message: '답을 먼저 써 주세요.' }; return workScreen(); }
  if (u.evidence.length < evidenceMin()) { u.error = { message: `근거 문장을 ${evidenceMin()}개 이상 골라 주세요. 왼쪽 원문에서 문장을 눌러 선택해요.` }; return workScreen(); }
  u.error = null; u.notice = '';
  try {
    const res = await withBusy('답을 확인하는 중이에요…', () => call('submit-answer', {
      session_id: S.plan.session_id, mission_idx: S.mi, action: 'answer', qtype: S.qtype, answer: u.answer.trim(), evidence: u.evidence,
    }));
    const r = S.rec[S.mi];
    r.evidence = (res.evidence || []).length;
    if (res.outcome === 'rewrite') { u.notice = res.message; return workScreen(); }
    if (res.outcome === 'revise') {
      r.revised = true; u.lastGap = res.gap || '';
      u.fb = { outcome: 'revise', praise: res.praise, gap: res.gap, location: res.recheck?.location };
    } else {
      r.outcome = res.outcome; u.lastGap = '';
      u.fb = { outcome: res.outcome, praise: res.praise, reveal: res.reveal || [], self_correction: res.self_correction, next: res.next_mission, next_support: res.next_support, all_done: res.all_done };
    }
    u.phase = 'feedback';
  } catch (e) { u.error = e; }
  workScreen();
}

function onNext() {
  const u = S.ui, fb = u.fb;
  if (fb.outcome === 'revise') { u.phase = 'answer'; u.fb = null; u.hintSents = []; return workScreen(); }
  if (fb.all_done) return recallStart();
  beginMission(fb.next, fb.next_support);
}

async function report(reason) {
  keep(); const u = S.ui;
  if (u.reported.includes(reason)) return;
  try {
    await call('report-question', { session_id: S.plan.session_id, mission_idx: S.mi, qtype: S.qtype, reason });
    u.reported.push(reason);
  } catch (e) { u.error = e; }
  workScreen();
}

/* ---------- 4. 예측과 정리 ---------- */
async function recallStart() {
  try {
    const r = await withBusy('정리를 준비하는 중이에요…', () => call('recall', { session_id: S.plan.session_id, action: 'start' }));
    S.recallStage = r.stage;
    if (r.stage === 'unavailable') return connectStart();
    S.recallInfo = r;
    if (r.stage === 'predicted') return recallWriteScreen();
    predictScreen();
  } catch (e) { S.error = e; if (e.code === 'recall_finished') return connectStart(); predictScreen(true); }
}
function predictScreen(failed) {
  S.screen = 'predict';
  const opts = S.recallInfo?.options || Object.entries(JOL_LABEL).map(([value, label]) => ({ value: +value, label }));
  const n = S.recallInfo?.missions?.length || S.plan.missions.length;
  shell(`${S.source.title} · 마무리`, 'predict', `<div class="center wide">
    <h1 style="font-size:24px">${n}개 미션에서 읽은 내용을 지금 얼마나 떠올릴 수 있을 것 같나요?</h1>
    <p style="color:var(--sub)">정답은 없어요. 느끼는 대로 골라 주세요.</p>
    <div class="opts" role="radiogroup" style="margin-top:24px">${opts.map((o) => `<button class="opt ${S.jol === o.value ? 'on' : ''}" role="radio" aria-checked="${S.jol === o.value}" data-v="${o.value}" type="button"><b>${pct(o.value)}</b><span>${esc(o.label)}</span></button>`).join('')}</div>
    ${failed && S.error ? errBox(S.error, 'retry') : ''}
    <div class="bar" style="margin-top:24px"><button class="link" id="skip" type="button">건너뛰기</button><span class="sp"></span><button class="btn primary" id="go" type="button" ${S.jol == null ? 'disabled' : ''}>통합 정리 시작</button></div></div>`);
  document.querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => { S.jol = +b.dataset.v; predictScreen(); }));
  $('#retry')?.addEventListener('click', recallStart);
  $('#skip').addEventListener('click', skipRecall);
  $('#go').addEventListener('click', async () => {
    try {
      await withBusy('저장하는 중이에요…', () => call('recall', { session_id: S.plan.session_id, action: 'predict', jol: S.jol }));
      S.error = null; recallWriteScreen();
    } catch (e) { S.error = e; predictScreen(true); }
  });
}
async function skipRecall() {
  try { await withBusy('건너뛰는 중이에요…', () => call('recall', { session_id: S.plan.session_id, action: 'skip' })); } catch (_) { /* 이미 끝났으면 넘어간다 */ }
  S.recallRes = null; S.recallStage = 'skipped'; connectStart();
}
function recallWriteScreen(text = '', err = null) {
  S.screen = 'recall';
  shell(`${S.source.title} · 마무리`, 'recall', `<div class="center wide">
    <h1 style="font-size:24px">책을 덮고, 방금 읽은 내용의 핵심을 떠오르는 대로 써 보세요.</h1>
    <textarea id="rec" rows="9" style="margin-top:20px" placeholder="떠오르는 대로 써 보세요. 틀려도 괜찮아요.">${esc(text)}</textarea>
    ${err ? errBox(err) : ''}
    <div class="bar" style="margin-top:16px"><small style="color:var(--muted)">맞고 틀림은 표시되지 않아요.</small><span class="sp"></span><button class="link" id="skip" type="button">건너뛰기</button><button class="btn primary" id="done" type="button">완료</button></div></div>`);
  $('#skip').addEventListener('click', skipRecall);
  $('#done').addEventListener('click', async () => {
    const t = $('#rec').value.trim();
    if (!t) return recallWriteScreen('', { message: '떠오르는 내용을 먼저 써 주세요.' });
    try {
      S.recallRes = await withBusy('정리한 내용을 확인하는 중이에요…', () => call('recall', { session_id: S.plan.session_id, action: 'submit', answer: t }));
      connectStart();
    } catch (e) { recallWriteScreen(t, e); }
  });
}

/* ---------- 5. 연결 (선택) ---------- */
async function connectStart() {
  try {
    const r = await withBusy('다음 단계를 준비하는 중이에요…', () => call('connect', { session_id: S.plan.session_id, action: 'start' }));
    if (r.stage === 'unavailable') return resultScreen();
    S.connect = r; S.connectOffered = true;
    connectScreen();
  } catch (_) { resultScreen(); } // 연결은 선택 단계라 실패해도 결과로 넘어간다
}
function connectScreen(text = '', err = null, comment = null) {
  S.screen = 'connect';
  const c = S.connect;
  shell(`${S.source.title} · 마무리`, 'connect', `<div class="center wide">
    <span class="tag accent">선택</span>
    <h1 style="font-size:24px;margin-top:8px">${esc(c.question)}</h1>
    <div class="card" style="margin:16px 0"><b style="font-size:13px;color:var(--muted)">읽은 미션</b>${c.missions.map((m) => `<div style="margin-top:6px"><span class="tag">미션 ${m.mission}</span> ${esc(m.req)}</div>`).join('')}</div>
    ${comment === null
      ? `<textarea id="con" rows="6" placeholder="예: 미션 1에서 본 ○○ 개념이 미션 2의 사례와 이어지는 부분은…">${esc(text)}</textarea>${err ? errBox(err) : ''}
         <div class="bar" style="margin-top:16px"><span class="sp"></span><button class="link" id="skip" type="button">건너뛰기</button><button class="btn primary" id="sub" type="button">제출</button></div>`
      : `<div class="mine">${esc(text)}</div><div class="feed" style="margin-top:12px"><span class="tag accent">AI</span><p style="margin:8px 0 0">${esc(comment)}</p></div>
         <div class="bar" style="margin-top:16px"><span class="sp"></span><button class="btn primary" id="cont" type="button">결과 보기</button></div>`}
  </div>`);
  $('#skip')?.addEventListener('click', async () => {
    try { await withBusy('건너뛰는 중이에요…', () => call('connect', { session_id: S.plan.session_id, action: 'skip' })); } catch (_) { /* 무시 */ }
    resultScreen();
  });
  $('#cont')?.addEventListener('click', resultScreen);
  $('#sub')?.addEventListener('click', async () => {
    const t = $('#con').value.trim();
    if (!t) return connectScreen('', { message: '쓴 내용이 없어요. 건너뛰어도 괜찮아요.' });
    try {
      const r = await withBusy('확인하는 중이에요…', () => call('connect', { session_id: S.plan.session_id, action: 'submit', connection: t }));
      connectScreen(t, null, r.comment || '연결을 써 주셔서 고마워요.');
    } catch (e) { connectScreen(t, e); }
  });
}

/* ---------- 6. 결과 ---------- */
const CAL_TEXT = { 과대: '예측이 실제보다 높았어요.', 과소: '실제가 예측보다 높았어요.', 비슷: '예측과 실제가 비슷했어요.' };
function resultScreen(err = null) {
  S.screen = 'result';
  const rr = S.recallRes;
  const cmp = rr
    ? `<div class="cmp"><div><small>예측</small><div class="big">${pct(rr.prediction)}</div></div><div><small>실제 (${rr.recalled}/${rr.total}개)</small><div class="big">${pct(rr.actual)}</div></div></div>
       <div style="margin-top:12px"><span class="tag accent">${esc(rr.calibration)}</span> ${esc(CAL_TEXT[rr.calibration] || '')}</div>`
    : '<div style="color:var(--sub)">이번에는 정리를 건너뛰었어요.</div>';
  shell('결과', 'result', `<div class="result"><section><h1>이번 읽기 결과</h1>
    <div class="card" style="margin:20px 0">${cmp}</div>
    <b>읽기 부담</b><div class="load" style="margin-top:8px" role="radiogroup" aria-label="읽기 부담">${[1, 2, 3, 4, 5].map((n) => `<button class="${S.load === n ? 'on' : ''}" role="radio" aria-checked="${S.load === n}" data-l="${n}" type="button" ${S.finished ? 'disabled' : ''}>${n}</button>`).join('')}</div>
    <div class="scale"><span>가벼웠어요</span><span>부담스러웠어요</span></div>
    ${err ? errBox(err) : ''}
    ${S.finished
      ? `<div class="card" style="margin-top:24px"><b>기록을 저장했어요.</b><p style="margin:6px 0 12px;color:var(--sub)">참여해 주셔서 고맙습니다.</p><button class="btn secondary" id="again" type="button">새로 읽기</button></div>`
      : `<button class="btn primary" id="fin" type="button" style="margin-top:24px" ${S.load ? '' : 'disabled'}>끝내기</button>`}
  </section><section class="card"><h2 style="margin-bottom:12px">세션 기록</h2><table><thead><tr><th>미션</th><th>힌트</th><th>근거 문장</th><th>보완</th></tr></thead><tbody>
    ${S.plan.missions.map((m, i) => { const r = S.rec[i]; return r.outcome || r.hint || r.revised ? `<tr><td>${i + 1} ${esc(reqTitle(i))}${r.outcome === 'unresolved' ? ' <span class="tag">미해결</span>' : ''}</td><td>${r.hint ? r.hint + '단계' : '없음'}</td><td>${r.evidence}개</td><td>${r.revised ? '1회' : '없음'}</td></tr>` : ''; }).join('')}
  </tbody></table></section></div>`, { noExit: S.finished });
  document.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => { S.load = +b.dataset.l; resultScreen(); }));
  $('#fin')?.addEventListener('click', async () => {
    try {
      await withBusy('기록을 저장하는 중이에요…', () => call('finish-session', { session_id: S.plan.session_id, reading_load: S.load }));
      S.finished = true; resultScreen();
    } catch (e) { resultScreen(e); }
  });
  $('#again')?.addEventListener('click', () => { location.href = location.pathname + location.search; });
}

/* ---------- 중단 ---------- */
function exitModal() {
  let reason = '', load = 0, error = null;
  const draw = () => {
    $('#layer').innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="읽기 중단"><div class="card">
      <h2>읽기를 그만둘까요?</h2><p style="color:var(--sub)">지금까지의 기록은 저장돼요. 이유를 알려 주시면 개선에 도움이 돼요.</p>
      <div class="chips" style="margin:12px 0">${EXIT_REASONS.map((r) => `<button class="chip ${reason === r ? 'on' : ''}" data-r="${esc(r)}" type="button">${esc(r)}</button>`).join('')}</div>
      <b style="font-size:13px">읽기 부담</b><div class="load" style="margin:6px 0 4px">${[1, 2, 3, 4, 5].map((n) => `<button class="${load === n ? 'on' : ''}" data-l="${n}" type="button" style="width:40px;height:40px">${n}</button>`).join('')}</div>
      ${error ? errBox(error) : ''}
      <div class="bar" style="margin-top:16px"><button class="btn secondary" id="back" type="button">계속 읽기</button><span class="sp"></span><button class="btn" id="quit" type="button" ${reason && load ? '' : 'disabled'}>그만두기</button></div></div></div>`;
    document.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { reason = b.dataset.r; draw(); }));
    document.querySelectorAll('.modal [data-l]').forEach((b) => b.addEventListener('click', () => { load = +b.dataset.l; draw(); }));
    $('#back').addEventListener('click', () => { $('#layer').innerHTML = ''; });
    $('#quit').addEventListener('click', async () => {
      try {
        await withBusy('기록을 저장하는 중이에요…', () => call('finish-session', { session_id: S.plan.session_id, reading_load: load, exit_reason: reason }));
        S.finished = true; S.load = load; S.recallRes = null; resultScreen();
      } catch (e) {
        if (e.code === 'nothing_to_summarize') { S.plan = null; $('#layer').innerHTML = ''; return startScreen(); } // 시작한 미션이 없으면 남길 기록이 없다
        error = e; draw();
      }
    });
  };
  draw();
}

/* ---------- 시작 ---------- */
if (!sb) {
  $('#app').innerHTML = '<main><div class="center"><h1>설정이 필요해요</h1><p>web/config.js 에 Supabase anon key 를 넣어 주세요.</p></div></main>';
} else {
  startScreen();
}
