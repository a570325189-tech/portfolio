// 专治一类 jsdom 抓不到、上线才发现的 bug：
//   代码里 element.hidden = true，属性确实变了，但 CSS 的 display 规则把浏览器的
//   默认 [hidden]{display:none} 盖住了，真实浏览器里元素依然可见 —— 表现就是"关闭按钮没反应"。
//
// 为什么不用 jsdom 测：实测 jsdom 的层叠实现会错误地让 hidden 生效，因此在它上面
// 断言 getComputedStyle().display === 'none' 永远通过，抓不到真 bug。
// 所以这里改为对 CSS 与 HTML/JS 做静态分析，规则是：
//   只要有元素的显示状态靠 hidden 属性切换，而它所属的 class 又声明了 display，
//   样式表里就必须存在带 !important 的 [hidden] 兜底规则。
import fs from 'node:fs';
import path from 'node:path';

const pub = path.resolve('public');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (err) { failures.push(name + ' :: ' + err.message); console.log('  FAIL  ' + name + ' :: ' + err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function stripComments(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 2;
    } else { out += css[i]; i++; }
  }
  return out;
}

function collectRules(css, out) {
  const rules = out || [];
  let i = 0;
  let buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      const body = css.slice(i + 1, j - 1);
      const selector = buf.trim();
      if (selector.charAt(0) === '@') {
        if (selector.indexOf('@media') === 0) collectRules(body, rules);
      } else if (selector) {
        rules.push({ selector: selector, body: body });
      }
      buf = '';
      i = j;
    } else if (ch === '}') { buf = ''; i++; }
    else { buf += ch; i++; }
  }
  return rules;
}

// 从 HTML 找出：初始带 hidden 属性的元素，以及它们的 class
function hiddenByAttribute(html) {
  const found = [];
  const tagRe = /<([a-zA-Z][^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tokens = m[1].split(' ').filter(function (t) { return t.length > 0; });
    if (tokens.indexOf('hidden') < 0) continue;
    const idTok = tokens.filter(function (t) { return t.indexOf('id=') === 0; })[0];
    const clsTok = tokens.filter(function (t) { return t.indexOf('class=') === 0; })[0];
    if (!idTok) continue;
    found.push({
      id: idTok.slice(4, -1),
      classes: clsTok ? clsTok.slice(7, -1).split(' ').filter(Boolean) : []
    });
  }
  return found;
}

// 从 JS 找出被 .hidden = 切换的 id
function toggledByScript(js) {
  const ids = [];
  const re = /(?:el|document\.getElementById)\(\s*'([^']+)'\s*\)\.hidden\s*=/g;
  let m;
  while ((m = re.exec(js)) !== null) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
  return ids;
}

function classesOfId(html, id) {
  const re = new RegExp('id="' + id + '"[^>]*');
  const m = re.exec(html);
  if (!m) return null;
  const cls = /class="([^"]*)"/.exec(m[0]);
  return cls ? cls[1].split(' ').filter(Boolean) : [];
}

function hasHiddenGuard(rules) {
  return rules.some(function (r) {
    return r.selector.indexOf('[hidden]') >= 0 && /display\s*:\s*none/.test(r.body) && r.body.indexOf('!important') >= 0;
  });
}

// 返回问题列表；没有兜底规则时，列出"靠 hidden 切换、却带着 display 声明的 class"
function analyze(cssText, htmlText, jsText) {
  const css = stripComments(cssText);
  const rules = collectRules(css);
  const candidates = [];
  hiddenByAttribute(htmlText).forEach(function (e) {
    candidates.push({ id: e.id, classes: e.classes });
  });
  toggledByScript(jsText).forEach(function (id) {
    const cls = classesOfId(htmlText, id);
    candidates.push({ id: id, classes: cls || [] });
  });

  const risky = [];
  candidates.forEach(function (c) {
    c.classes.forEach(function (cls) {
      rules.forEach(function (r) {
        if (r.selector.indexOf('.' + cls) < 0) return;
        const m = /display\s*:\s*([^;]+)/.exec(r.body);
        if (!m) return;
        const value = m[1].trim();
        if (value === 'none' || value === 'none !important') return;
        risky.push({ id: c.id, cls: cls, selector: r.selector, display: value });
      });
    });
  });

  const problems = [];
  if (risky.length && !hasHiddenGuard(rules)) {
    const seen = {};
    risky.forEach(function (r) {
      const k = r.id + '|' + r.cls;
      if (seen[k]) return;
      seen[k] = true;
      problems.push('#' + r.id + ' 用 hidden 切换显示，但 .' + r.cls + ' （规则 "' + r.selector + '"）声明了 display:' + r.display + '，样式表里缺少 [hidden] { display:none !important } 兜底');
    });
  }
  return { problems: problems, risky: risky, hasGuard: hasHiddenGuard(rules), candidates: candidates };
}

const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const adminHtml = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
const appJs = fs.readFileSync(path.join(pub, 'assets/app.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(pub, 'assets/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(pub, 'assets/style.css'), 'utf8');

test('样式表存在 [hidden] 兜底规则', function () {
  const rules = collectRules(stripComments(css));
  assert(hasHiddenGuard(rules), '缺少 [hidden] { display: none !important }');
});

test('分析器确实识别出受影响的元素（说明它没在空跑）', function () {
  const r = analyze(css, html + adminHtml, appJs + adminJs);
  assert(r.candidates.length >= 3, '只认出了 ' + r.candidates.length + ' 个候选元素');
  assert(r.risky.length >= 3, '只认出 ' + r.risky.length + ' 个有 display 冲突的 class');
});

test('当前样式表里没有"hidden 被 display 盖住"的问题', function () {
  const r = analyze(css, html + adminHtml, appJs + adminJs);
  assert(r.problems.length === 0, r.problems.join(' / '));
});

test('自证有效：把兜底规则拿掉后，分析器必须报出这几处', function () {
  const withoutGuard = css.split('[hidden] { display: none !important; }').join('');
  const r = analyze(withoutGuard, html + adminHtml, appJs + adminJs);
  assert(r.problems.length >= 3, '拿掉兜底规则后只报出 ' + r.problems.length + ' 处问题，这个测试抓不住 bug');
  const all = r.problems.join(' ');
  assert(all.indexOf('#lightbox') >= 0, '没报出 #lightbox（用户遇到的那个）');
  assert(all.indexOf('#login-view') >= 0, '没报出 #login-view');
  assert(all.indexOf('#poster-tools') >= 0, '没报出 #poster-tools');
});

console.log('');
console.log('passed ' + passed + ', failed ' + failures.length);
if (failures.length) { failures.forEach(function (f) { console.log('  - ' + f); }); process.exit(1); }
