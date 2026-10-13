import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  presignR2Put, deriveSigningKey, signSession, verifySession, readCookie,
  publicVideo, safeSlug
} from '../functions/api/_lib.js';
import { onRequestGet as sessionGet } from '../functions/api/session.js';
import { onRequestPost as loginPost } from '../functions/api/login.js';
import { onRequestPost as logoutPost } from '../functions/api/logout.js';
import { onRequestPost as uploadUrlPost } from '../functions/api/upload-url.js';
import { onRequestGet as videosGet, onRequestPost as videosPost } from '../functions/api/videos/index.js';
import { onRequestDelete as videoDelete } from '../functions/api/videos/[id].js';
import { parseRange } from '../functions/media/[[path]].js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + ' :: ' + err.message); }
}

class MockBucket {
  constructor() { this.map = new Map(); }
  async put(key, value) { this.map.set(key, String(value)); return { key }; }
  async get(key) {
    if (!this.map.has(key)) return null;
    const text = this.map.get(key);
    return { text: async () => text, json: async () => JSON.parse(text) };
  }
  async delete(key) { this.map.delete(key); }
}

const ENV = {
  BUCKET: new MockBucket(),
  ADMIN_PASSWORD: 'correct horse battery staple',
  SESSION_SECRET: 'test-secret-do-not-use',
  PUBLIC_MEDIA_BASE: 'https://pub-test.r2.dev',
  R2_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  R2_BUCKET_NAME: 'vfx-portfolio'
};

