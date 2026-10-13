#!/usr/bin/env node
// 批量迁移：把源存储里的全部对象搬到另一个 S3 兼容存储（R2 / 腾讯云 COS / 七牛 / B2 / MinIO 均可）
//
//   node scripts/migrate.mjs --list
//   node scripts/migrate.mjs --copy --dry-run
//   node scripts/migrate.mjs --copy
//   node scripts/migrate.mjs --copy --delete-source --yes
//
// 配置来源二选一：--config migrate.config.json，或环境变量 SRC_* / DST_*
//
// 为什么不需要改数据：清单里存的是对象 key，播放地址是读的时候用 PUBLIC_MEDIA_BASE 拼出来的。
// 所以搬完对象、把 PUBLIC_MEDIA_BASE 改成新域名即可，前端与 _manifest.json 都不用动。

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { deriveSigningKey, signWithKey, sha256Hex, uriEncode } from '../functions/api/_lib.js';

const NL = String.fromCharCode(10);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function amzDates(now) {
  const iso = now.toISOString();
  const dateStamp = iso.slice(0, 10).split('-').join('');
  const timeStamp = iso.slice(11, 19).split(':').join('');
  return { dateStamp: dateStamp, amzDate: dateStamp + 'T' + timeStamp + 'Z' };
}

// ---------- 默认传输层（node:https / node:http，支持流式 PUT 并带上 Content-Length）----------
function raw(opts, source) {
  return new Promise(function (resolve, reject) {
    const url = new URL(opts.url);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request({
      method: opts.method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers: opts.headers
    }, resolve);
    req.setTimeout(120000, function () { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    if (source) {
      source.on('error', reject);
      source.pipe(req);
    } else {
      req.end(opts.body);
    }
  });
}

async function collect(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') };
}

export const nodeTransport = {
  send: function (opts) { return raw(opts, null).then(collect); },
  openStream: function (opts) { return raw(opts, null); },
  sendStream: function (opts, source) { return raw(opts, source).then(collect); }
};

// ---------- S3 兼容客户端 ----------
export function createClient(config, transport) {
  const t = transport || nodeTransport;
  const endpoint = String(config.endpoint || '').replace(/[/]+$/, '');
  const host = new URL(endpoint).host;
  const region = config.region || 'auto';
  const bucket = config.bucket;

  async function sign(method, key, query, extraHeaders, payloadHash, now) {
    const stamp = amzDates(now || new Date());
    const canonicalUri = '/' + uriEncode(bucket, true) + (key ? '/' + uriEncode(key, false) : '');
    const params = Object.keys(query || {}).sort().map(function (k) { return [k, String(query[k])]; });
    const canonicalQuery = params.map(function (p) {
      return uriEncode(p[0], true) + '=' + uriEncode(p[1], true);
    }).join('&');
    const headers = Object.assign({ host: host }, extraHeaders || {});
    headers['x-amz-date'] = stamp.amzDate;
    headers['x-amz-content-sha256'] = payloadHash;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalHeaders = 'host:' + host + NL
      + 'x-amz-content-sha256:' + payloadHash + NL
      + 'x-amz-date:' + stamp.amzDate + NL;
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join(NL);
    const scope = stamp.dateStamp + '/' + region + '/s3/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', stamp.amzDate, scope, await sha256Hex(canonicalRequest)].join(NL);
    const signingKey = await deriveSigningKey(config.secretAccessKey, stamp.dateStamp, region, 's3');
    const signature = await signWithKey(signingKey, stringToSign);
    headers.authorization = 'AWS4-HMAC-SHA256 Credential=' + config.accessKeyId + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
    return {
      url: endpoint + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : ''),
      headers: headers,
      canonicalRequest: canonicalRequest,
      stringToSign: stringToSign,
      signature: signature
    };
  }

  async function listPage(prefix, token) {
    const query = { 'list-type': '2', 'max-keys': '1000' };
    if (prefix) query.prefix = prefix;
    if (token) query['continuation-token'] = token;
    const signed = await sign('GET', '', query, {}, EMPTY_SHA256);
    const res = await t.send({ method: 'GET', url: signed.url, headers: signed.headers });
    if (res.status !== 200) throw new Error('列举对象失败 HTTP ' + res.status + '：' + res.text.slice(0, 300));
    return parseList(res.text);
  }

  async function listAll(prefix, onPage) {
    const all = [];
    let token = null;
    let guard = 0;
    do {
      const page = await listPage(prefix, token);
      all.push.apply(all, page.objects);
      if (onPage) onPage(page.objects, all.length);
      token = page.truncated ? page.nextToken : null;
      guard++;
      if (!token) break;
      if (!page.nextToken) throw new Error('响应标记为截断但没有 continuation token');
    } while (guard < 10000);
    all.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });
    return all;
  }

  async function head(key) {
    const signed = await sign('HEAD', key, null, {}, EMPTY_SHA256);
    const res = await t.send({ method: 'HEAD', url: signed.url, headers: signed.headers });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error('HEAD ' + key + ' HTTP ' + res.status);
    return {
      key: key,
      size: Number(res.headers['content-length'] || 0),
      etag: res.headers.etag || null,
      contentType: res.headers['content-type'] || null
    };
  }

  async function openGet(key) {
    const signed = await sign('GET', key, null, {}, EMPTY_SHA256);
    return await t.openStream({ method: 'GET', url: signed.url, headers: signed.headers });
  }

  async function putStream(key, stream, size, contentType) {
    const headers = { 'content-length': String(size) };
    if (contentType) headers['content-type'] = contentType;
    const signed = await sign('PUT', key, null, headers, UNSIGNED_PAYLOAD);
    return await t.sendStream({ method: 'PUT', url: signed.url, headers: signed.headers }, stream);
  }

  async function putBuffer(key, buffer, contentType) {
    const headers = { 'content-length': String(buffer.length) };
    if (contentType) headers['content-type'] = contentType;
    const signed = await sign('PUT', key, null, headers, UNSIGNED_PAYLOAD);
    return await t.send({ method: 'PUT', url: signed.url, headers: signed.headers, body: buffer });
  }

  async function remove(key) {
    const signed = await sign('DELETE', key, null, {}, EMPTY_SHA256);
    return await t.send({ method: 'DELETE', url: signed.url, headers: signed.headers });
  }

  return {
    config: { endpoint: endpoint, host: host, bucket: bucket, region: region },
    sign: sign,
    listPage: listPage,
    listAll: listAll,
    head: head,
    openGet: openGet,
    putStream: putStream,
    putBuffer: putBuffer,
    remove: remove
  };
}

