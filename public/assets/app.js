const PAGE_SIZE = 12;
const state = { videos: [], tags: [], filter: '全部', index: -1, page: 1 };

function el(id) { return document.getElementById(id); }

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' + r : r);
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

async function loadJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { return null; }
}

function visible() {
  if (state.filter === '全部') return state.videos;
  return state.videos.filter(function (v) { return v.tags.indexOf(state.filter) >= 0; });
}

function pageCount() {
  return Math.max(1, Math.ceil(visible().length / PAGE_SIZE));
}

function pageItems() {
  const all = visible();
  const start = (state.page - 1) * PAGE_SIZE;
  return all.slice(start, start + PAGE_SIZE);
}

function renderFilter() {
  const box = el('tag-filter');
  box.textContent = '';
  const all = ['全部'].concat(state.tags);
  all.forEach(function (tag) {
    const b = make('button', 'chip' + (tag === state.filter ? ' on' : ''), tag);
    b.type = 'button';
    b.addEventListener('click', function () {
      state.filter = tag;
      state.page = 1;
      renderFilter();
      renderGrid();
    });
    box.appendChild(b);
  });
}

function renderGrid() {
  const grid = el('grid');
  const all = visible();
  const maxPage = pageCount();
  if (state.page > maxPage) state.page = maxPage;
  if (state.page < 1) state.page = 1;
  const list = pageItems();
  grid.textContent = '';
  el('empty').hidden = all.length > 0;
  el('count').textContent = all.length > 0 ? ('共 ' + all.length + ' 个作品') : '';
  list.forEach(function (v, i) {
    const card = make('article', 'card');
    card.tabIndex = 0;

    const thumb = make('div', 'thumb');
    if (v.poster) {
      const img = document.createElement('img');
      img.src = v.poster;
      img.alt = v.title;
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.appendChild(make('div', 'fallback', v.title));
    }
    if (v.duration) thumb.appendChild(make('span', 'badge', fmtDuration(v.duration)));
    const play = make('div', 'play');
    play.appendChild(make('span', null, '\u25B6'));
    thumb.appendChild(play);
    card.appendChild(thumb);

    const body = make('div', 'card-body');
    body.appendChild(make('h3', 'card-title', v.title));
    const tags = make('div', 'card-tags');
    v.tags.slice(0, 4).forEach(function (t) { tags.appendChild(make('span', 'card-tag', t)); });
    body.appendChild(tags);
    card.appendChild(body);

    function open() { openAt(i); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
    grid.appendChild(card);
  });
  renderPager();
}

function pageWindow(current, total) {
  const marks = [1, total, current - 1, current, current + 1];
  const picked = [];
  marks.forEach(function (p) {
    if (p >= 1 && p <= total && picked.indexOf(p) < 0) picked.push(p);
  });
  picked.sort(function (a, b) { return a - b; });
  const out = [];
  let prev = 0;
  picked.forEach(function (p) {
    if (prev && p - prev > 1) out.push(0);
    out.push(p);
    prev = p;
  });
  return out;
}

function renderPager() {
  const total = pageCount();
  const pager = el('pager');
  if (total <= 1) {
    pager.hidden = true;
    el('pg-nums').textContent = '';
    return;
  }
  pager.hidden = false;
  el('pg-prev').disabled = state.page <= 1;
  el('pg-next').disabled = state.page >= total;
  const nums = el('pg-nums');
  nums.textContent = '';
  pageWindow(state.page, total).forEach(function (p) {
    if (p === 0) { nums.appendChild(make('span', 'pg-gap', '…')); return; }
    const b = make('button', 'pg' + (p === state.page ? ' on' : ''), String(p));
    b.type = 'button';
    b.addEventListener('click', function () { goPage(p); });
    nums.appendChild(b);
  });
  el('pg-input').value = '';
}

function goPage(p) {
  const total = pageCount();
  let target = Math.floor(Number(p));
  if (!isFinite(target)) return;
  if (target < 1) target = 1;
  if (target > total) target = total;
  if (target === state.page) { el('pg-input').value = ''; return; }
  state.page = target;
  renderGrid();
  history.replaceState(null, '', '#page=' + target);
  const host = document.querySelector('main');
  if (host && host.scrollIntoView) {
    try { host.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { window.scrollTo(0, 0); }
  }
}

function wirePager() {
  el('pg-prev').addEventListener('click', function () { goPage(state.page - 1); });
  el('pg-next').addEventListener('click', function () { goPage(state.page + 1); });
  el('pg-input').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const raw = el('pg-input').value.trim();
    if (!raw) return;
    goPage(raw);
  });
}

