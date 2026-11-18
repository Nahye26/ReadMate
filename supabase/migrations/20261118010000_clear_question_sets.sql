-- 미션 구성 규칙이 바뀌어(요구 항목당 1~3개, 기본 6개, 세션 최소 30분) 이전 규칙으로 만든 질문 세트를 비운다.
-- sessions.question_set_id는 on delete set null이라 세션 기록은 남는다.
delete from public.question_sets;