function pick(xml, tag) {
  const m = new RegExp('<' + tag + '>([^]*?)</' + tag + '>').exec(xml);
  return m ? m[1] : null;
}

function decodeEntities(s) {
  return String(s).split('&lt;').join('<').split('&gt;').join('>')
    .split('&quot;').join('"').split('&#39;').join("'").split('&amp;').join('&');
}

export function parseList(xml) {
  const objects = [];
  const re = new RegExp('<Contents>([^]*?)</Contents>', 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const key = pick(m[1], 'Key');
    const size = pick(m[1], 'Size');
    if (key) objects.push({ key: decodeEntities(key), size: Number(size || 0) });
  }
  return {
    objects: objects,
    truncated: xml.indexOf('<IsTruncated>true</IsTruncated>') >= 0,
    nextToken: pick(xml, 'NextContinuationToken') ? decodeEntities(pick(xml, 'NextContinuationToken')) : null
  };
}

// ---------- 参数与配置 ----------
export function parseArgs(argv) {
  const args = { copy: false, list: false, dryRun: false, force: false, yes: false, deleteSource: false, prefix: null, concurrency: 3, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--copy') args.copy = true;
    else if (a === '--list') args.list = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--delete-source') args.deleteSource = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--config') { args.config = argv[++i] || null; }
    else if (a === '--prefix') { args.prefix = argv[++i] || null; }
    else if (a === '--concurrency') { args.concurrency = Math.max(1, Math.min(8, Number(argv[++i]) || 3)); }
    else throw new Error('未知参数：' + a);
  }
  return args;
}

export async function loadConfig(args, env) {
  const e = env || process.env;
  if (args.config) {
    const text = await fs.readFile(args.config, 'utf8');
    return JSON.parse(text);
  }
  const map = function (p) {
    return {
      endpoint: e[p + '_ENDPOINT'],
      bucket: e[p + '_BUCKET'],
      accessKeyId: e[p + '_ACCESS_KEY_ID'],
      secretAccessKey: e[p + '_SECRET_ACCESS_KEY'],
      region: e[p + '_REGION'] || 'auto'
    };
  };
  return { source: map('SRC'), destination: map('DST') };
}

function patchConfig(config) {
  const bad = [];
  ['source', 'destination'].forEach(function (side) {
    const c = config[side] || {};
    ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'].forEach(function (f) {
      if (!c[f]) bad.push(side + '.' + f);
    });
  });
  if (bad.length) throw new Error('配置缺少字段：' + bad.join(', '));
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

async function retry(fn, times, onFail) {
  let last;
  for (let i = 1; i <= times; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      if (onFail) onFail(i, err);
      if (i < times) await new Promise(function (r) { setTimeout(r, 500 * i); });
    }
  }
  throw last;
}

