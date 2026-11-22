// 미션 읽기 범위(앞·핵심·뒤 청크)를 DB에서 읽어 Win(문장 번호가 이어진 하나의 글)으로 만든다.
// make-question, submit-answer, recall이 같은 번호 체계를 쓰도록 한 곳에 둔다. 번호 체계는 화면(app.js readerLayout)과 같다.
import { buildWindow, type Chunk, type Win } from './core.ts';
import type { serviceClient } from './http.ts';

type Db = ReturnType<typeof serviceClient>;

export async function loadWindow(db: Db, sourceId: string, ids: string[]): Promise<{ win: Win; chunks: Chunk[] } | null> {
  const run = (cols: string) => db.from('chunks').select(cols).eq('source_id', sourceId).in('id', ids);
  let res = await run('id, idx, sec, sentences, heads');
  if (res.error && /heads/.test(res.error.message)) res = await run('id, idx, sec, sentences'); // migration 20261123000000 적용 전
  const rows = (res.data ?? []) as unknown as { id: string; idx: number; sec: string; sentences: string[]; heads?: number[] }[];
  if (res.error || rows.length !== new Set(ids).size) return null;
  rows.sort((a, b) => a.idx - b.idx);
  const chunks: Chunk[] = rows.map((r) => ({ id: r.id, sec: r.sec, s: r.sentences, t: r.sentences.join(' '), ...(r.heads?.length ? { heads: r.heads } : {}) }));
  return { win: buildWindow(chunks), chunks };
}
