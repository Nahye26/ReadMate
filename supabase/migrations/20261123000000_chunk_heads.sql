-- 청크 안의 제목 문장 (2026-11-23, docs/REVISION_PLAN_2026-11-22.md 1-3)
-- 제목은 독립 문장으로 저장하고, 문장 번호(1부터)를 heads에 남긴다. 화면은 이 번호의 문장을 굵게 보여 주고 근거 선택에서 뺀다.
-- 문장 텍스트에 ** 같은 표시를 섞지 않는 이유: 임베딩·복붙 감지·정답 유출 검사가 모두 문장 텍스트를 쓰기 때문이다.
-- 적용 순서: 이 migration을 먼저 적용한 뒤 Edge Function을 배포한다. (함수는 컬럼이 없으면 제목 정보 없이 저장·조회하도록 방어해 두었다.)
alter table public.chunks add column if not exists heads integer[] not null default '{}';

-- 계획 후보 검색도 제목 번호를 함께 돌려준다(제목 문장이 핵심 발췌로 뽑히지 않게 cleanPlan이 쓴다).
drop function if exists public.match_chunks(uuid, extensions.vector, integer);
create function public.match_chunks(
  p_source uuid,
  p_query  extensions.vector(384),
  p_k      integer default 16
)
returns table (id text, idx integer, sec text, sentences jsonb, heads integer[], similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select c.id, c.idx, c.sec, c.sentences, c.heads, 1 - (c.embedding <=> p_query) as similarity
  from public.chunks c
  where c.source_id = p_source and c.embedding is not null
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 64));
$$;
