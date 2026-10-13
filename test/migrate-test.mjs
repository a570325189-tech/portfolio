import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createClient, parseList, parseArgs, run } from '../scripts/migrate.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + ' :: ' + err.message); }
}
function nodeHmac(key, msg) { return crypto.createHmac('sha256', key).update(msg).digest(); }

const SEED = {
  '_manifest.json': { body: '{"version":1,"videos":[]}', type: 'application/json' },
  'videos/aaa/clip 斩击.mp4': { body: 'A'.repeat(50), type: 'video/mp4' },
  'videos/aaa/poster.jpg': { body: 'P'.repeat(20), type: 'image/jpeg' },
  'videos/bbb/clip.mp4': { body: 'B'.repeat(30), type: 'video/mp4' }
};

function makeStorage(seed, pageSize) {
  const objects = new Map();
  for (const k of Object.keys(seed || {})) objects.set(k, { body: Buffer.from(seed[k].body), type: seed[k].type });
  const calls = [];
  const fail = new Set();
  const ps = pageSize || 2;

  function split(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    return { bucket: parts[0], key: parts.slice(1).join('/'), query: u.searchParams };
  }

  const transport = {
    async send(opts) {
      const p = split(opts.url);
      calls.push({ method: opts.method, key: p.key, query: Object.fromEntries(p.query), headers: opts.headers });
      if (p.query.get('list-type') === '2') {
        const prefix = p.query.get('prefix') || '';
        const token = Number(p.query.get('continuation-token') || 0);
        const all = Array.from(objects.keys()).sort().filter(function (k) { return k.indexOf(prefix) === 0; });
        const slice = all.slice(token, token + ps);
        const truncated = token + ps < all.length;
        let xml = '<ListBucketResult><IsTruncated>' + (truncated ? 'true' : 'false') + '</IsTruncated>';
        if (truncated) xml += '<NextContinuationToken>' + (token + ps) + '</NextContinuationToken>';
        slice.forEach(function (k) {
          xml += '<Contents><Key>' + k.split('&').join('&amp;') + '</Key><Size>' + objects.get(k).body.length + '</Size></Contents>';
        });
        return { status: 200, headers: {}, text: xml + '</ListBucketResult>' };
      }
      if (opts.method === 'HEAD') {
        if (!objects.has(p.key)) return { status: 404, headers: {}, text: '' };
        return { status: 200, headers: { 'content-length': String(objects.get(p.key).body.length), 'content-type': objects.get(p.key).type }, text: '' };
      }
      if (opts.method === 'DELETE') { objects.delete(p.key); return { status: 204, headers: {}, text: '' }; }
      if (opts.method === 'PUT') {
        if (fail.has(p.key)) return { status: 500, headers: {}, text: 'boom' };
        const body = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
        if (Number(opts.headers['content-length']) !== body.length) return { status: 400, headers: {}, text: 'length mismatch' };
        objects.set(p.key, { body: body, type: opts.headers['content-type'] || 'application/octet-stream' });
        return { status: 200, headers: {}, text: '' };
      }
      return { status: 400, headers: {}, text: 'unsupported' };
    },
    async openStream(opts) {
      const p = split(opts.url);
      calls.push({ method: 'GET', key: p.key });
      if (!objects.has(p.key)) { const r = Readable.from([]); r.statusCode = 404; r.headers = {}; return r; }
      const r = Readable.from([objects.get(p.key).body]);
      r.statusCode = 200;
      r.headers = { 'content-type': objects.get(p.key).type };
      return r;
    },
    async sendStream(opts, source) {
      const p = split(opts.url);
      const chunks = [];
      for await (const c of source) chunks.push(c);
      const body = Buffer.concat(chunks);
      calls.push({ method: 'PUT', key: p.key, headers: opts.headers });
      if (fail.has(p.key)) return { status: 500, headers: {}, text: 'boom' };
      if (Number(opts.headers['content-length']) !== body.length) return { status: 400, headers: {}, text: 'length mismatch' };
      objects.set(p.key, { body: body, type: opts.headers['content-type'] || 'application/octet-stream' });
      return { status: 200, headers: {}, text: '' };
    }
  };
  return { objects: objects, calls: calls, fail: fail, transport: transport };
}

// 把同一个 transport 按目标地址分流到源/目标两个假存储
function route(st, dst) {
  return {
    send: async function (o) { return o.url.indexOf('acct.r2') > 0 ? st.transport.send(o) : dst.transport.send(o); },
    openStream: function (o) { return st.transport.openStream(o); },
    sendStream: function (o, s) { return dst.transport.sendStream(o, s); }
  };
}

const SRC = { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'vfx-portfolio', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'auto' };
const DST = { endpoint: 'https://cos.example.com', bucket: 'target-1250000000', accessKeyId: 'AKIDDST', secretAccessKey: 'dstsecret', region: 'ap-guangzhou' };

// ---- 签名 ----
await test('迁移用的 header 签名与 node:crypto 独立复算一致', async () => {
  const c = createClient(SRC, makeStorage(SEED).transport);
  const signed = await c.sign('PUT', 'videos/aaa/clip 斩击.mp4', null, { 'content-length': '50' }, 'UNSIGNED-PAYLOAD', new Date('2026-08-14T12:00:00.000Z'));
  const kSigning = nodeHmac(nodeHmac(nodeHmac(nodeHmac(Buffer.from('AWS4' + SRC.secretAccessKey), '20260814'), 'auto'), 's3'), 'aws4_request');
  const expected = nodeHmac(kSigning, signed.stringToSign).toString('hex');
  assert.equal(signed.signature, expected);
  assert.ok(signed.headers.authorization.indexOf('SignedHeaders=host;x-amz-content-sha256;x-amz-date') > 0);
  assert.ok(signed.headers.authorization.indexOf('Credential=AKIDEXAMPLE/20260814/auto/s3/aws4_request') > 0);
  assert.equal(signed.url.indexOf('https://acct.r2.cloudflarestorage.com/vfx-portfolio/videos/aaa/clip%20'), 0);
});

