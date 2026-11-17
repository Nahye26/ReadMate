-- 질문 세트 고정 + 조건 B의 컨텍스트 청크 (2026-11-17 결정, docs/DESIGN.md 6절)
-- 원칙: 실험 모드(효과성 검증)에서는 질문 세트를 AI가 (자료, 과제 안내문)마다 A 기준으로 한 번만 만들어 저장하고 A/B 세션이 같은 세트를 쓴다.
--       사용성 테스트(B만)에서는 세션마다 새로 만들고 저장하지 않으므로 sessions.question_set_id는 null이다.
-- 적용 순서: 20261105000000_init.sql 다음. 아직 DB에 적용한 적이 없으므로 두 파일을 순서대로 db push 하면 된다.

-- 1. 공유 자료 ---------------------------------------------------------------
-- 같은 논문을 여러 참가자가 읽을 때 질문 세트를 논문 단위로 고정하려면 자료를 참가자 사이에 공유해야 한다.
-- shared = true 인 자료는 소유자가 아니어도 plan-session에서 쓸 수 있다.
-- 설정은 연구자가 service role(SQL 편집기)로만 한다. (authenticated의 sources 쓰기 권한은 init에서 회수됨)
alter table public.sources add column shared boolean not null default false;

-- 2. 질문 세트 ---------------------------------------------------------------
-- plan 안에는 판정 기준(key_points)이 들어 있으므로 mission_secrets처럼 service role만 읽는다.
-- plan 형식(core.ts PlanData): { reqs: string[], missions: [{ req, pick: [chunkId, from, to], vars: [{ qtype, q, keys, cue, frame }] }] }
create table public.question_sets (
  id              uuid primary key default gen_random_uuid(),
  source_id       uuid not null references public.sources (id) on delete cascade,
  assignment_hash text not null,                   -- 과제 안내문(+fast 여부)의 SHA-256. 안내문 원문은 저장하지 않는다.
  paper_id        text,
  model           text,                            -- 생성에 쓴 LLM (GEMINI_MODEL)
  plan            jsonb not null,
  created_at      timestamptz not null default now(),
  unique (source_id, assignment_hash)
);
alter table public.question_sets enable row level security;
revoke all on public.question_sets from anon, authenticated;

alter table public.sessions add column question_set_id uuid references public.question_sets (id) on delete set null;

-- 3. 미션의 제공 청크 ----------------------------------------------------------
-- 조건 A: [핵심 청크], 조건 B: [앞, 핵심, 뒤] (같은 절 안에서만). 길이가 곧 text_units_provided 이다.
alter table public.missions add column context_ids jsonb not null default '[]'::jsonb;
