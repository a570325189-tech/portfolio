const state = { file: null, posterBlob: null, duration: null, editing: null, busy: false };

function el(id) { return document.getElementById(id); }

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && data.error) ? data.error : ('请求失败 HTTP ' + res.status));
  return data;
}

function msg(node, text, kind) {
  node.textContent = text || '';
  node.className = 'msg' + (kind ? ' ' + kind : '');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' + r : r);
}

function putWithProgress(url, blob, contentType, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error('直传 R2 失败 HTTP ' + xhr.status + '（多为 R2 的 CORS 未配置，见 README）'));
    };
    xhr.onerror = function () {
      reject(new Error('直传 R2 网络错误（多为 R2 的 CORS 未配置，见 README）'));
    };
    xhr.send(blob);
  });
}

function loadVideoMeta(file) {
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    v.onloadedmetadata = function () { resolve({ video: v, url: url, duration: v.duration }); };
    v.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取该视频（浏览器不支持该编码？）')); };
  });
}

function seekTo(video, time) {
  return new Promise(function (resolve, reject) {
    let done = false;
    const timer = setTimeout(function () { if (!done) { done = true; reject(new Error('截帧超时')); } }, 8000);
    video.onseeked = function () {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    video.currentTime = time;
  });
}

async function capturePoster(video, time) {
  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error('视频尺寸读取失败');
  const vr = vw / vh;
  const cr = W / H;
  let sw, sh, sx, sy;
  if (vr > cr) { sh = vh; sw = sh * cr; sx = (vw - sw) / 2; sy = 0; }
  else { sw = vw; sh = sw / cr; sx = 0; sy = (vh - sh) / 2; }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  return await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.86); });
}

function showPoster(blob) {
  const box = el('poster-preview');
  const img = el('poster-img');
  if (state.posterUrl) URL.revokeObjectURL(state.posterUrl);
  state.posterUrl = URL.createObjectURL(blob);
  img.src = state.posterUrl;
  box.style.display = 'block';
  el('poster-tools').hidden = false;
}

async function handleFile(file) {
  if (!file) return;
  state.file = file;
  el('drop').textContent = file.name + '  ·  ' + fmtSize(file.size);
  if (!el('title').value) {
    const dot = file.name.lastIndexOf('.');
    el('title').value = dot > 0 ? file.name.slice(0, dot) : file.name;
  }
  try {
    const meta = await loadVideoMeta(file);
    state.duration = meta.duration;
    state.videoEl = meta.video;
    const t = Math.min(1, Math.max(0, (meta.duration || 2) * 0.1));
    el('poster-time').value = t.toFixed(1);
    const blob = await capturePoster(meta.video, t);
    state.posterBlob = blob;
    showPoster(blob);
  } catch (err) {
    msg(el('form-msg'), '封面抓帧失败：' + err.message + '（仍可上传，封面稍后再补）', 'err');
  }
}

async function recapture() {
  if (!state.videoEl) return;
  try {
    const t = Number(el('poster-time').value) || 0;
    await seekTo(state.videoEl, Math.min(t, Math.max(0, (state.duration || 1) - 0.1)));
    state.posterBlob = await capturePoster(state.videoEl, t);
    showPoster(state.posterBlob);
    msg(el('form-msg'), '已重新截帧', 'ok');
  } catch (err) {
    msg(el('form-msg'), '重截失败：' + err.message, 'err');
  }
}

function setProgress(ratio) {
  const box = el('progress');
  if (ratio === null) { box.style.display = 'none'; el('progress-bar').style.width = '0'; return; }
  box.style.display = 'block';
  el('progress-bar').style.width = Math.round(ratio * 100) + '%';
}

function resetForm() {
  state.file = null;
  state.posterBlob = null;
  state.duration = null;
  state.editing = null;
  el('file').value = '';
  el('drop').textContent = '点击选择视频，或把文件拖到这里';
  el('title').value = '';
  el('description').value = '';
  el('tags').value = '';
  el('engine').value = '';
  el('role').value = '';
  el('order').value = '0';
  el('poster-preview').style.display = 'none';
  el('poster-tools').hidden = true;
  el('form-title').textContent = '上传新作品';
  el('form-hint').textContent = '选择视频后自动抓取封面；抓帧后可调时间点重截。';
  el('submit').textContent = '上传并发布';
  el('cancel-edit').hidden = true;
  setProgress(null);
  msg(el('form-msg'), '');
}

