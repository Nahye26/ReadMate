-- 연결 제안(connect) 단계의 기록을 turns에 남기기 위해 kind에 'connect'를 추가한다.
alter table public.turns drop constraint if exists turns_kind_check;
alter table public.turns add constraint turns_kind_check check (kind in ('answer', 'hint', 'recall', 'fix', 'connect'));
