// 公共工具：会话签名 / R2 SigV4 预签名 / 清单读写
export const MANIFEST_KEY = '_manifest.json';
export const SESSION_COOKIE = 'vfx_session';
export const SESSION_TTL = 60 * 60 * 24 * 14;

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const encoder = new TextEncoder();

export function json(data, init) {
  const headers = Object.assign(
    { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    (init && init.headers) || {}
  );
  return new Response(JSON.stringify(data, null, 2), Object.assign({}, init, { headers: headers }));
}

export function fail(status, message) {
  return json({ error: message }, { status: status });
}

export function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? '0' + h : h;
  }
  return out;
}

export function timingSafeEqual(a, b) {
  const s1 = String(a);
  const s2 = String(b);
  if (s1.length !== s2.length) return false;
  let diff = 0;
  for (let i = 0; i < s1.length; i++) diff |= s1.charCodeAt(i) ^ s2.charCodeAt(i);
  return diff === 0;
}

async function hmacBytes(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

export async function sha256Hex(message) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(message));
  return toHex(digest);
}

// ---------- 会话 ----------
export async function signSession(secret, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + (ttlSeconds || SESSION_TTL);
  const sig = await hmacBytes(encoder.encode(String(secret)), String(exp));
  return String(exp) + '.' + toHex(sig);
}

export async function verifySession(secret, token) {
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = toHex(await hmacBytes(encoder.encode(String(secret)), String(exp)));
  return timingSafeEqual(expected, parts[1]);
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const parts = header.split(';');
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i].trim();
    const eq = item.indexOf('=');
    if (eq > 0 && item.slice(0, eq) === name) return decodeURIComponent(item.slice(eq + 1));
  }
  return null;
}

export function sessionCookie(token, maxAge) {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}

export function clearCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';
}

export async function isAuthed(context) {
  const token = readCookie(context.request, SESSION_COOKIE);
  return await verifySession(context.env.SESSION_SECRET, token);
}

// ---------- SigV4 预签名（浏览器直传 R2）----------
export function uriEncode(value, encodeSlash) {
  const str = String(value);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charAt(i);
    const ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
      || c === '-' || c === '_' || c === '.' || c === '~';
    if (ok) out += c;
    else if (c === '/' && !encodeSlash) out += c;
    else {
      const bytes = encoder.encode(c);
      for (let j = 0; j < bytes.length; j++) {
        const h = bytes[j].toString(16);
        out += '%' + (h.length === 1 ? '0' + h : h).toUpperCase();
      }
    }
  }
  return out;
}

export async function deriveSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = await hmacBytes(encoder.encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacBytes(kDate, region);
  const kService = await hmacBytes(kRegion, service);
  return await hmacBytes(kService, 'aws4_request');
}

export async function signWithKey(keyBytes, stringToSign) {
  return toHex(await hmacBytes(keyBytes, stringToSign));
}

export async function presignR2Put(opts) {
  const region = opts.region || 'auto';
  const service = 's3';
  const expires = opts.expires || 3600;
  const now = opts.now || new Date();
  const host = opts.host || (opts.accountId + '.r2.cloudflarestorage.com');
  const iso = now.toISOString();
  const dateStamp = iso.slice(0, 10).split('-').join('');
  const timeStamp = iso.slice(11, 19).split(':').join('');
  const amzDate = dateStamp + 'T' + timeStamp + 'Z';
  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const canonicalUri = '/' + uriEncode(opts.bucket, true) + '/' + uriEncode(opts.key, false);
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', opts.accessKeyId + '/' + scope],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host']
  ];
  params.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); });
  const canonicalQuery = params.map(function (p) {
    return uriEncode(p[0], true) + '=' + uriEncode(p[1], true);
  }).join('&');
  const canonicalRequest = ['PUT', canonicalUri, canonicalQuery, 'host:' + host + NL, 'host', 'UNSIGNED-PAYLOAD'].join(NL);
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join(NL);
  const signingKey = await deriveSigningKey(opts.secretAccessKey, dateStamp, region, service);
  const signature = await signWithKey(signingKey, stringToSign);
  return {
    url: 'https://' + host + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature,
    key: opts.key,
    amzDate: amzDate,
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signature: signature
  };
}

// ---------- 清单 ----------
export async function readManifest(env) {
  const object = await env.BUCKET.get(MANIFEST_KEY);
  if (!object) return { version: 1, updated: null, videos: [] };
  try {
    const parsed = JSON.parse(await object.text());
    if (!parsed || !Array.isArray(parsed.videos)) return { version: 1, updated: null, videos: [] };
    return parsed;
  } catch (e) {
    return { version: 1, updated: null, videos: [] };
  }
}

export async function writeManifest(env, manifest) {
  manifest.version = 1;
  manifest.updated = new Date().toISOString();
  await env.BUCKET.put(MANIFEST_KEY, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' }
  });
  return manifest;
}

export function mediaUrl(env, key) {
  const base = String(env.PUBLIC_MEDIA_BASE || '').replace(/[/]+$/, '');
  return base + '/' + key;
}

export function publicVideo(v, env) {
  return {
    id: v.id,
    title: v.title || '未命名',
    description: v.description || '',
    tags: Array.isArray(v.tags) ? v.tags : [],
    engine: v.engine || '',
    role: v.role || '',
    duration: v.duration || null,
    size: v.size || null,
    createdAt: v.createdAt || null,
    updatedAt: v.updatedAt || null,
    url: v.videoKey ? mediaUrl(env, v.videoKey) : '',
    poster: v.posterKey ? mediaUrl(env, v.posterKey) : null,
    order: typeof v.order === 'number' ? v.order : 0
  };
}

export function newId() {
  return crypto.randomUUID().split('-').join('').slice(0, 12);
}

export function safeSlug(name) {
  const base = String(name || 'file').split('/').pop().split(BS).pop();
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  let clean = '';
  for (let i = 0; i < stem.length; i++) {
    const c = stem.charAt(i);
    const ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_';
    if (ok) clean += c;
    else if (c === ' ' || c === '.') clean += '-';
  }
  while (clean.indexOf('--') >= 0) clean = clean.split('--').join('-');
  while (clean.length > 0 && clean.charAt(0) === '-') clean = clean.slice(1);
  while (clean.length > 0 && clean.charAt(clean.length - 1) === '-') clean = clean.slice(0, clean.length - 1);
  clean = clean.slice(0, 48) || 'clip';
  const allowed = ['mp4', 'mov', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp'];
  const safeExt = allowed.indexOf(ext) >= 0 ? ext : 'mp4';
  return clean + '.' + safeExt;
}