function ctx(env, opts) {
  const o = opts || {};
  const headers = {};
  if (o.cookie) headers.cookie = o.cookie;
  if (o.body) headers['content-type'] = 'application/json';
  const request = new Request('https://portfolio.example/api/x', {
    method: o.method || 'GET',
    headers: headers,
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  return { request: request, env: env, params: o.params || {} };
}
function nodeHmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }

console.log('node ' + process.version);

// 1) AWS 官方签名密钥派生向量（规格锚点）
await test('SigV4 signing key matches published AWS vector', async () => {
  const key = await deriveSigningKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam');
  assert.equal(Buffer.from(key).toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
});

// 2) 预签名与 node:crypto 独立实现交叉验证
const FIXED = new Date('2026-08-14T12:00:00.000Z');
let signed;
await test('presign canonical request is well formed', async () => {
  signed = await presignR2Put({
    accountId: 'acct123', accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: ENV.R2_SECRET_ACCESS_KEY, bucket: 'vfx-portfolio',
    key: 'videos/abc123/斩击 特效 v2.mp4', expires: 3600, now: FIXED
  });
  const lines = signed.canonicalRequest.split(String.fromCharCode(10));
  assert.equal(lines[0], 'PUT');
  assert.equal(lines[1], '/vfx-portfolio/videos/abc123/%E6%96%A9%E5%87%BB%20%E7%89%B9%E6%95%88%20v2.mp4');
  assert.equal(lines[2].indexOf('X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential='), 0);
  assert.equal(lines[3], 'host:acct123.r2.cloudflarestorage.com');
  assert.equal(lines[4], '');
  assert.equal(lines[5], 'host');
  assert.equal(lines[6], 'UNSIGNED-PAYLOAD');
  assert.ok(signed.stringToSign.indexOf('20260814/auto/s3/aws4_request') > 0);
});
await test('presign signature equals independent node:crypto computation', async () => {
  const kDate = nodeHmac(Buffer.from('AWS4' + ENV.R2_SECRET_ACCESS_KEY), '20260814');
  const kRegion = nodeHmac(kDate, 'auto');
  const kService = nodeHmac(kRegion, 's3');
  const kSigning = nodeHmac(kService, 'aws4_request');
  const expected = nodeHmac(kSigning, signed.stringToSign).toString('hex');
  assert.equal(signed.signature, expected);
  assert.ok(signed.url.indexOf('&X-Amz-Signature=' + expected) > 0);
  assert.ok(signed.url.indexOf('https://acct123.r2.cloudflarestorage.com/vfx-portfolio/videos/') === 0);
});
await test('presign url survives URL parsing with the encoded key', async () => {
  const parsed = new URL(signed.url);
  assert.equal(parsed.host, 'acct123.r2.cloudflarestorage.com');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '3600');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

await test('presign 支持自定义 endpoint 与 region（换存储不改代码）', async () => {
  const s = await presignR2Put({
    accountId: 'acct123', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b',
    key: 'k.mp4', host: 'cos.ap-guangzhou.myqcloud.com', region: 'ap-guangzhou', now: FIXED
  });
  const lines = s.canonicalRequest.split(String.fromCharCode(10));
  assert.equal(lines[3], 'host:cos.ap-guangzhou.myqcloud.com');
  assert.ok(s.stringToSign.indexOf('20260814/ap-guangzhou/s3/aws4_request') > 0);
  assert.equal(s.url.indexOf('https://cos.ap-guangzhou.myqcloud.com/b/k.mp4?'), 0);
});
// 3) 会话
await test('session round-trips and rejects tampering', async () => {
  const token = await signSession(ENV.SESSION_SECRET, 60);
  assert.equal(await verifySession(ENV.SESSION_SECRET, token), true);
  assert.equal(await verifySession('other-secret', token), false);
  assert.equal(await verifySession(ENV.SESSION_SECRET, token + 'a'), false);
  assert.equal(await verifySession(ENV.SESSION_SECRET, 'garbage'), false);
});
await test('expired session is rejected', async () => {
  const token = await signSession(ENV.SESSION_SECRET, -10);
  assert.equal(await verifySession(ENV.SESSION_SECRET, token), false);
});
await test('cookie parsing picks the right cookie', async () => {
  const req = new Request('https://x/', { headers: { cookie: 'a=1; vfx_session=tok; b=2' } });
  assert.equal(readCookie(req, 'vfx_session'), 'tok');
  assert.equal(readCookie(req, 'missing'), null);
});

// 4) 登录
let cookieHeader = null;
await test('login rejects wrong password', async () => {
  const res = await loginPost(ctx(ENV, { method: 'POST', body: { password: 'nope' } }));
  assert.equal(res.status, 401);
});
await test('login accepts correct password and sets HttpOnly cookie', async () => {
  const res = await loginPost(ctx(ENV, { method: 'POST', body: { password: ENV.ADMIN_PASSWORD } }));
  assert.equal(res.status, 200);
  cookieHeader = res.headers.get('set-cookie');
  assert.ok(cookieHeader.indexOf('vfx_session=') === 0);
  assert.ok(cookieHeader.indexOf('HttpOnly') > 0);
  assert.ok(cookieHeader.indexOf('SameSite=Strict') > 0);
});
await test('session endpoint reports authed with the cookie', async () => {
  const res = await sessionGet(ctx(ENV, { cookie: cookieHeader }));
  assert.equal((await res.json()).authed, true);
  const anon = await sessionGet(ctx(ENV, {}));
  assert.equal((await anon.json()).authed, false);
});
await test('logout clears the cookie', async () => {
  const res = await logoutPost(ctx(ENV, { method: 'POST' }));
  assert.ok(res.headers.get('set-cookie').indexOf('Max-Age=0') > 0);
});

await test('upload-url 会把 R2_ENDPOINT 转成签名用的 host', async () => {
  const env2 = Object.assign({}, ENV, { R2_ENDPOINT: 'https://cos.ap-guangzhou.myqcloud.com' });
  const res = await uploadUrlPost(ctx(env2, { method: 'POST', cookie: cookieHeader, body: { filename: 'a.mp4' } }));
  const data = await res.json();
  assert.ok(data.uploadUrl.indexOf('https://cos.ap-guangzhou.myqcloud.com/') === 0);
});

// 5) 权限边界
await test('protected routes reject anonymous callers', async () => {
  assert.equal((await uploadUrlPost(ctx(ENV, { method: 'POST', body: { filename: 'a.mp4' } }))).status, 401);
  assert.equal((await videosPost(ctx(ENV, { method: 'POST', body: { title: 'x', videoKey: 'videos/a/a.mp4' } }))).status, 401);
  assert.equal((await videoDelete(ctx(ENV, { method: 'DELETE', params: { id: 'a' } }))).status, 401);
});

// 6) 上传直传 URL
let upload;
await test('upload-url returns a presigned R2 PUT for the admin', async () => {
  const res = await uploadUrlPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: { filename: '大招 特效 final.mp4' } }));
  assert.equal(res.status, 200);
  upload = await res.json();
  assert.ok(upload.id.length === 12);
  assert.ok(upload.key.indexOf('videos/' + upload.id + '/') === 0);
  assert.ok(upload.key.endsWith('.mp4'));
  assert.ok(upload.uploadUrl.indexOf('X-Amz-Signature=') > 0);
  assert.equal(upload.publicUrl, 'https://pub-test.r2.dev/' + upload.key);
});
await test('upload-url rejects path traversal in filename', async () => {
  const res = await uploadUrlPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: { filename: '../../etc/passwd.mp4' } }));
  const data = await res.json();
  assert.ok(data.key.indexOf('..') < 0);
  assert.ok(data.key.indexOf('videos/') === 0);
});

