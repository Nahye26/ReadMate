// POST /ingest-source
// 입력: { title, lang?, pages?, sections: [{ sec, text }] }  — PDF 텍스트 추출은 데모처럼 브라우저(pdf.js)에서 한다.
// 동작: 문단 단위로 청킹 → 청크별 임베딩 → sources / chunks 저장
// 출력: { source_id, chunks }
import { buildChunks, type Chunk } from '../_shared/core.ts';
import { embed, toVector } from '../_shared/embed.ts';
import { authedUser, corsHeaders, json, serviceClient } from '../_shared/http.ts';

const MAX_CHUNKS = 800;
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
  if (typeof title !== 'string' || !title.trim() || !Array.isArray(sections) || !sections.length) {
    return json({ error: 'bad_request', message: 'title과 sections가 필요합니다' }, 400);
  }

  const chunks: Chunk[] = [];
  sections.forEach((s: any, i: number) => {
    const text = String(s?.text ?? '');
    const sec = String(s?.sec ?? `본문 ${i + 1}`);
    buildChunks(text, sec, `p${i + 1}-`).forEach((c) => chunks.push(c));
  });
  const chars = chunks.reduce((n, c) => n + c.t.length, 0);
  if (!chunks.length) return json({ error: 'empty_text' }, 400);
  if (chunks.length > MAX_CHUNKS || chars > MAX_CHARS) {
    return json({ error: 'too_large', message: '자료가 너무 깁니다. 필요한 쪽만 잘라서 다시 올려 주세요.' }, 413);
  }

  const db = serviceClient();
  const { data: source, error: srcErr } = await db
    .from('sources')
    .insert({ owner: user.id, title: title.trim().slice(0, 200), lang: lang === 'ko' || lang === 'en' ? lang : null, pages: Number.isInteger(pages) ? pages : null })
    .select('id')
    .single();
  if (srcErr || !source) return json({ error: 'db_error', message: srcErr?.message }, 500);

  try {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < chunks.length; i += 8) {
      const batch = chunks.slice(i, i + 8);
      const vecs = await Promise.all(batch.map((c) => embed(c.t)));
      batch.forEach((c, k) =>
        rows.push({ source_id: source.id, id: c.id, idx: i + k, sec: c.sec, sentences: c.s, text: c.t, embedding: toVector(vecs[k]) })
      );
    }
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await db.from('chunks').insert(rows.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    await db.from('sources').delete().eq('id', source.id); // chunks는 cascade로 함께 삭제
    return json({ error: 'ingest_failed', message: (e as Error).message }, 500);
  }

  return json({ source_id: source.id, chunks: chunks.length });
});