async function submit() {
  if (state.busy) return;
  const out = el('form-msg');
  const title = el('title').value.trim();
  if (!title) { msg(out, '标题不能为空', 'err'); return; }
  if (!state.editing && !state.file) { msg(out, '请先选择视频文件', 'err'); return; }

  const meta = {
    title: title,
    description: el('description').value,
    tags: el('tags').value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }),
    engine: el('engine').value,
    role: el('role').value,
    order: Number(el('order').value) || 0
  };

  state.busy = true;
  el('submit').disabled = true;
  try {
    if (state.editing) {
      msg(out, '正在保存…');
      await api('/api/videos', { method: 'POST', body: Object.assign({}, meta, {
        id: state.editing.id,
        videoKey: state.editing.videoKey,
        posterKey: state.editing.posterKey || null
      }) });
      msg(out, '已保存修改', 'ok');
    } else {
      msg(out, '1/4 申请上传地址…');
      const slot = await api('/api/upload-url', { method: 'POST', body: { filename: state.file.name, kind: 'video' } });
      msg(out, '2/4 上传视频（' + fmtSize(state.file.size) + '）…');
      await putWithProgress(slot.uploadUrl, state.file, state.file.type || 'video/mp4', function (p) {
        setProgress(p);
        msg(out, '2/4 上传视频 ' + Math.round(p * 100) + '%');
      });
      setProgress(1);

      let posterKey = null;
      if (state.posterBlob) {
        msg(out, '3/4 上传封面…');
        const pslot = await api('/api/upload-url', { method: 'POST', body: { id: slot.id, kind: 'poster' } });
        await putWithProgress(pslot.uploadUrl, state.posterBlob, 'image/jpeg', null);
        posterKey = pslot.key;
      }

      msg(out, '4/4 写入作品信息…');
      await api('/api/videos', { method: 'POST', body: Object.assign({}, meta, {
        videoKey: slot.key,
        posterKey: posterKey,
        duration: state.duration || null,
        size: state.file.size || null
      }) });
      msg(out, '发布成功', 'ok');
      resetForm();
      await loadList();
    }
  } catch (err) {
    msg(out, err.message, 'err');
  } finally {
    state.busy = false;
    el('submit').disabled = false;
    setProgress(null);
  }
}

function startEdit(v) {
  state.editing = v;
  state.file = null;
  el('title').value = v.title || '';
  el('description').value = v.description || '';
  el('tags').value = (v.tags || []).join(', ');
  el('engine').value = v.engine || '';
  el('role').value = v.role || '';
  el('order').value = String(v.order || 0);
  el('form-title').textContent = '编辑文案';
  el('form-hint').textContent = '只改标题、简介、标签与排序；视频与封面保持不变。';
  el('submit').textContent = '保存修改';
  el('cancel-edit').hidden = false;
  el('poster-preview').style.display = 'none';
  el('poster-tools').hidden = true;
  el('drop').textContent = '（编辑模式不需要重新选择视频）';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  msg(el('form-msg'), '');
}

async function del(v) {
  if (!confirm('确定删除《' + v.title + '》？视频文件会从存储中一并删除，不可恢复。')) return;
  try {
    await api('/api/videos/' + v.id, { method: 'DELETE' });
    await loadList();
  } catch (err) {
    alert('删除失败：' + err.message);
  }
}

async function loadList() {
  const box = el('list');
  box.textContent = '';
  let data;
  try {
    data = await api('/api/videos');
  } catch (err) {
    box.appendChild(make('p', 'hint', '加载失败：' + err.message));
    return;
  }
  el('list-count').textContent = '(' + data.count + ')';
  if (!data.videos.length) {
    box.appendChild(make('p', 'hint', '还没有作品。'));
    return;
  }
  data.videos.forEach(function (v) {
    const item = make('div', 'item');
    const mini = make('div', 'mini');
    if (v.poster) {
      const img = document.createElement('img');
      img.src = v.poster;
      img.alt = '';
      img.loading = 'lazy';
      mini.appendChild(img);
    }
    item.appendChild(mini);

    const info = make('div');
    info.appendChild(make('h3', null, v.title));
    const bits = [];
    if (v.engine) bits.push(v.engine);
    if (v.role) bits.push(v.role);
    if (v.duration) bits.push(fmtDuration(v.duration));
    if (v.size) bits.push(fmtSize(v.size));
    if (v.tags && v.tags.length) bits.push(v.tags.join(' / '));
    info.appendChild(make('div', 'm', bits.join('  ·  ')));
    item.appendChild(info);

    const acts = make('div', 'acts');
    const bEdit = make('button', 'ghost', '编辑文案');
    bEdit.type = 'button';
    bEdit.addEventListener('click', function () { startEdit(v); });
    const bDel = make('button', 'danger', '删除');
    bDel.type = 'button';
    bDel.addEventListener('click', function () { del(v); });
    acts.appendChild(bEdit);
    acts.appendChild(bDel);
    item.appendChild(acts);

    box.appendChild(item);
  });
}

async function boot() {
  let session = { authed: false };
  try { session = await api('/api/session'); } catch (e) {}
  if (session.authed) return enterAdmin();
  el('login-view').hidden = false;
}

function enterAdmin() {
  el('login-view').hidden = true;
  el('admin-view').hidden = false;
  el('logout').hidden = false;
  el('who').textContent = '已登录 · 可以上传与删除';
  loadList();
}

function wire() {
  el('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    msg(el('login-msg'), '验证中…');
    try {
      await api('/api/login', { method: 'POST', body: { password: el('password').value } });
      el('password').value = '';
      msg(el('login-msg'), '');
      enterAdmin();
    } catch (err) {
      msg(el('login-msg'), err.message, 'err');
    }
  });

  el('logout').addEventListener('click', async function () {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  });

  el('drop').addEventListener('click', function () { el('file').click(); });
  el('file').addEventListener('change', function (e) { handleFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(function (ev) {
    el('drop').addEventListener(ev, function (e) { e.preventDefault(); el('drop').classList.add('hot'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    el('drop').addEventListener(ev, function (e) { e.preventDefault(); el('drop').classList.remove('hot'); });
  });
  el('drop').addEventListener('drop', function (e) {
    const f = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
    if (f) handleFile(f);
  });

  el('recapture').addEventListener('click', recapture);
  el('submit').addEventListener('click', submit);
  el('cancel-edit').addEventListener('click', resetForm);
}

wire();
boot();