// 7) 清单增删改查
await test('public list starts empty and needs no auth', async () => {
  const res = await videosGet(ctx(ENV, {}));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.count, 0);
});
let created;
await test('admin can create a video record', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    title: '爆裂斩 · 三版本迭代', description: '剪影三帧 + hitstop + 4 段色阶',
    tags: ['斩击', '二次元', '色阶'], engine: 'UE5', role: '特效设计',
    videoKey: upload.key, posterKey: 'videos/' + upload.id + '/poster.jpg',
    duration: 12.5, size: 41300000
  } }));
  assert.equal(res.status, 201);
  created = (await res.json()).video;
  assert.equal(created.poster, 'https://pub-test.r2.dev/videos/' + upload.id + '/poster.jpg');
  assert.deepEqual(created.tags, ['斩击', '二次元', '色阶']);
});
await test('rejects records without a title or with a foreign key', async () => {
  assert.equal((await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: { title: '  ', videoKey: upload.key } }))).status, 400);
  assert.equal((await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: { title: 'x', videoKey: 'evil/x.mp4' } }))).status, 400);
});
await test('public list exposes tags and media urls', async () => {
  const data = await (await videosGet(ctx(ENV, {}))).json();
  assert.equal(data.count, 1);
  assert.deepEqual(data.tags, ['二次元', '斩击', '色阶']);
  assert.equal(data.videos[0].url, 'https://pub-test.r2.dev/' + upload.key);
});
await test('metadata edit keeps the same id', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    id: created.id, title: '爆裂斩 · 三版本迭代（改）', videoKey: created.url.replace('https://pub-test.r2.dev/', ''),
    description: '改过', tags: ['斩击']
  } }));
  const data = await res.json();
  assert.equal(data.created, false);
  assert.equal(data.video.id, created.id);
  assert.equal(data.video.title, '爆裂斩 · 三版本迭代（改）');
  const list = await (await videosGet(ctx(ENV, {}))).json();
  assert.equal(list.count, 1);
});
await test('编辑文案时不传 videoKey 也能保存（管理页改标签就是这么发的）', async () => {
  const before = (await (await videosGet(ctx(ENV, {}))).json()).videos.filter(function (v) { return v.id === created.id; })[0];
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    id: created.id, title: before.title, description: before.description,
    tags: ['标签改过了', '新标签']
  } }));
  assert.equal(res.status, 200, '编辑保存被服务端拒绝了（线上真实故障）');
  const v = (await res.json()).video;
  assert.deepEqual(v.tags, ['标签改过了', '新标签']);
  assert.equal(v.url, before.url, '编辑不该改动视频地址');
});
await test('编辑时传了非法 videoKey 仍然会被拒绝', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    id: created.id, title: 'x', videoKey: 'evil/x.mp4'
  } }));
  assert.equal(res.status, 400);
});
await test('编辑不会动 videoKey 与 posterKey', async () => {
  const list = await (await videosGet(ctx(ENV, {}))).json();
  const v = list.videos.filter(function (x) { return x.id === created.id; })[0];
  assert.equal(v.url, 'https://pub-test.r2.dev/' + upload.key);
  assert.equal(v.poster, 'https://pub-test.r2.dev/videos/' + upload.id + '/poster.jpg');
});
await test('新增时仍然必须有 videoKey', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: { title: '没有 key 的新作品' } }));
  assert.equal(res.status, 400);
});

