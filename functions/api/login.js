import { json, fail, signSession, sessionCookie, timingSafeEqual, SESSION_TTL } from './_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, '请求体不是合法 JSON'); }
  const password = body && body.password ? String(body.password) : '';
  const expected = env.ADMIN_PASSWORD || '';
  if (!expected) return fail(500, '服务端未配置 ADMIN_PASSWORD');
  if (!password || !timingSafeEqual(password, expected)) {
    await new Promise(function (resolve) { setTimeout(resolve, 500); });
    return fail(401, '密码错误');
  }
  if (!env.SESSION_SECRET) return fail(500, '服务端未配置 SESSION_SECRET');
  const token = await signSession(env.SESSION_SECRET, SESSION_TTL);
  return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token, SESSION_TTL) } });
}
