// 针对"正在运行的服务"做端到端接口验证。
//   本地：npm run dev  然后另开一个终端  node test/integration.mjs
//   线上：node test/integration.mjs https://你的项目名.pages.dev
//
// 注意：这里不校验视频文件直传 R2 那一段（那需要真实的 R2 凭证与 CORS），
// 只校验路由、鉴权、清单增删改查这些真正容易出错的地方。

const base = (process.argv[2] || 'http://127.0.0.1:8799').replace(/[/]+$/, '');
const password = process.argv[3] || process.env.ADMIN_PASSWORD || 'local-dev-password';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + ' :: ' + err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

let cookie = '';
function h(extra) { return Object.assign(cookie ? { cookie: cookie } : {}, extra || {}); }
async function get(path) { return await fetch(base + path, { headers: h() }); }
async function post(path, body) {
  return await fetch(base + path, { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify(body || {}) });
}

console.log('目标：' + base);
console.log('');

let baseline = -1;
let createdId = null;

await test('站点首页可访问且是作品集页面', async () => {
  const res = await get('/');
  assertEq(res.status, 200, 'HTTP');
  const html = await res.text();
  assert(html.indexOf('特效作品集') > 0 || html.indexOf('site-title') > 0, '首页内容不对');
});
await test('静态资源与 config.json 正常', async () => {
  assertEq((await get('/assets/app.js')).status, 200, 'app.js');
  assertEq((await get('/assets/style.css')).status, 200, 'style.css');
  const cfg = await get('/config.json');
  assertEq(cfg.status, 200, 'config.json');
  const data = await cfg.json();
  assert(data.title, 'config.json 缺 title');
});
await test('未登录时 session 返回 authed=false', async () => {
  const data = await (await get('/api/session')).json();
  assertEq(data.authed, false, 'authed');
});
await test('作品列表公开可读', async () => {
  const res = await get('/api/videos');
  assertEq(res.status, 200, 'HTTP');
  const data = await res.json();
  assert(Array.isArray(data.videos), 'videos 不是数组');
  baseline = data.count;
});
await test('错误密码被拒绝', async () => {
  const res = await post('/api/login', { password: 'definitely-wrong' });
  assertEq(res.status, 401, 'HTTP');
});
await test('正确密码登录并下发 HttpOnly Cookie', async () => {
  const res = await post('/api/login', { password: password });
  assertEq(res.status, 200, 'HTTP（密码是否与 .dev.vars 里的 ADMIN_PASSWORD 一致？）');
  const raw = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]).filter(Boolean).join('; ');
  assert(raw.indexOf('vfx_session=') >= 0, '没有下发会话 Cookie');
  assert(raw.indexOf('HttpOnly') > 0, 'Cookie 不是 HttpOnly');
  cookie = raw.split(';')[0];
  const data = await (await get('/api/session')).json();
  assertEq(data.authed, true, '登录后 authed');
});
await test('未登录不能申请上传地址', async () => {
  const saved = cookie; cookie = '';
  const res = await post('/api/upload-url', { filename: 'x.mp4' });
  cookie = saved;
  assertEq(res.status, 401, 'HTTP');
});
await test('已登录能拿到预签名直传地址', async () => {
  const res = await post('/api/upload-url', { filename: '集成测试 斩击.mp4' });
  assertEq(res.status, 200, 'HTTP');
  const data = await res.json();
  assert(data.uploadUrl.indexOf('X-Amz-Signature=') > 0, '缺少签名');
  assert(data.key.indexOf('videos/') === 0, 'key 前缀不对');
  assert(data.key.indexOf('..') < 0, 'key 含路径穿越');
  createdId = data.id;
});
await test('未登录不能写入作品', async () => {
  const saved = cookie; cookie = '';
  const res = await post('/api/videos', { title: 'x', videoKey: 'videos/a/b.mp4' });
  cookie = saved;
  assertEq(res.status, 401, 'HTTP');
});
await test('已登录可创建作品', async () => {
  const res = await post('/api/videos', {
    title: '【集成测试】爆裂斩', description: '由 test/integration.mjs 创建', tags: ['集成测试', '斩击'],
    engine: 'UE5', role: '特效设计', videoKey: 'videos/' + createdId + '/a.mp4', duration: 3.2, size: 1234
  });
  assertEq(res.status, 201, 'HTTP');
  const data = await res.json();
  assertEq(data.video.title, '【集成测试】爆裂斩', '标题');
  assert(data.video.id, '没有 id');
  createdId = data.video.id;
});
await test('新作品出现在公开列表里且带播放地址', async () => {
  const data = await (await get('/api/videos')).json();
  assertEq(data.count, baseline + 1, '数量');
  const found = data.videos.filter(function (v) { return v.id === createdId; })[0];
  assert(found, '列表里找不到刚创建的作品');
  assert(found.url.indexOf('/videos/') > 0, '播放地址不对');
});
await test('单个作品接口可读', async () => {
  const res = await get('/api/videos/' + createdId);
  assertEq(res.status, 200, 'HTTP');
  assertEq((await res.json()).video.id, createdId, 'id');
});
await test('删除后回到原始数量', async () => {
  const res = await fetch(base + '/api/videos/' + createdId, { method: 'DELETE', headers: h() });
  assertEq(res.status, 200, 'HTTP');
  const data = await (await get('/api/videos')).json();
  assertEq(data.count, baseline, '数量');
});
await test('下划线开头的 _lib.js 没有被暴露成路由', async () => {
  const res = await get('/api/_lib');
  assert(res.status !== 200, '_lib 竟然可访问（HTTP ' + res.status + '）');
});

console.log('');
console.log('passed ' + passed + ', failed ' + failures.length);
if (failures.length) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
