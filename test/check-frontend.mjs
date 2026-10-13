import fs from 'node:fs';
import path from 'node:path';

const pub = path.resolve('public');
const problems = [];
let checks = 0;

function idsIn(html) {
  const out = new Set();
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.add(m[1]);
  return out;
}
function idsUsed(js) {
  const out = new Set();
  const re = /getElementById\('([^']+)'\)|el\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(js)) !== null) out.add(m[1] || m[2]);
  return out;
}
function assetsIn(html) {
  const out = [];
  const re = /(?:src|href)="(\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

for (const page of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(pub, page), 'utf8');
  const jsFile = page === 'index.html' ? 'assets/app.js' : 'assets/admin.js';
  const js = fs.readFileSync(path.join(pub, jsFile), 'utf8');
  const have = idsIn(html);
  const want = idsUsed(js);
  for (const id of want) {
    checks++;
    if (!have.has(id)) problems.push(page + ': JS 引用了不存在的 id "' + id + '"');
  }
  for (const href of assetsIn(html)) {
    checks++;
    const rel = href.replace(/^\//, '');
    if (!fs.existsSync(path.join(pub, rel))) problems.push(page + ': 资源不存在 ' + href);
  }
  console.log(page + ': ' + have.size + ' ids, ' + want.size + ' referenced');
}

const allIds = new Set();
for (const f of ['index.html', 'admin.html']) {
  const html = fs.readFileSync(path.join(pub, f), 'utf8');
  for (const id of idsIn(html)) {
    checks++;
    if (allIds.has(id)) problems.push('duplicate id across pages: ' + id);
    allIds.add(id);
  }
}

const cfg = JSON.parse(fs.readFileSync(path.join(pub, 'config.json'), 'utf8'));
checks++;
if (!cfg.title) problems.push('config.json 缺少 title');

console.log('checks: ' + checks);
if (problems.length) {
  console.log('PROBLEMS:');
  problems.forEach(function (p) { console.log('  - ' + p); });
  process.exit(1);
}
console.log('frontend static check: OK');