// ---- 列举解析 ----
await test('parseList 解析 key/大小/续传标记，并反转义实体', async () => {
  const xml = '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>2</NextContinuationToken>'
    + '<Contents><Key>a&amp;b.mp4</Key><Size>12</Size></Contents>'
    + '<Contents><Key>c.mp4</Key><Size>7</Size></Contents></ListBucketResult>';
  const page = parseList(xml);
  assert.equal(page.objects.length, 2);
  assert.equal(page.objects[0].key, 'a&b.mp4');
  assert.equal(page.objects[1].size, 7);
  assert.equal(page.truncated, true);
  assert.equal(page.nextToken, '2');
});
await test('listAll 会翻页取全（每页 2 个，共 4 个）', async () => {
  const st = makeStorage(SEED, 2);
  const c = createClient(SRC, st.transport);
  const all = await c.listAll();
  assert.equal(all.length, 4);
  assert.deepEqual(all.map(function (o) { return o.key; }).sort(), Object.keys(SEED).sort());
});

// ---- 预演 ----
await test('--copy --dry-run 预演：报告要复制什么，但一个字节都不写', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  const lines = [];
  const summary = await run(['--copy', '--dry-run'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function (l) { lines.push(l); } });
  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.copied, 4);
  assert.equal(dst.objects.size, 0);
  assert.equal(st.objects.size, 4);
  assert.equal(dst.calls.filter(function (c) { return c.method === 'PUT'; }).length, 0);
  assert.ok(lines.join(' ').indexOf('[预演]') > 0);
});

// ---- 真实复制 ----
await test('--copy 全量复制且字节完全一致', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  const summary = await run(['--copy'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.copied, 4);
  assert.equal(summary.failed, 0);
  assert.equal(dst.objects.size, 4);
  for (const k of Object.keys(SEED)) {
    assert.equal(dst.objects.get(k).body.toString(), SEED[k].body, k);
    assert.equal(dst.objects.get(k).type, SEED[k].type, k);
  }
});
await test('重复执行会跳过已存在且大小一致的对象（幂等）', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage(SEED);
  const calls = [];
  const transport = { send: async function (o) { calls.push(o.method + ' ' + o.url); return o.url.indexOf('acct.r2') > 0 ? st.transport.send(o) : dst.transport.send(o); }, openStream: function (o) { return st.transport.openStream(o); }, sendStream: function (o, s) { return dst.transport.sendStream(o, s); } };
  const summary = await run(['--copy'], { transport: transport, config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.skipped, 4);
  assert.equal(summary.copied, 0);
  assert.equal(calls.filter(function (c) { return c.indexOf('PUT') === 0; }).length, 0);
});
await test('--force 会重传已存在的对象', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage(SEED);
  const summary = await run(['--copy', '--force'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.copied, 4);
  assert.equal(summary.skipped, 0);
});
await test('--prefix 只迁移匹配前缀的对象', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  const summary = await run(['--copy', '--prefix', 'videos/bbb/'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.copied, 1);
  assert.equal(dst.objects.size, 1);
  assert.ok(dst.objects.has('videos/bbb/clip.mp4'));
});

// ---- 失败与删除 ----
await test('单个对象失败不影响其它对象，并汇总失败清单', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  dst.fail.add('videos/bbb/clip.mp4');
  const summary = await run(['--copy', '--concurrency', '1'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.copied, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures.length, 1);
  assert.ok(summary.failures[0].indexOf('videos/bbb/clip.mp4') === 0);
});
await test('--delete-source 不带 --yes 时源对象保持不动', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  await run(['--copy', '--delete-source'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(st.objects.size, 4);
});
await test('--delete-source --yes 在复制校验后清空源', async () => {
  const st = makeStorage(SEED);
  const dst = makeStorage({});
  const summary = await run(['--copy', '--delete-source', '--yes'], { transport: route(st, dst), config: { source: SRC, destination: DST }, log: function () {} });
  assert.equal(summary.deleted, 4);
  assert.equal(st.objects.size, 0);
  assert.equal(dst.objects.size, 4);
});

// ---- 参数与配置 ----
await test('parseArgs 解析与越界保护', async () => {
  const a = parseArgs(['--copy', '--prefix', 'videos/', '--concurrency', '99', '--delete-source', '--yes']);
  assert.equal(a.copy, true);
  assert.equal(a.prefix, 'videos/');
  assert.equal(a.concurrency, 8);
  assert.equal(a.deleteSource, true);
  assert.equal(a.yes, true);
  assert.throws(function () { parseArgs(['--nope']); });
});
await test('缺少配置字段时明确报错', async () => {
  await assert.rejects(async function () {
    await run(['--copy'], { config: { source: { endpoint: 'https://x' }, destination: DST }, log: function () {} });
  }, function (err) { return err.message.indexOf('配置缺少字段') >= 0; });
});
await test('无参数时打印用法而不是乱跑', async () => {
  const lines = [];
  const summary = await run([], { log: function (l) { lines.push(l); } });
  assert.equal(summary.mode, 'usage');
  assert.ok(lines.join(' ').indexOf('--copy') > 0);
});

console.log('');
console.log('passed ' + passed + ', failed ' + failures.length);
if (failures.length) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
