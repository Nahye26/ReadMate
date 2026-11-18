// 실행: node --test supabase/functions/_shared/embed.test.ts
import test from 'node:test';
import assert from 'node:assert';
import { parseGeminiError } from './embed.ts';

test('임베딩 오류: 일일 한도(PerDay)는 daily로 판정하고 메시지를 끝까지 보존한다', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details. ' + 'x'.repeat(300),
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier' }] }],
    },
  });
  const r = parseGeminiError(body);
  assert.strictEqual(r.daily, true);
  assert.ok(r.message.length > 200); // 예전처럼 200자에서 자르지 않는다
});

test('임베딩 오류: 한도 0(무료 한도가 열리지 않은 계정)도 daily로 본다', () => {
  assert.strictEqual(parseGeminiError('Quota exceeded for metric: embed_content_free_tier_requests, limit: 0').daily, true);
});

test('임베딩 오류: 분당 한도는 daily가 아니고 권장 대기 시간을 읽는다', () => {
  const body = JSON.stringify({
    error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' }, { violations: [{ quotaId: 'EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier' }] }] },
  });
  const r = parseGeminiError(body);
  assert.strictEqual(r.daily, false);
  assert.strictEqual(r.retryAfterSec, 23);
});

test('임베딩 오류: JSON이 아닌 본문도 그대로 돌려준다', () => {
  const r = parseGeminiError('upstream connect error');
  assert.strictEqual(r.message, 'upstream connect error');
  assert.strictEqual(r.daily, false);
});