await test('delete removes object bytes and the manifest entry', async () => {
  const res = await videoDelete(ctx(ENV, { method: 'DELETE', cookie: cookieHeader, params: { id: created.id } }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.removed.length, 2);
  assert.equal(ENV.BUCKET.map.has(upload.key), false);
  assert.equal(ENV.BUCKET.map.has('videos/' + upload.id + '/poster.jpg'), false);
  const list = await (await videosGet(ctx(ENV, {}))).json();
  assert.equal(list.count, 0);
});
await test('deleting an unknown id returns 404', async () => {
  assert.equal((await videoDelete(ctx(ENV, { method: 'DELETE', cookie: cookieHeader, params: { id: 'nope' } }))).status, 404);
});

// 8) 辅助函数
await test('safeSlug strips chinese, spaces and traversal', async () => {
  assert.equal(safeSlug('大招 特效 final.mp4'), 'final.mp4');
  assert.equal(safeSlug('纯中文文件名.mp4'), 'clip.mp4');
  assert.equal(safeSlug('../../etc/passwd'), 'passwd.mp4');
  assert.equal(safeSlug('clip.MOV'), 'clip.mov');
});

await test('中文逗号/顿号分隔的标签会被正确拆开（真实踩过的坑）', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    title: '标签分隔测试', videoKey: 'videos/' + created.id + '/x.mp4',
    tags: ['二次元，斩击，连战', '冲刺、速度感', ' 色阶 ']
  } }));
  assert.equal(res.status, 201);
  const v = (await res.json()).video;
  assert.deepEqual(v.tags, ['二次元', '斩击', '连战', '冲刺', '速度感', '色阶']);
  await videoDelete(ctx(ENV, { method: 'DELETE', cookie: cookieHeader, params: { id: v.id } }));
});
await test('读取旧数据时也会顺手修好被合并的标签', async () => {
  const res = await videosPost(ctx(ENV, { method: 'POST', cookie: cookieHeader, body: {
    title: '旧数据', videoKey: 'videos/' + created.id + '/y.mp4', tags: ['二次元，斩击']
  } }));
  const v = (await res.json()).video;
  const list = await (await videosGet(ctx(ENV, {}))).json();
  const found = list.videos.filter(function (x) { return x.id === v.id; })[0];
  assert.deepEqual(found.tags, ['二次元', '斩击']);
  assert.ok(list.tags.indexOf('二次元') >= 0);
  await videoDelete(ctx(ENV, { method: 'DELETE', cookie: cookieHeader, params: { id: v.id } }));
});

// 9) 播放地址与 Range
await test('PUBLIC_MEDIA_BASE 是占位符时自动回落到同源 /media', async () => {
  const envBad = Object.assign({}, ENV, { PUBLIC_MEDIA_BASE: 'https://pub-REPLACE-ME.r2.dev' });
  const envNone = Object.assign({}, ENV, { PUBLIC_MEDIA_BASE: '' });
  const envGood = Object.assign({}, ENV, { PUBLIC_MEDIA_BASE: 'https://pub-abc123.r2.dev/' });
  assert.equal(publicVideo({ id: 'x', videoKey: 'videos/a.mp4' }, envBad).url, '/media/videos/a.mp4');
  assert.equal(publicVideo({ id: 'x', videoKey: 'videos/a.mp4' }, envNone).url, '/media/videos/a.mp4');
  assert.equal(publicVideo({ id: 'x', videoKey: 'videos/a.mp4' }, envGood).url, 'https://pub-abc123.r2.dev/videos/a.mp4');
});
await test('Range 解析覆盖首段/中段/尾段/越界', async () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { offset: 0, length: 100 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { offset: 500, length: 500 });
  assert.deepEqual(parseRange('bytes=-200', 1000), { offset: 800, length: 200 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { offset: 900, length: 100 });
  assert.equal(parseRange('bytes=1000-', 1000).unsatisfiable, true);
  assert.equal(parseRange('', 1000), null);
  assert.equal(parseRange('items=0-10', 1000), null);
});

console.log('');
console.log('passed ' + passed + ', failed ' + failures.length);
if (failures.length) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
