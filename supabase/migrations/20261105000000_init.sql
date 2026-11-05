-- ReadMate 초기 스키마
-- 원칙: 클라이언트(익명 로그인 사용자)는 자기 데이터를 "읽기"만 한다. 모든 쓰기는 Edge Function(service role)이 한다.
-- 적용 전 확인: embedding 차원(384)은 임베딩 모델을 바꾸면 함께 바꿔야 한다. docs/DESIGN.md 8절 참고.

create extension if not exists vector with schema extensions;

-- 1. 읽기 자료 -------------------------------------------------------------
create table public.sources (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade,
  title      text not null,
  lang       text check (lang in ('ko', 'en')),
  pages      integer,
  created_at timestamptz not null default now()
);

-- 청크: 데모의 청크 구조(문장 3개 또는 300자 단위, ID는 'p3-1' 형태)를 그대로 쓴다.
create table public.chunks (
  source_id uuid not null references public.sources (id) on delete cascade,
  id        text not null,
  idx       integer not null,                 -- 자료 안에서의 순서 (조건 B의 앞뒤 문단 조회에 사용)
  sec       text not null,
  sentences jsonb not null,                   -- 문장 배열. 문장 번호는 1부터
  text      text not null,
  embedding extensions.vector(384),
  primary key (source_id, id),
  unique (source_id, idx)
);
create index chunks_embedding_idx on public.chunks using hnsw (embedding extensions.vector_cosine_ops);

-- 2. 세션 ------------------------------------------------------------------
create table public.sessions (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null references auth.users (id) on delete cascade,
  source_id         uuid references public.sources (id) on delete set null,
  condition         text check (condition in ('A', 'B')),   -- A=발췌형, B=맥락형. null이면 일반 모드
  experiment_mode   boolean not null default false,         -- true: 안내 수준 고정, 질문 깊이 고정
  prompt_version    text not null,
  researcher        text,
  paper_id          text,
  assignment        text,                                   -- 과제 안내문. 종료 시 동의가 없으면 비운다
  consent_research  boolean not null default false,         -- 세션 요약(횟수·점수) 익명 저장 동의
  consent_answers   boolean not null default false,         -- 학생 답변 원문 저장 동의
  config            jsonb not null default '{}'::jsonb,     -- fade, adaptDepth 등 실행 시 설정
  summary           jsonb,                                  -- 종료 시 로그 (eval/ 의 v0.5 스키마)
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  check (condition is not null or not experiment_mode)      -- 실험 모드에는 조건이 필요
);

-- 3. 미션 ------------------------------------------------------------------
-- 학생에게 보이는 부분. 판정 기준(key_points)은 여기에 두지 않는다.
create table public.missions (
  session_id uuid not null references public.sessions (id) on delete cascade,
  idx        integer not null,                -- 0부터
  req        integer not null,
  picks      jsonb not null,                  -- [[chunkId, from, to], ...]
  variants   jsonb not null,                  -- [{qtype, question, cue, frame}, ...]  (key_points 제외)
  primary key (session_id, idx)
);

-- 판정 기준: RLS는 켜고 정책은 만들지 않는다. service role만 읽는다.
create table public.mission_secrets (
  session_id uuid not null,
  idx        integer not null,
  key_points jsonb not null,                  -- {"literal": ["..."], "inferential": ["...", "..."]}
  primary key (session_id, idx),
  foreign key (session_id, idx) references public.missions (session_id, idx) on delete cascade
);

-- 4. 진행 기록 ---------------------------------------------------------------
create table public.turns (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.sessions (id) on delete cascade,
  mission_idx integer,
  kind        text not null check (kind in ('answer', 'hint', 'recall', 'fix')),
  payload     jsonb not null default '{}'::jsonb,   -- 답변 원문은 sessions.consent_answers가 true일 때만 저장
  at          timestamptz not null default now()
);
create index turns_session_idx on public.turns (session_id, at);

create table public.events (
  id         bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  t          numeric not null,                      -- 세션 시작 후 경과 초
  type       text not null,
  data       jsonb not null default '{}'::jsonb
);
create index events_session_idx on public.events (session_id, id);

-- 5. 행 수준 보안 --------------------------------------------------------------
alter table public.sources         enable row level security;
alter table public.chunks          enable row level security;
alter table public.sessions        enable row level security;
alter table public.missions        enable row level security;
alter table public.mission_secrets enable row level security;
alter table public.turns           enable row level security;
alter table public.events          enable row level security;

create policy sources_select_own on public.sources
  for select to authenticated using (owner = (select auth.uid()));

create policy chunks_select_own on public.chunks
  for select to authenticated using (
    exists (select 1 from public.sources s where s.id = chunks.source_id and s.owner = (select auth.uid()))
  );

create policy sessions_select_own on public.sessions
  for select to authenticated using (owner = (select auth.uid()));

create policy missions_select_own on public.missions
  for select to authenticated using (
    exists (select 1 from public.sessions s where s.id = missions.session_id and s.owner = (select auth.uid()))
  );

create policy turns_select_own on public.turns
  for select to authenticated using (
    exists (select 1 from public.sessions s where s.id = turns.session_id and s.owner = (select auth.uid()))
  );

create policy events_select_own on public.events
  for select to authenticated using (
    exists (select 1 from public.sessions s where s.id = events.session_id and s.owner = (select auth.uid()))
  );

-- 쓰기 정책은 일부러 만들지 않는다. (insert/update/delete는 service role 전용)
revoke all on public.mission_secrets from anon, authenticated;
revoke insert, update, delete on public.sources, public.chunks, public.sessions,
  public.missions, public.turns, public.events from anon, authenticated;

-- 6. 검색 ------------------------------------------------------------------
-- 과제 안내문의 임베딩으로 관련 청크를 찾는다. (데모의 LLM prefilter 대체)
-- security invoker(기본값)라서 authenticated 호출자에게는 위 RLS가 적용된다.
-- service role로 호출할 때는 함수 호출 전에 source 소유자를 직접 확인해야 한다.
create or replace function public.match_chunks(
  p_source uuid,
  p_query  extensions.vector(384),
  p_k      integer default 16
)
returns table (id text, idx integer, sec text, sentences jsonb, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select c.id, c.idx, c.sec, c.sentences, 1 - (c.embedding <=> p_query) as similarity
  from public.chunks c
  where c.source_id = p_source and c.embedding is not null
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 64));
$$;

-- 7. 연구용 요약 조회 ---------------------------------------------------------
-- 동의한 세션의 요약만 모아 본다. 연구자 집계는 service role로 이 뷰를 조회한다.
create view public.research_summaries with (security_invoker = true) as
  select id, condition, experiment_mode, paper_id, prompt_version, researcher,
         summary, started_at, finished_at
  from public.sessions
  where consent_research and summary is not null;
