import { json, fail, isAuthed, presignR2Put, newId, safeSlug, mediaUrl } from './_lib.js';

const NEEDED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return fail(401, '未登录');
  for (let i = 0; i < NEEDED.length; i++) {
    if (!env[NEEDED[i]]) return fail(500, '缺少环境变量 ' + NEEDED[i]);
  }
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, '请求体不是合法 JSON'); }
  const kind = body && body.kind === 'poster' ? 'poster' : 'video';
  const id = body && body.id ? newIdLike(String(body.id)) : newId();
  const bucket = env.R2_BUCKET_NAME || 'vfx-portfolio';
  const key = kind === 'poster'
    ? 'videos/' + id + '/poster.jpg'
    : 'videos/' + id + '/' + safeSlug(body && body.filename);
  const signed = await presignR2Put({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: bucket,
    key: key,
    expires: 3600,
    host: hostOf(env.R2_ENDPOINT),
    region: env.R2_REGION || 'auto'
  });
  return json({ id: id, key: key, kind: kind, uploadUrl: signed.url, publicUrl: mediaUrl(env, key), expiresIn: 3600 });
}

// 允许用 R2_ENDPOINT 指向任意 S3 兼容端点（腾讯云 COS / 七牛 / B2 / MinIO），换存储不必改代码
function hostOf(value) {
  if (!value) return undefined;
  const s = String(value);
  const i = s.indexOf('://');
  const rest = i >= 0 ? s.slice(i + 3) : s;
  return rest.split('/')[0];
}

function newIdLike(value) {
  let out = '';
  for (let i = 0; i < value.length && out.length < 24; i++) {
    const c = value.charAt(i);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') out += c;
  }
  return out || newId();
}
