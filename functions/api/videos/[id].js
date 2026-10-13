import { json, fail, isAuthed, readManifest, writeManifest, publicVideo } from '../_lib.js';

export async function onRequestGet(context) {
  const manifest = await readManifest(context.env);
  const found = manifest.videos.filter(function (v) { return v.id === context.params.id; })[0];
  if (!found) return fail(404, '未找到该视频');
  return json({ video: publicVideo(found, context.env) });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  if (!(await isAuthed(context))) return fail(401, '未登录');
  const manifest = await readManifest(env);
  const found = manifest.videos.filter(function (v) { return v.id === params.id; })[0];
  if (!found) return fail(404, '未找到该视频');
  const removed = [];
  const keys = [found.videoKey, found.posterKey];
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i]) continue;
    try {
      await env.BUCKET.delete(keys[i]);
      removed.push(keys[i]);
    } catch (e) {
      return fail(500, '删除对象失败：' + keys[i]);
    }
  }
  manifest.videos = manifest.videos.filter(function (v) { return v.id !== params.id; });
  await writeManifest(env, manifest);
  return json({ ok: true, removed: removed });
}
