// 同源媒体代理：/media/<key> 直接从 R2 绑定读视频流。
// 这样不必开启公有桶、不依赖 r2.dev（有限速），也没有跨域问题。
// 必须支持 HTTP Range，否则浏览器拖动进度条会失败，Safari 甚至可能拒绝播放。

export function parseRange(header, size) {
  if (!header) return null;
  const s = String(header).trim();
  if (s.indexOf('bytes=') !== 0) return null;
  const spec = s.slice(6).split(',')[0].trim();
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const a = spec.slice(0, dash).trim();
  const b = spec.slice(dash + 1).trim();
  if (a === '' && b === '') return null;
  if (a === '') {
    const n = Number(b);
    if (!isFinite(n) || n <= 0) return null;
    const start = Math.max(0, size - n);
    return { offset: start, length: size - start };
  }
  const start = Number(a);
  if (!isFinite(start) || start >= size) return { unsatisfiable: true };
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (!isFinite(end) || end < start) return { unsatisfiable: true };
  return { offset: start, length: end - start + 1 };
}

function keyOf(context) {
  const p = context.params ? context.params.path : null;
  const key = Array.isArray(p) ? p.join('/') : String(p || '');
  return key;
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.BUCKET) return new Response('R2 绑定缺失', { status: 500 });
  const key = keyOf(context);
  if (!key || key.indexOf('..') >= 0) return new Response('bad request', { status: 400 });

  const meta = await env.BUCKET.head(key);
  if (!meta) return new Response('not found', { status: 404 });

  const size = meta.size;
  const headers = new Headers();
  meta.writeHttpMetadata(headers);
  headers.set('etag', meta.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  const range = parseRange(request.headers.get('range'), size);
  if (range && range.unsatisfiable) {
    headers.set('content-range', 'bytes */' + size);
    return new Response(null, { status: 416, headers: headers });
  }
  if (range) {
    const object = await env.BUCKET.get(key, { range: { offset: range.offset, length: range.length } });
    if (!object) return new Response('not found', { status: 404 });
    headers.set('content-range', 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + size);
    headers.set('content-length', String(range.length));
    return new Response(object.body, { status: 206, headers: headers });
  }
  const object = await env.BUCKET.get(key);
  if (!object) return new Response('not found', { status: 404 });
  headers.set('content-length', String(size));
  return new Response(object.body, { status: 200, headers: headers });
}

export async function onRequestHead(context) {
  const { env } = context;
  if (!env.BUCKET) return new Response(null, { status: 500 });
  const key = keyOf(context);
  const meta = await env.BUCKET.head(key);
  if (!meta) return new Response(null, { status: 404 });
  const headers = new Headers();
  meta.writeHttpMetadata(headers);
  headers.set('etag', meta.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(meta.size));
  return new Response(null, { status: 200, headers: headers });
}