// ---------- 主流程 ----------
export async function run(argv, deps) {
  const d = deps || {};
  const log = d.log || function (line) { console.log(line); };
  const args = parseArgs(argv);

  if (args.help || (!args.list && !args.copy)) {
    log('用法：');
    log('  node scripts/migrate.mjs --list                       只列出源存储的对象');
    log('  node scripts/migrate.mjs --copy --dry-run             预演，不写入');
    log('  node scripts/migrate.mjs --copy                       全量复制并校验');
    log('  node scripts/migrate.mjs --copy --delete-source --yes  复制校验后删除源对象');
    log('');
    log('可选：--config migrate.config.json | --prefix videos/ | --concurrency 3 | --force');
    log('配置也可用环境变量：SRC_ENDPOINT / SRC_BUCKET / SRC_ACCESS_KEY_ID / SRC_SECRET_ACCESS_KEY / SRC_REGION');
    log('                    DST_ENDPOINT / DST_BUCKET / DST_ACCESS_KEY_ID / DST_SECRET_ACCESS_KEY / DST_REGION');
    return { mode: 'usage', failed: 0, copied: 0, skipped: 0, bytes: 0 };
  }

  const config = d.config ? d.config : await loadConfig(args, d.env);
  patchConfig(config);
  const src = createClient(config.source, d.transport);
  const dst = createClient(config.destination, d.transport);

  log('源：      ' + src.config.endpoint + ' / ' + src.config.bucket);
  log('目标：    ' + dst.config.endpoint + ' / ' + dst.config.bucket);
  log('');

  const objects = await src.listAll(args.prefix, function (page, total) {
    if (page.length) log('  列举中… 已发现 ' + total + ' 个对象');
  });
  const totalBytes = objects.reduce(function (a, o) { return a + o.size; }, 0);
  log('共 ' + objects.length + ' 个对象，合计 ' + fmtBytes(totalBytes));
  log('');

  if (args.list) {
    objects.forEach(function (o) { log('  ' + o.key + '  ' + fmtBytes(o.size)); });
    return { mode: 'list', objects: objects, bytes: totalBytes, failed: 0, copied: 0, skipped: 0 };
  }

  const summary = { mode: args.dryRun ? 'dry-run' : 'copy', copied: 0, skipped: 0, failed: 0, bytes: 0, failures: [], deleted: 0 };

  async function copyOne(object, index) {
    const tag = '[' + index + '/' + objects.length + '] ' + object.key;
    try {
      if (!args.force) {
        const existing = await dst.head(object.key);
        if (existing && existing.size === object.size && object.size > 0) {
          summary.skipped++;
          log(tag + '  已存在且大小一致，跳过');
          return;
        }
      }
      if (args.dryRun) {
        summary.copied++;
        summary.bytes += object.size;
        log(tag + '  [预演] 将复制 ' + fmtBytes(object.size));
        return;
      }
      const started = Date.now();
      await retry(async function () {
        const res = await src.openGet(object.key);
        if (res.statusCode !== 200) {
          res.resume();
          throw new Error('GET 源对象 HTTP ' + res.statusCode);
        }
        const put = await dst.putStream(object.key, res, object.size, res.headers['content-type']);
        if (put.status < 200 || put.status >= 300) throw new Error('PUT 目标 HTTP ' + put.status + '：' + put.text.slice(0, 160));
      }, 3, function (attempt, err) { log(tag + '  第 ' + attempt + ' 次失败：' + err.message); });

      const check = await dst.head(object.key);
      if (!check || check.size !== object.size) {
        throw new Error('校验失败：目标大小 ' + (check ? check.size : '缺失') + ' ≠ 源 ' + object.size);
      }
      summary.copied++;
      summary.bytes += object.size;
      log(tag + '  ' + fmtBytes(object.size) + '  ok  ' + ((Date.now() - started) / 1000).toFixed(1) + 's');

      if (args.deleteSource && args.yes) {
        const del = await src.remove(object.key);
        if (del.status >= 200 && del.status < 300) { summary.deleted++; }
        else { log(tag + '  删除源对象失败 HTTP ' + del.status); }
      }
    } catch (err) {
      summary.failed++;
      summary.failures.push(object.key + ' :: ' + err.message);
      log(tag + '  失败：' + err.message);
    }
  }

  let cursor = 0;
  const workers = [];
  const lanes = Math.max(1, args.concurrency);
  for (let lane = 0; lane < lanes; lane++) {
    workers.push((async function () {
      while (true) {
        const my = cursor++;
        if (my >= objects.length) return;
        await copyOne(objects[my], my + 1);
      }
    })());
  }
  await Promise.all(workers);

  log('');
  log('完成：复制 ' + summary.copied + '，跳过 ' + summary.skipped + '，失败 ' + summary.failed
    + (args.deleteSource && args.yes ? ('，已删除源 ' + summary.deleted) : ''));
  log('传输量：' + fmtBytes(summary.bytes));
  if (!args.dryRun && summary.copied > 0 && !summary.failed) {
    log('');
    log('下一步：把公开访问域名指向新存储，并更新 Pages 的 PUBLIC_MEDIA_BASE（清单里存的是 key，不用改）。');
  }
  if (summary.failures.length) {
    log('');
    log('失败清单：');
    summary.failures.forEach(function (f) { log('  - ' + f); });
  }
  return summary;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run(process.argv.slice(2), {}).then(function (summary) {
    process.exit(summary.failed ? 1 : 0);
  }).catch(function (err) {
    console.error('迁移中止：' + err.message);
    process.exit(2);
  });
}