function openAt(i) {
  const list = pageItems();
  if (i < 0 || i >= list.length) return;
  state.index = i;
  const v = list[i];
  const video = el('lb-video');
  video.poster = v.poster || '';
  video.src = v.url;
  el('lb-title').textContent = v.title;

  const tags = el('lb-tags');
  tags.textContent = '';
  v.tags.forEach(function (t) {
    tags.appendChild(make('span', 'chip static', t));
  });

  const desc = el('lb-desc');
  desc.textContent = v.description || '';
  desc.hidden = !v.description;

  const bits = [];
  if (v.engine) bits.push('引擎：' + v.engine);
  if (v.role) bits.push('职责：' + v.role);
  if (v.duration) bits.push('时长：' + fmtDuration(v.duration));
  if (v.size) bits.push('文件：' + fmtSize(v.size));
  el('lb-meta').textContent = bits.join('   ·   ');

  el('lb-prev').disabled = i <= 0;
  el('lb-next').disabled = i >= list.length - 1;
  el('lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  history.replaceState(null, '', '#v=' + v.id);
  video.play().catch(function () {});
}

function closeLb() {
  const video = el('lb-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  el('lightbox').hidden = true;
  document.body.style.overflow = '';
  state.index = -1;
  history.replaceState(null, '', state.page > 1 ? ('#page=' + state.page) : (location.pathname + location.search));
}

function step(delta) {
  if (state.index < 0) return;
  openAt(state.index + delta);
}

function openEmail() {
  el('email-modal').hidden = false;
  document.body.style.overflow = 'hidden';
  el('email-msg').className = 'msg';
  el('email-msg').textContent = '';
}

function closeEmail() {
  el('email-modal').hidden = true;
  if (el('lightbox').hidden) document.body.style.overflow = '';
}

function copyEmail() {
  const text = el('email-value').textContent || '';
  const msg = el('email-msg');
  const ok = function () { msg.className = 'msg ok'; msg.textContent = '已复制，直接粘贴就行'; };
  const manual = function () {
    try {
      const range = document.createRange();
      range.selectNodeContents(el('email-value'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      msg.className = 'msg';
      msg.textContent = '已选中，按 Ctrl+C 复制';
    } catch (e) {
      msg.className = 'msg';
      msg.textContent = '请手动选中上面的地址复制';
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok).catch(manual);
  } else {
    manual();
  }
}

function wireEmail() {
  el('email-modal').addEventListener('click', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-emclose')) closeEmail();
  });
  el('email-copy').addEventListener('click', copyEmail);
  el('email-value').addEventListener('click', copyEmail);
}

function wireLightbox() {
  el('lightbox').addEventListener('click', function (e) {
    if (e.target.getAttribute && e.target.getAttribute('data-close')) closeLb();
  });
  el('lb-prev').addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
  el('lb-next').addEventListener('click', function (e) { e.stopPropagation(); step(1); });
  document.addEventListener('keydown', function (e) {
    if (!el('email-modal').hidden) {
      if (e.key === 'Escape') closeEmail();
      return;
    }
    if (el('lightbox').hidden) return;
    if (e.key === 'Escape') closeLb();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.title) { document.title = cfg.title; el('site-title').textContent = cfg.title; }
  if (cfg.subtitle) el('site-sub').textContent = cfg.subtitle;
  if (cfg.email) el('email-value').textContent = cfg.email;
  const links = el('site-links');
  links.textContent = '';
  (cfg.links || []).forEach(function (l) {
    if (l.action === 'email') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'linkbtn';
      b.textContent = l.label;
      b.addEventListener('click', openEmail);
      links.appendChild(b);
      return;
    }
    const a = document.createElement('a');
    a.href = l.href;
    a.textContent = l.label;
    if (String(l.href || '').indexOf('http') === 0) { a.target = '_blank'; a.rel = 'noreferrer'; }
    links.appendChild(a);
  });
  const owner = cfg.owner ? ('\u00A9 ' + cfg.owner) : '';
  el('foot').textContent = owner;
}

async function main() {
  wireLightbox();
  wireEmail();
  wirePager();
  const cfg = await loadJson('/config.json');
  applyConfig(cfg);

  const data = await loadJson('/api/videos');
  if (!data) {
    el('empty').hidden = false;
    el('empty').textContent = '作品列表加载失败，请稍后刷新。';
    return;
  }
  state.videos = data.videos || [];
  state.tags = data.tags || [];
  renderFilter();
  renderGrid();

  if (state.videos.length && state.videos[0].url) {
    try {
      const origin = new URL(state.videos[0].url).origin;
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = origin;
      document.head.appendChild(link);
    } catch (e) {}
  }

  const pm = location.hash.match(/^#page=([0-9]+)$/);
  if (pm) {
    const want = parseInt(pm[1], 10);
    if (isFinite(want) && want > 1) {
      state.page = Math.min(pageCount(), want);
      renderGrid();
    }
  }
  const m = location.hash.match(/^#v=([A-Za-z0-9-]+)$/);
  if (m) {
    const idx = visible().findIndex(function (v) { return v.id === m[1]; });
    if (idx >= 0) {
      state.page = Math.floor(idx / PAGE_SIZE) + 1;
      renderGrid();
      openAt(idx - (state.page - 1) * PAGE_SIZE);
    }
  }
}

main();
