import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const pub = path.resolve('public');
const config = JSON.parse(fs.readFileSync(path.join(pub, 'config.json'), 'utf8'));

const FIXTURE = {
  updated: '2026-08-14T00:00:00.000Z',
  count: 2,
  tags: ['二次元', '斩击', '色阶'],
  videos: [
    { id: 'aaa111', title: '爆裂斩 · 三版本迭代', description: '三帧剪影 + hitstop', tags: ['斩击', '色阶'], engine: 'UE5', role: '特效设计', duration: 12.5, size: 41300000, url: 'https://pub-test.r2.dev/videos/aaa111/a.mp4', poster: 'https://pub-test.r2.dev/videos/aaa111/poster.jpg', order: 2 },
    { id: 'bbb222', title: '治疗光环', description: '', tags: ['二次元'], engine: 'Unity', role: '', duration: 6, size: 12000000, url: 'https://pub-test.r2.dev/videos/bbb222/b.mp4', poster: null, order: 1 }
  ]
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + ' :: ' + err.message); }
}
const tick = () => new Promise(function (r) { setTimeout(r, 60); });

function boot(page, fetchImpl) {
  const html = fs.readFileSync(path.join(pub, page), 'utf8');
  const dom = new JSDOM(html, { url: 'https://portfolio.example/', pretendToBeVisual: true });
  const w = dom.window;
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  w.HTMLMediaElement.prototype.pause = function () {};
  w.HTMLMediaElement.prototype.load = function () {};
  w.fetch = fetchImpl;
  global.window = w;
  global.document = w.document;
  global.location = w.location;
  global.history = w.history;
  global.fetch = fetchImpl;
  global.KeyboardEvent = w.KeyboardEvent;
  global.Event = w.Event;
  return w;
}

// ---------------- 前台 ----------------
const w1 = boot('index.html', async function (url) {
  const u = String(url);
  if (u.indexOf('/config.json') >= 0) return { ok: true, status: 200, json: async () => config };
  if (u.indexOf('/api/videos') >= 0) return { ok: true, status: 200, json: async () => FIXTURE };
  return { ok: false, status: 404, json: async () => ({}) };
});
await import(pathToFileURL(path.join(pub, 'assets/app.js')).href + '?v=1');
await tick();
const d1 = w1.document;

