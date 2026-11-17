// POST /ingest-source
// 입력: { title, lang?, pages?, sections: [{ sec, text }], source_id?, section_offset?, idx_start? }  — PDF 텍스트 추출은 데모처럼 브라우저(pdf.js)에서 한다.
// 한 번의 호출은 임베딩 계산량 때문에 작게(청크 MAX_CHUNKS_PER_CALL개 이하) 유지한다. 긴 자료는 클라이언트가 나눠 보낸다.
//   첫 호출: source_id 없이 sections도 없이 title만 보낸다 → 빈 자료를 만들고 source_id를 돌려준다. (플랫폼이 계산 한도로 호출을 끊어도 source_id를 잃지 않게 하려고 분리했다)
//   이어 보내기: 첫 호출이 돌려준 source_id와, 이미 보낸 섹션 수(section_offset), 이미 저장된 청크 수(idx_start)를 함께 보낸다.
//   section_offset은 청크 ID(p{섹션번호}-k)가 겹치지 않게, idx_start는 chunks.idx(앞뒤 청크 순서)가 이어지게 한다.
// 동작: 문단 단위로 청킹 → 청크별 임베딩(한 번에 하나씩, 메모리를 아끼려고) → sources / chunks 저장
// 출력: { source_id, chunks, next_idx }   (chunks: 이번 호출에서 저장한 수, next_idx: 다음 호출의 idx_start)
// 같은 호출을 다시 보내도 안전하다(같은 청크 ID는 덮어쓴다). 클라이언트는 실패한 배치만 다시 보낸다.
import { buildChunks, type Chunk } from '../_shared/core.ts';
import { embed, toVector } from '../_shared/embed.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';

const MAX_CHUNKS_PER_CALL = 30;
const MAX_CHUNKS_TOTAL = 800;
const MAX_CHARS = 600_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const user = await authedUser(req);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: 'bad_json' }, 400);
  }
  const { title, lang, pages, sections } = body ?? {};
  const append = typeof body?.source_id === 'string';
  const sectionOffset = Number.isInteger(body?.section_offset) && body.section_offset >= 0 ? body.section_offset : 0;
  const idxStart = Number.isInteger(body?.idx_start) && body.idx_start >= 0 ? body.idx_start : 0;
  const create = !append && (!Array.isArray(sections) || !sections.length); // 빈 자료 만들기
  if (!create && (!Array.isArray(sections) || !sections.length)) return json({ error: 'bad_request', message: 'sections가 필요합니다' }, 400);
  if (!append && (typeof title !== 'string' || !title.trim())) return json({ error: 'bad_request', message: 'title이 필요합니다' }, 400);

  const chunks: Chunk[] = [];
  (create ? [] : sections).forEach((s: any, i: number) => {
    const text = String(s?.text ?? '');
    const sec = String(s?.sec ?? `본문 ${sectionOffset + i + 1}`);
    buildChunks(text, sec, `p${sectionOffset + i + 1}-`).forEach((c) => chunks.push(c));
  });
  const chars = chunks.reduce((n, c) => n + c.t.length, 0);
  if (!create && !chunks.length) return json({ error: 'empty_text' }, 400);
  if (chunks.length > MAX_CHUNKS_PER_CALL) {
    return json({ error: 'batch_too_large', message: `한 번에 청크 ${MAX_CHUNKS_PER_CALL}개까지 보낼 수 있습니다(받은 수 ${chunks.length})` }, 413);
  }
  if (idxStart + chunks.length > MAX_CHUNKS_TOTAL || chars > MAX_CHARS) {
    return json({ error: 'too_large', message: '자료가 너무 깁니다. 필요한 쪽만 잘라서 다시 올려 주세요.' }, 413);
  }

  const db = serviceClient();
  let sourceId: string;
  if (append) {
    // 이어 보내기: 내 자료인지 확인한다(service role은 RLS를 우회한다).
    const { data: src } = await db.from('sources').select('id, owner').eq('id', body.source_id).maybeSingle();
    if (!src || src.owner !== user.id) return json({ error: 'not_found' }, 404);
    sourceId = src.id;
  } else {
    const { data: source, error: srcErr } = await db
      .from('sources')
      .insert({ owner: user.id, title: title.trim().slice(0, 200), lang: lang === 'ko' || lang === 'en' ? lang : null, pages: Number.isInteger(pages) ? pages : null })
      .select('id')
      .single();
    if (srcErr || !source) return json({ error: 'db_error', message: srcErr?.message }, 500);
    sourceId = source.id;
  }

  if (create) return json({ source_id: sourceId, chunks: 0, next_idx: 0 });

  try {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < chunks.length; i++) {
      // 한 번에 하나씩 계산한다. 여러 개를 동시에 돌리면 Edge Function의 메모리·CPU 한도(546)를 넘는다.
      const c = chunks[i];
      rows.push({ source_id: sourceId, id: c.id, idx: idxStart + i, sec: c.sec, sentences: c.s, text: c.t, embedding: toVector(await embed(c.t)) });
    }
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('chunks').upsert(rows.slice(i, i + 100), { onConflict: 'source_id,id' });
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    return json({ error: 'ingest_failed', message: (e as Error).message }, 500);
  }

  return json({ source_id: sourceId, chunks: chunks.length, next_idx: idxStart + chunks.length });
});
