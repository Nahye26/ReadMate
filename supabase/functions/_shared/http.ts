// Edge Function 공통: CORS, JSON 응답, service role 클라이언트, 호출자 확인
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 는 Supabase가 Edge Function 환경에 자동으로 넣어 준다. 저장소에 값을 두지 않는다.
import { createClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
}

// Authorization 헤더의 사용자 JWT(익명 로그인 포함)를 확인해 사용자를 돌려준다.
export async function authedUser(req: Request) {
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await serviceClient().auth.getUser(token);
  return error ? null : data.user;
}