await test('config 填充了标题与页脚', async () => {
  assert.equal(d1.getElementById('site-title').textContent, config.title);
  assert.equal(d1.getElementById('site-sub').textContent, config.subtitle);
  assert.equal(d1.getElementById('foot').textContent, '\u00A9 ' + config.owner);
  assert.equal(d1.getElementById('site-links').children.length, config.links.length);
});
await test('渲染出标签筛选（全部 + 3 个标签）', async () => {
  const chips = d1.getElementById('tag-filter').children;
  assert.equal(chips.length, 4);
  assert.equal(chips[0].textContent, '全部');
  assert.equal(d1.getElementById('tag-filter').querySelector('.chip.on').textContent, '全部');
});
await test('渲染出 2 张作品卡片并显示时长角标', async () => {
  const cards = d1.getElementById('grid').children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.card-title').textContent, '爆裂斩 · 三版本迭代');
  assert.equal(cards[0].querySelector('.badge').textContent, '0:13');
  assert.equal(cards[1].querySelector('.badge').textContent, '0:06');
});
await test('有封面用 img，没封面用兜底文字', async () => {
  const cards = d1.getElementById('grid').children;
  assert.equal(cards[0].querySelector('img').getAttribute('src'), FIXTURE.videos[0].poster);
  assert.equal(cards[1].querySelector('img'), null);
  assert.equal(cards[1].querySelector('.fallback').textContent, '治疗光环');
});
await test('点击卡片打开弹层并指向正确的视频', async () => {
  d1.getElementById('grid').children[0].dispatchEvent(new w1.Event('click', { bubbles: true }));
  const lb = d1.getElementById('lightbox');
  assert.equal(lb.hidden, false);
  assert.equal(d1.getElementById('lb-video').getAttribute('src'), FIXTURE.videos[0].url);
  assert.equal(d1.getElementById('lb-title').textContent, '爆裂斩 · 三版本迭代');
  assert.ok(d1.getElementById('lb-meta').textContent.indexOf('引擎：UE5') === 0);
  assert.equal(d1.getElementById('lb-prev').disabled, true);
  assert.equal(d1.getElementById('lb-next').disabled, false);
});
await test('打开后写入分享锚点 #v=', async () => {
  assert.equal(w1.location.hash, '#v=aaa111');
});
await test('键盘右方向键切到下一个作品', async () => {
  d1.dispatchEvent(new w1.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(d1.getElementById('lb-title').textContent, '治疗光环');
  assert.equal(w1.location.hash, '#v=bbb222');
  assert.equal(d1.getElementById('lb-next').disabled, true);
});
await test('Escape 关闭并暂停/清空视频源', async () => {
  d1.dispatchEvent(new w1.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d1.getElementById('lightbox').hidden, true);
  assert.equal(d1.getElementById('lb-video').hasAttribute('src'), false);
  assert.equal(w1.location.hash, '');
});
await test('点标签筛选后只剩匹配作品', async () => {
  const chips = d1.getElementById('tag-filter').children;
  const target = Array.prototype.filter.call(chips, function (c) { return c.textContent === '斩击'; })[0];
  target.dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.equal(d1.getElementById('grid').children.length, 1);
  assert.equal(d1.getElementById('count').textContent, '共 1 个作品');
});
await test('筛选到空结果时显示空状态', async () => {
  const chips = d1.getElementById('tag-filter').children;
  const target = Array.prototype.filter.call(chips, function (c) { return c.textContent === '色阶'; })[0];
  target.dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.equal(d1.getElementById('grid').children.length, 1);
});

await test('邮箱不再是 mailto 链接，而是按钮', async () => {
  const links = d1.getElementById('site-links');
  assert.equal(links.querySelectorAll('a[href^="mailto"]').length, 0, '还有 mailto 链接');
  const btn = links.querySelector('button.linkbtn');
  assert.ok(btn, '没找到邮箱按钮');
  assert.equal(btn.textContent, '邮箱');
  assert.equal(links.children.length, 2, '链接数量变了');
});
await test('点邮箱弹出弹层并显示地址', async () => {
  d1.getElementById('site-links').querySelector('button.linkbtn').dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.equal(d1.getElementById('email-modal').hidden, false, '弹层没打开');
  assert.equal(d1.getElementById('email-value').textContent, '570325189@qq.com');
});
await test('Esc 关闭邮箱弹层', async () => {
  d1.dispatchEvent(new w1.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(d1.getElementById('email-modal').hidden, true, 'Esc 关不掉');
});
await test('点遮罩也能关掉邮箱弹层', async () => {
  d1.getElementById('site-links').querySelector('button.linkbtn').dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.equal(d1.getElementById('email-modal').hidden, false);
  d1.querySelector('#email-modal .modal-backdrop').dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.equal(d1.getElementById('email-modal').hidden, true, '遮罩关不掉');
});
await test('复制按钮在没有剪贴板 API 时回退选中文本且不报错', async () => {
  d1.getElementById('site-links').querySelector('button.linkbtn').dispatchEvent(new w1.Event('click', { bubbles: true }));
  d1.getElementById('email-copy').dispatchEvent(new w1.Event('click', { bubbles: true }));
  assert.ok(d1.getElementById('email-msg').textContent.length > 0, '没有任何提示');
  d1.dispatchEvent(new w1.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

// ---------------- 分页 ----------------
const MANY = {
  updated: '2026-08-14T00:00:00.000Z',
  count: 14,
  tags: ['二次元', '斩击'],
  videos: Array.from({ length: 14 }, function (_, i) {
    const n = i + 1;
    return {
      id: 'w' + (n < 10 ? '0' + n : n),
      title: '作品 ' + n,
      description: '',
      tags: [n % 2 === 0 ? '二次元' : '斩击'],
      engine: 'UE5', role: '特效设计',
      duration: 6, size: 1000000,
      url: '/media/videos/w' + n + '/clip.mp4',
      poster: null, order: 14 - n
    };
  })
};
const w3 = boot('index.html', async function (url) {
  const u = String(url);
  if (u.indexOf('/config.json') >= 0) return { ok: true, status: 200, json: async () => config };
  if (u.indexOf('/api/videos') >= 0) return { ok: true, status: 200, json: async () => MANY };
  return { ok: false, status: 404, json: async () => ({}) };
});
await import(pathToFileURL(path.join(pub, 'assets/app.js')).href + '?v=3');
await tick();
const d3 = w3.document;

await test('作品不足一页时不显示分页控件', async () => {
  assert.equal(d1.getElementById('pager').hidden, true, '2 个作品不该出现分页');
});
await test('14 个作品时每页只渲染 12 个，总数仍显示 14', async () => {
  assert.equal(d3.getElementById('grid').children.length, 12);
  assert.equal(d3.getElementById('count').textContent, '共 14 个作品');
});
await test('分页控件出现，共 2 页，当前页高亮', async () => {
  assert.equal(d3.getElementById('pager').hidden, false);
  const nums = d3.getElementById('pg-nums').children;
  assert.equal(nums.length, 2);
  assert.equal(nums[0].textContent, '1');
  assert.equal(nums[0].className.indexOf('on') >= 0, true);
});
await test('第 1 页时「上一页」禁用、「下一页」可用', async () => {
  assert.equal(d3.getElementById('pg-prev').disabled, true);
  assert.equal(d3.getElementById('pg-next').disabled, false);
});
await test('点「下一页」后只剩 2 个作品，且是第 13、14 个', async () => {
  d3.getElementById('pg-next').dispatchEvent(new w3.Event('click', { bubbles: true }));
  const cards = d3.getElementById('grid').children;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('.card-title').textContent, '作品 13');
  assert.equal(cards[1].querySelector('.card-title').textContent, '作品 14');
  assert.equal(w3.location.hash, '#page=2');
  assert.equal(d3.getElementById('pg-next').disabled, true);
});
await test('输入页码回车可跳回第 1 页', async () => {
  const input = d3.getElementById('pg-input');
  input.value = '1';
  input.dispatchEvent(new w3.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(d3.getElementById('grid').children.length, 12);
  assert.equal(w3.location.hash, '#page=1');
});
await test('页码越界会被夹到有效范围，不会白屏', async () => {
  const input = d3.getElementById('pg-input');
  input.value = '99';
  input.dispatchEvent(new w3.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(d3.getElementById('grid').children.length, 2);
  assert.equal(w3.location.hash, '#page=2');
});
await test('点页码按钮可直接跳到该页', async () => {
  const nums = d3.getElementById('pg-nums').children;
  nums[0].dispatchEvent(new w3.Event('click', { bubbles: true }));
  assert.equal(d3.getElementById('grid').children.length, 12);
  assert.equal(w3.location.hash, '#page=1');
});
await test('切标签后回到第 1 页；结果只剩 1 页时隐藏分页', async () => {
  const chips = d3.getElementById('tag-filter').children;
  const target = Array.prototype.filter.call(chips, function (c) { return c.textContent === '斩击'; })[0];
  target.dispatchEvent(new w3.Event('click', { bubbles: true }));
  assert.equal(d3.getElementById('count').textContent, '共 7 个作品');
  assert.equal(d3.getElementById('grid').children.length, 7);
  assert.equal(d3.getElementById('pager').hidden, true, '只有 1 页时不该显示分页');
});
await test('弹层里的前后切换只在当前页内，不跨页', async () => {
  const chips = d3.getElementById('tag-filter').children;
  const allChip = Array.prototype.filter.call(chips, function (c) { return c.textContent === '全部'; })[0];
  allChip.dispatchEvent(new w3.Event('click', { bubbles: true }));
  d3.getElementById('pg-next').dispatchEvent(new w3.Event('click', { bubbles: true }));
  const cards = d3.getElementById('grid').children;
  assert.equal(cards.length, 2);
  cards[0].dispatchEvent(new w3.Event('click', { bubbles: true }));
  assert.equal(d3.getElementById('lb-title').textContent, '作品 13');
  assert.equal(d3.getElementById('lb-prev').disabled, true, '本页第一个不该能往前切');
  d3.dispatchEvent(new w3.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(d3.getElementById('lb-title').textContent, '作品 14');
  assert.equal(d3.getElementById('lb-next').disabled, true, '本页最后一个不该能往后切');
  d3.dispatchEvent(new w3.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
await test('关闭弹层后地址栏恢复成当前页码', async () => {
  assert.equal(w3.location.hash, '#page=2');
});

// ---------------- 后台 ----------------
const calls = [];
let authed = false;
const w2 = boot('admin.html', async function (url, opts) {
  const u = String(url);
  calls.push((opts && opts.method ? opts.method : 'GET') + ' ' + u);
  if (u.indexOf('/api/session') >= 0) return { ok: true, status: 200, json: async () => ({ authed: authed }) };
  if (u.indexOf('/api/login') >= 0) { authed = true; return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
  if (u.indexOf('/api/videos') >= 0) return { ok: true, status: 200, json: async () => FIXTURE };
  return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
});
await import(pathToFileURL(path.join(pub, 'assets/admin.js')).href + '?v=1');
await tick();
const d2 = w2.document;

await test('未登录时只显示登录框，管理区隐藏', async () => {
  assert.equal(d2.getElementById('login-view').hidden, false);
  assert.equal(d2.getElementById('admin-view').hidden, true);
  assert.equal(d2.getElementById('logout').hidden, true);
});
await test('输入密码提交后进入管理区（Cookie 会话，前端不存密码）', async () => {
  d2.getElementById('password').value = 'correct horse battery staple';
  d2.getElementById('login-form').dispatchEvent(new w2.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(d2.getElementById('admin-view').hidden, false);
  assert.equal(d2.getElementById('logout').hidden, false);
  assert.ok(calls.indexOf('POST /api/login') >= 0);
  assert.equal(d2.getElementById('password').value, '');
});
await test('管理区列出全部作品并带编辑/删除按钮', async () => {
  const items = d2.getElementById('list').children;
  assert.equal(items.length, 2);
  assert.equal(d2.getElementById('list-count').textContent, '(2)');
  assert.equal(items[0].querySelectorAll('button').length, 2);
  assert.equal(items[0].querySelector('h3').textContent, '爆裂斩 · 三版本迭代');
  assert.ok(items[0].querySelector('.m').textContent.indexOf('UE5') >= 0);
});
await test('点编辑文案会回填表单并切换按钮', async () => {
  const items = d2.getElementById('list').children;
  items[0].querySelectorAll('button')[0].dispatchEvent(new w2.Event('click', { bubbles: true }));
  assert.equal(d2.getElementById('title').value, '爆裂斩 · 三版本迭代');
  assert.equal(d2.getElementById('tags').value, '斩击, 色阶');
  assert.equal(d2.getElementById('engine').value, 'UE5');
  assert.equal(d2.getElementById('submit').textContent, '保存修改');
  assert.equal(d2.getElementById('cancel-edit').hidden, false);
});
await test('取消编辑后表单复位', async () => {
  d2.getElementById('cancel-edit').dispatchEvent(new w2.Event('click', { bubbles: true }));
  assert.equal(d2.getElementById('title').value, '');
  assert.equal(d2.getElementById('submit').textContent, '上传并发布');
});
await test('编辑模式缺标题时不会发起请求', async () => {
  const before = calls.length;
  d2.getElementById('submit').dispatchEvent(new w2.Event('click', { bubbles: true }));
  await tick();
  assert.equal(calls.length, before);
  assert.ok(d2.getElementById('form-msg').textContent.indexOf('标题') >= 0);
});

console.log('');
console.log('passed ' + passed + ', failed ' + failures.length);
if (failures.length) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
