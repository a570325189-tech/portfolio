import { json, fail, isAuthed, readManifest, writeManifest, publicVideo, newId, normalizeTags } from '../_lib.js';

function sorted(videos) {
  return videos.slice().sort(function (a, b) {
    const ao = typeof a.order === 'number' ? a.order : 0;
    const bo = typeof b.order === 'number' ? b.order : 0;
    if (ao !== bo) return bo - ao;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

export async function onRequestGet(context) {
  if (!context.env.BUCKET) return fail(500, '缺少 R2 绑定 BUCKET');
  const manifest = await readManifest(context.env);
  const videos = sorted(manifest.videos).map(function (v) { return publicVideo(v, context.env); });
  const tags = [];
  videos.forEach(function (v) {
    v.tags.forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); });
  });
  tags.sort();
  return json({ updated: manifest.updated, count: videos.length, tags: tags, videos: videos },
    { headers: { 'cache-control': 'public, max-age=60' } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!(await isAuthed(context))) return fail(401, '未登录');
  if (!env.BUCKET) return fail(500, '缺少 R2 绑定 BUCKET');
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, '请求体不是合法 JSON'); }
  const title = body && body.title ? String(body.title).trim() : '';
  if (!title) return fail(400, '标题不能为空');

  const manifest = await readManifest(env);
  const now = new Date().toISOString();
  const tags = normalizeTags(body.tags);
  const existing = body && body.id
    ? manifest.videos.filter(function (v) { return v.id === body.id; })[0]
    : null;

  // videoKey 只在"新增"时必填。
  // 编辑文案时前端拿不到它（列表接口不暴露内部 key，这是有意的），所以缺省即沿用原值。
  // 以前这里无条件校验，导致"改个标签保存"必然报 videoKey 非法。
  const videoKey = body && body.videoKey ? String(body.videoKey) : '';
  if (videoKey && videoKey.indexOf('videos/') !== 0) return fail(400, 'videoKey 非法');
  if (!existing && !videoKey) return fail(400, 'videoKey 非法');
  const posterKey = body && body.posterKey ? String(body.posterKey) : null;
  if (posterKey && posterKey.indexOf('videos/') !== 0) return fail(400, 'posterKey 非法');

  if (existing) {
    existing.title = title;
    existing.description = body.description ? String(body.description) : '';
    existing.tags = tags;
    existing.engine = body.engine ? String(body.engine) : '';
    existing.role = body.role ? String(body.role) : '';
    existing.updatedAt = now;
    if (body.videoKey) existing.videoKey = videoKey;
    if (posterKey) existing.posterKey = posterKey;
    if (typeof body.order === 'number') existing.order = body.order;
    if (body.duration) existing.duration = Number(body.duration) || null;
    if (body.size) existing.size = Number(body.size) || null;
    await writeManifest(env, manifest);
    return json({ ok: true, video: publicVideo(existing, env), created: false });
  }

  const record = {
    id: newId(),
    title: title,
    description: body.description ? String(body.description) : '',
    tags: tags,
    engine: body.engine ? String(body.engine) : '',
    role: body.role ? String(body.role) : '',
    videoKey: videoKey,
    posterKey: posterKey,
    duration: Number(body.duration) || null,
    size: Number(body.size) || null,
    order: typeof body.order === 'number' ? body.order : 0,
    createdAt: now,
    updatedAt: now
  };
  manifest.videos.push(record);
  await writeManifest(env, manifest);
  return json({ ok: true, video: publicVideo(record, env), created: true }, { status: 201 });
}
