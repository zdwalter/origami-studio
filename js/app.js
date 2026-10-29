/*
 * app.js — 纸境 · 折纸仿真平台 application shell.
 * Wires together: CPPatterns (library) → CP (model) → OrigamiSolver (physics) → PaperRenderer (WebGL),
 * CPEditor (2D crease-pattern design), StepView/StepFold/StepModels (interactive step-by-step folding).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var LS = { current: 'origami-studio.current.v1', mine: 'origami-studio.mine.v1', prefs: 'origami-studio.prefs.v1' };
  var COLORS = { B: '#1f2328', M: '#e5484d', V: '#3e7bfa', F: '#b9b9b9', U: '#e0a526', C: '#2fb36d' };
  var SWATCHES = [['#e8553d', '#f6f1e7'], ['#2f6fed', '#ffffff'], ['#1f9d72', '#f4efe2'], ['#f2b632', '#fffaf0'], ['#7a4bd1', '#efe9fb'],
    ['#222222', '#c9a45c'], ['#d94f8a', '#fff1f6'], ['#f5f2ea', '#f5f2ea'], ['#8b2c2c', '#e8d7b5']];
  var SIM_PARAMS = [
    { key: 'axialStiffness', label: '轴向刚度', min: 5, max: 80, step: 1 },
    { key: 'creaseStiffness', label: '折痕刚度', min: 0.05, max: 3, step: 0.05 },
    { key: 'facetStiffness', label: '面板刚度', min: 0.05, max: 3, step: 0.05 },
    { key: 'damping', label: '阻尼', min: 0.05, max: 1, step: 0.01 },
    { key: 'speed', label: '折叠速度', min: 0.1, max: 3, step: 0.1 }
  ];
  var DEFAULT_SIM = { axialStiffness: 20, creaseStiffness: 0.7, facetStiffness: 0.7, damping: 0.45, speed: 1 };

  var S = {
    mode: 'sim', doc: null, presetId: null, params: null, mesh: null, solver: null, renderer: null,
    target: 0, fp: 0, playing: false, playDir: 1, playHold: 0, settled: 0, sleepT: 0, sim: Object.assign({}, DEFAULT_SIM),
    showStrain: false, front: '#e8553d', back: '#f6f1e7', category: 'all', editor: null, stepView: null, rebuildTimer: 0,
    collisionPref: true,
    frames: 0, fpsT: performance.now(), fps: 0, itersPerFrame: 0, autoFit: true, fitPending: false, grab: false
  };

  // ------------------------------------------------------------------ utilities
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, err ? 4200 : 2200);
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function download(name, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function dataURLtoBlob(u) {
    var p = u.split(','), bin = atob(p[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: p[0].split(':')[1].split(';')[0] });
  }
  function fileBase() {
    // 分步折叠模式下用分步模型的折痕名（S.doc 那时是上一次 3D 的旧文档，文件名会张冠李戴）
    var nm = (S.mode === 'step' && S.stepView && S.stepView.getCreasePattern && S.stepView.getCreasePattern().name) || (S.doc && S.doc.name) || 'origami';
    if (S.mode === 'step') nm = String(nm).replace(/\s*折痕$/, '') + ' 折痕';
    return String(nm).replace(/[\\/:*?"<>|\s]+/g, '_');
  }
  // 构建版本号（来自 index.html 给 app.js 打的 ?v= 戳）+ 有新版本时提示刷新
  var BUILD_VER = (function () {
    try {
      var src = (document.querySelector('script[src*="app.js"]') || {}).src || '';
      var m = src.match(/[?&]v=([0-9A-Za-z._-]+)/);
      return m ? m[1] : 'dev';
    } catch (e) { return 'dev'; }
  })();
  function showBuildVer() {
    var el = document.getElementById('buildVer');
    if (el) el.textContent = '构建版本：' + BUILD_VER + (BUILD_VER === 'dev' ? '（本地开发）' : '');
  }
  function checkForUpdate() {
    // file:// 下 fetch 会被 CORS 拦掉，本地打开时跳过版本检查
    try {
      if (location.protocol === 'file:' || location.protocol === 'null:') return;
      fetch('version.json?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.version) return;
        if (BUILD_VER !== 'dev' && j.version !== BUILD_VER) {
          toast('页面有新版本（' + j.version + '），请刷新一次（Cmd/Ctrl+Shift+R）', true);
        }
      }).catch(function () {});
    } catch (e) {}
  }

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function stars(n) { return '★★★★★'.slice(0, n) + '<span style="opacity:.25">' + '★★★★★'.slice(n) + '</span>'; }
  function cleanDoc(doc) {
    return { name: doc.name || '未命名', description: doc.description || '', width: doc.width || 1, height: doc.height || 1,
      lines: (doc.lines || []).map(function (l) {
        var o = { a: [+l.a[0], +l.a[1]], b: [+l.b[0], +l.b[1]], type: l.type, angle: l.angle };
        if (l.stage) o.stage = l.stage;          // 折痕分阶段时必须保留，否则会退回“所有折痕同时折”
        return o;
      }),
      presetId: doc.presetId, params: doc.params, foldPercent: doc.foldPercent, removeCutIslands: doc.removeCutIslands,
      flatFoldable: doc.flatFoldable, approximate: doc.approximate, stackedLayers: doc.stackedLayers,
      curves: doc.curves || undefined };
  }

  /** Draw a crease pattern into a 2D canvas context (thumbnails, PNG export). */
  function drawCP(canvas, doc, opts) {
    opts = opts || {};
    var dpr = opts.dpr || Math.min(window.devicePixelRatio || 1, 2);
    var cw = opts.width || canvas.clientWidth || 52, ch = opts.height || canvas.clientHeight || cw;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = opts.bg || '#f7f5f0'; ctx.fillRect(0, 0, cw, ch);
    var pad = opts.pad === undefined ? Math.max(3, cw * 0.06) : opts.pad;
    var w = doc.width || 1, h = doc.height || 1, s = Math.min((cw - 2 * pad) / w, (ch - 2 * pad) / h);
    var ox = (cw - w * s) / 2, oy = (ch - h * s) / 2;
    ctx.fillStyle = opts.paper || '#ffffff'; ctx.fillRect(ox, oy, w * s, h * s);
    var lines = (opts.normalized ? doc.lines : (doc.lines || []));
    var order = { F: 0, U: 1, M: 2, V: 2, C: 3, B: 4 };
    lines.slice().sort(function (a, b) { return order[a.type] - order[b.type]; }).forEach(function (l) {
      ctx.beginPath();
      ctx.strokeStyle = COLORS[l.type] || '#000';
      var lw = l.type === 'B' ? 1.6 : l.type === 'F' ? 0.6 : 1.1;
      ctx.lineWidth = lw * (opts.lineScale || 1);
      ctx.globalAlpha = (l.type === 'M' || l.type === 'V') ? Math.max(0.35, (l.angle === undefined ? 180 : l.angle) / 180) : 1;
      if (opts.dashed) {
        var d = opts.lineScale || 1;
        ctx.setLineDash(l.type === 'V' ? [6 * d, 4 * d] : l.type === 'M' ? [8 * d, 3 * d, 2 * d, 3 * d] : l.type === 'U' ? [2 * d, 3 * d] : []);
      }
      ctx.moveTo(ox + l.a[0] * s, oy + l.a[1] * s); ctx.lineTo(ox + l.b[0] * s, oy + l.b[1] * s); ctx.stroke();
      ctx.setLineDash([]);
    });
    ctx.globalAlpha = 1;
    return { ox: ox, oy: oy, s: s };
  }

  // ------------------------------------------------------------------ simulation
  function rendererMesh(mesh, solver) {
    var n = mesh.nodes2d.length, uvs = new Float32Array(n * 2), idx = new Uint32Array(mesh.tris.length * 3);
    for (var i = 0; i < n; i++) { uvs[i * 2] = mesh.nodes2d[i][0] / mesh.width; uvs[i * 2 + 1] = mesh.nodes2d[i][1] / mesh.height; }
    mesh.tris.forEach(function (t, k) { idx[k * 3] = t[0]; idx[k * 3 + 1] = t[1]; idx[k * 3 + 2] = t[2]; });
    var lineIdx = [];
    mesh.edges.forEach(function (e) { if (e.line) lineIdx.push([e.n[0], e.n[1], e.type]); });
    return { positions: solver.positions, uvs: uvs, indices: idx, lineIdx: lineIdx };
  }

  /** (Re)build mesh + solver for the current document. keepFold: continue folding from current percentage. */
  function rebuild(opts) {
    opts = opts || {};
    var doc = S.doc;
    var t0 = performance.now();
    var mesh;
    try { mesh = CP.buildMesh(doc); }
    catch (e) { console.error(e); toast('无法生成网格：' + e.message, true); return; }
    if (!mesh.tris.length) { toast('折痕图没有可用的面', true); return; }
    S.mesh = mesh;
    S.solver = new OrigamiSolver(mesh, S.sim);
    // 多层紧贴的图案（菱形筒、同心圆褶）：开了自碰撞会把几十层纸顶开、把形状撑变形，这里临时关掉
    var effCollision = doc.stackedLayers ? false : S.collisionPref;
    S.solver.params.collision = effCollision;
    if ($('collisionChk')) $('collisionChk').checked = effCollision;
    if (doc.stackedLayers && S.collisionPref && opts.toast !== false) {
      toast('这个图案折起来就是多层紧贴在一起，已临时关闭自碰撞（打开会把层顶开、形状变形）');
    }
    if ($('thicknessRange')) S.solver.params.thickness = (+$('thicknessRange').value) / 1000;
    S.fp = 0;
    S.solver.setFoldPercent(0);
    if (S.renderer) {
      S.renderer.setMesh(rendererMesh(mesh, S.solver));
      if (opts.fit !== false) { S.renderer.fit(false); }
    }
    S.settled = 0;
    S.fitPending = true;
    updateInfo();
    updateCPPanel();
    if (mesh.warnings.length && opts.warn !== false) toast(mesh.warnings.join('；'));
    S.buildMs = performance.now() - t0;
  }

  function setTarget(pct, fromUser) {
    S.target = Math.max(-1, Math.min(1, pct));
    $('foldRange').value = Math.round(S.target * 100);
    $('foldVal').textContent = Math.round(S.target * 100) + '%';
    S.settled = 0;
    if (fromUser && S.playing) setPlaying(false);
  }
  function setPlaying(on) {
    S.playing = on;
    document.body.classList.toggle('playing', on);
    $('btnPlay').title = on ? '暂停 (空格)' : '播放折叠动画 (空格)';
    if (on) { S.playDir = S.target >= 0.99 ? -1 : 1; S.playHold = 0; S.settled = 0; }
  }

  function strainColor(t) {
    // blue → cyan → yellow → orange → red
    var stops = [[0.17, 0.48, 0.71], [0.67, 0.85, 0.91], [1, 1, 0.75], [0.99, 0.68, 0.38], [0.84, 0.1, 0.11]];
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  var lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    var r = S.renderer, s = S.solver;
    if (!r) return;
    var visible = S.mode !== 'step';
    if (s && visible) {
      // play: ping-pong between 0 and 100 %
      if (S.playing) {
        if (S.playHold > 0) { S.playHold -= dt; if (S.playHold <= 0) S.playDir *= -1; }
        else {
          var nt = S.target + S.playDir * dt * 0.35 * S.sim.speed;
          if (nt >= 1) { nt = 1; S.playHold = 0.9; } else if (nt <= 0) { nt = 0; S.playHold = 0.6; }
          setTarget(nt);
        }
      }
      // ramp actual fold percentage toward target to keep the explicit integrator stable
      var rate = 0.9 * S.sim.speed * dt;
      var d = S.target - S.fp;
      S.fp += Math.abs(d) < rate ? d : Math.sign(d) * rate;
      s.setFoldPercent(S.fp);
      if (S.settled < 90 || s.grab) {
        // as many solver iterations as fit in ~9 ms
        var budget = 9, t0 = performance.now(), iters = 0, batch = 10;
        while (performance.now() - t0 < budget && iters < 400) { s.step(batch); iters += batch; }
        S.itersPerFrame = iters;
        var ke = s.kinetic();
        // 只在“折完了、而且纸静止了”之后才慢慢把纸面转正：
        // 折叠过程中纸面法向本来就在变，这时候去追它，会让纸一直轻轻发抖。
        var foldMoving = Math.abs(S.target - S.fp) > 1e-6;
        if (!s.grab && !foldMoving && ke < 1e-7) s.orient(0.12);
        // 完全静止、而且纸面已经朝观众了，才算“停稳”——否则继续微调朝向
        var facing = (s._flatness !== undefined && s._flatness < 0.6) || ((s._orientErr === undefined ? 0 : s._orientErr) < 0.05);
        var still = Math.abs(S.target - S.fp) < 1e-6 && !s.grab && facing;
        // 碰撞/接触会留下纳米级的持续微动，永远等不到 ke<1e-9；下面加“休眠”：
        // 速度足够小并且持续 25 帧，就直接清零速度并停止迭代，避免纸一直轻轻发抖。
        if (still && s.maxSpeed() < 2e-3) S.sleepT++; else S.sleepT = 0;
        if (S.sleepT > 25) { s.v.fill(0); S.settled = 90; S.sleepT = 0; }
        else if (still && ke < 1e-9) S.settled++; else S.settled = 0;
        r.updatePositions(s.positions);
        if (S.showStrain) {
          var st = s.strain(), cols = new Float32Array(s.n * 3), ref = Math.max(0.01, st.max);
          for (var i = 0; i < s.n; i++) { var c = strainColor(st.node[i] / ref); cols[i * 3] = c[0]; cols[i * 3 + 1] = c[1]; cols[i * 3 + 2] = c[2]; }
          r.setColors(cols);
          $('strainMax').textContent = (st.max * 100).toFixed(2) + '%';
        }
        if (S.autoFit && S.fitPending && Math.abs(S.target - S.fp) < 1e-6 && ke < 1e-6) { r.fit(true); S.fitPending = false; }
      } else S.itersPerFrame = 0;
    }
    if (visible && (r.dirty || r.camGoal)) r.render();
    // stats ~4x per second
    S.frames++;
    if (now - S.fpsT > 250) {
      S.fps = S.frames * 1000 / (now - S.fpsT); S.frames = 0; S.fpsT = now;
      if (s && visible) updateStats();
    }
  }

  function updateStats() {
    var s = S.solver, m = S.mesh;
    if (!s) return;
    var c = { M: 0, V: 0, U: 0 };
    m.hinges.forEach(function (h) { if (c[h.type] !== undefined) c[h.type]++; });
    $('stNodes').textContent = s.n + ' / ' + m.tris.length;
    $('stCreases').textContent = c.M + ' / ' + c.V + ' / ' + c.U;
    $('stErr').textContent = s.creaseError().toFixed(2) + '°';
    $('stStrain').textContent = (s.strain().max * 100).toFixed(3) + '%';
    $('stIter').textContent = S.itersPerFrame ? S.itersPerFrame : '静止';
    $('stContacts').textContent = s.params.collision ? (s.collisions || 0) + ' 处' : '已关闭';
    $('stFps').textContent = S.fps.toFixed(0) + ' fps';
  }

  function updateInfo() {
    var d = S.doc;
    $('modelName').textContent = d.name || '未命名';
    var st = CP.stats(d);
    $('modelInfo').textContent = '纸张 ' + (+d.width.toFixed(3)) + ' × ' + (+d.height.toFixed(3)) + ' · ' + st.counts.M + ' 山折 · ' + st.counts.V + ' 谷折' + (st.counts.C ? ' · ' + st.counts.C + ' 剪切' : '');
    document.title = (d.name || '未命名') + ' · 纸境 折纸仿真平台';
  }

  function updateCPPanel() {
    var d = S.doc;
    var lines = CP.normalize(d.lines, { width: d.width, height: d.height });
    var thumb = $('cpThumb');
    var w = thumb.clientWidth || 260;
    drawCP(thumb, { width: d.width, height: d.height, lines: lines }, { width: w, height: w, dashed: true, lineScale: 1, normalized: true });
    var st = CP.stats(d), v = CP.validate(d);
    $('cpStats').textContent = st.vertices + ' 顶点 · ' + st.edges + ' 边 · ' + st.faces + ' 面';
    var color = v.checked === 0 ? 'var(--muted)' : v.ok ? 'var(--ok)' : 'var(--bad)';
    $('validation').innerHTML = '<span class="dot" style="background:' + color + '"></span><span>' + esc(v.summary) + (v.ok && v.checked ? '' : '') + '</span>';
    if (S.editor && S.editor.setValidation) S.editor.setValidation(v);
    // overlay markers on thumbnail
    if (v.checked) {
      var ctx = thumb.getContext('2d'), pad = Math.max(3, w * 0.06), s = Math.min((w - 2 * pad) / d.width, (w - 2 * pad) / d.height);
      var ox = (w - d.width * s) / 2, oy = (w - d.height * s) / 2;
      v.vertices.forEach(function (x) {
        if (x.ok) return;
        ctx.beginPath(); ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 1.5;
        ctx.arc(ox + x.p[0] * s, oy + x.p[1] * s, 4, 0, Math.PI * 2); ctx.stroke();
      });
    }
  }

  // ------------------------------------------------------------------ documents
  function loadDoc(doc, opts) {
    opts = opts || {};
    S.doc = cleanDoc(doc);
    S.presetId = opts.presetId || doc.presetId || null;
    if (S.editor && opts.toEditor !== false) S.editor.setDoc(S.doc, { resetHistory: opts.resetHistory !== false });
    rebuild(opts);
    var fp = opts.foldPercent !== undefined ? opts.foldPercent : (doc.foldPercent !== undefined ? doc.foldPercent : 0.8);
    if (opts.keepTarget) setTarget(S.target); else setTarget(fp);
    renderParams();
    markActiveLib();
    saveCurrent();
    if (!opts.fromHash && /#cp=/.test(location.hash)) history.replaceState(null, '', location.href.split('#')[0]);
  }
  function loadPreset(id, vals, opts) {
    var doc = CPPatterns.create(id, vals);
    S.params = doc.params;
    loadDoc(doc, Object.assign({ presetId: id }, opts || {}));
  }

  function renderParams() {
    var card = $('paramCard'), list = $('paramList');
    var meta = S.presetId && CPPatterns.list().filter(function (p) { return p.id === S.presetId; })[0];
    if (!meta || !meta.params.length) { card.hidden = true; return; }
    card.hidden = false;
    list.innerHTML = '';
    meta.params.forEach(function (p) {
      var val = S.doc.params && S.doc.params[p.key] !== undefined ? S.doc.params[p.key] : p.value;
      var row = document.createElement('div'); row.className = 'param';
      row.innerHTML = '<label title="' + esc(p.label) + '">' + esc(p.label) + '</label><input type="range" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + val + '"><output>' + val + '</output>';
      var inp = row.querySelector('input'), out = row.querySelector('output');
      inp.addEventListener('input', function () {
        out.textContent = inp.value;
        clearTimeout(S.rebuildTimer);
        S.rebuildTimer = setTimeout(function () {
          var vals = Object.assign({}, S.doc.params || {}); vals[p.key] = +inp.value;
          var doc = CPPatterns.create(S.presetId, vals);
          loadDoc(doc, { presetId: S.presetId, keepTarget: true, fit: false });
        }, 120);
      });
      list.appendChild(row);
    });
  }

  function saveCurrent() {
    lsSet(LS.current, { doc: S.doc, presetId: S.presetId, target: S.target });
  }

  // ------------------------------------------------------------------ library UI
  function renderCats() {
    var box = $('libCats');
    var cats = [{ id: 'all', name: '全部' }].concat(CPPatterns.categories);
    box.innerHTML = cats.map(function (c) { return '<button class="chip' + (S.category === c.id ? ' active' : '') + '" data-cat="' + c.id + '">' + esc(c.name) + '</button>'; }).join('');
  }
  function renderLib() {
    var q = $('libSearch').value.trim().toLowerCase(), box = $('libList');
    box.innerHTML = '';
    var all = CPPatterns.list();
    CPPatterns.categories.forEach(function (cat) {
      if (S.category !== 'all' && S.category !== cat.id) return;
      var items = all.filter(function (p) { return p.category === cat.id && (!q || (p.name + p.description + p.id).toLowerCase().indexOf(q) >= 0); });
      if (!items.length) return;
      var g = document.createElement('div'); g.className = 'lib-group'; g.textContent = cat.name; box.appendChild(g);
      items.forEach(function (p) {
        var b = document.createElement('button'); b.className = 'lib-item'; b.dataset.id = p.id;
        b.innerHTML = '<canvas width="52" height="52"></canvas><div><div class="nm">' + esc(p.name) + ' <span class="stars">' + stars(p.difficulty) + '</span></div><div class="ds">' + esc(p.description) + '</div></div>';
        b.title = p.description;
        b.addEventListener('click', function () {
          if (S.mode === 'step') switchMode('sim');
          loadPreset(p.id);
          toast('已载入：' + p.name);
        });
        box.appendChild(b);
        var c = b.querySelector('canvas');
        requestAnimationFrame(function () { drawCP(c, CPPatterns.create(p.id), { width: 52, height: 52 }); });
      });
    });
    if (!box.children.length) box.innerHTML = '<div class="empty">没有匹配的图案</div>';
    markActiveLib();
  }
  function markActiveLib() {
    $$('#libList .lib-item').forEach(function (el) { el.classList.toggle('active', el.dataset.id === S.presetId); });
  }

  function getMine() { return lsGet(LS.mine, []); }
  function renderMine() {
    var list = getMine(), box = $('mineList');
    $('mineCount').textContent = list.length;
    box.innerHTML = list.length ? '' : '<div class="empty">还没有保存的作品。<br>点击顶部“保存”即可收藏当前折痕图。</div>';
    list.forEach(function (it, i) {
      var b = document.createElement('div'); b.className = 'lib-item'; b.tabIndex = 0;
      var ds = new Date(it.time).toLocaleString('zh-CN') + (it.steps && it.steps.length ? ' · ' + it.steps.length + ' 步' : ' · 折痕图');
      b.innerHTML = '<canvas width="52" height="52"></canvas><div><div class="nm">' + esc(it.name) + '<button class="del" title="删除">×</button></div><div class="ds">' + ds + '</div></div>';
      b.addEventListener('click', function (e) {
        if (e.target.classList.contains('del')) {
          if (!confirm('删除作品“' + it.name + '”？')) return;
          var l = getMine(); l.splice(i, 1); lsSet(LS.mine, l); renderMine(); return;
        }
        if (it.steps && it.steps.length) {
          // 带步骤的作品：回到分步折叠模式，按保存时的顺序逐歩重放
          switchMode('step');
          setTimeout(function () {
            var model = {
              id: 'mine-' + it.time, name: it.name, width: (it.doc && it.doc.width) || 1, height: (it.doc && it.doc.height) || 1,
              frontColor: S.front, difficulty: 1, description: '我的作品：' + it.name + '（' + it.steps.length + ' 步）', steps: it.steps
            };
            var sel = $('stepModelSel');
            var old = sel.querySelector('option[value="' + model.id + '"]');
            if (old) old.remove();
            var opt = document.createElement('option');
            opt.value = model.id; opt.textContent = model.name; sel.appendChild(opt);
            sel.value = model.id;
            S.stepView.loadModel(model);
            $('stepModelDesc').textContent = model.description;
            toast('已载入分步作品：' + it.name + '（' + it.steps.length + ' 步，可逐步回看）');
          }, 60);
          return;
        }
        if (S.mode === 'step') switchMode('sim');
        loadDoc(it.doc, { foldPercent: it.target !== undefined ? it.target : 0.8 });
        toast('已载入：' + it.name);
      });
      box.appendChild(b);
      drawCP(b.querySelector('canvas'), it.doc, { width: 52, height: 52 });
    });
  }
  function saveToMine() {
    var steps = (S.mode === 'step' && S.stepView) ? S.stepView.getSteps().map(function (st) { return { title: st.title, description: st.description, op: st.op }; }) : null;
    if (S.mode === 'step' && S.stepView) {
      // 作品里存“全部步骤折完”的折痕图：缩略图才是完整作品，而不是当前这一步的样子
      var fin = S.stepView.getFinalCreasePattern ? S.stepView.getFinalCreasePattern() : currentDoc();
      var sel2 = $('stepModelSel');
      var nm2 = sel2 && sel2.selectedOptions[0] ? sel2.selectedOptions[0].textContent.replace(/（.*$/, '').trim() : '分步折叠';
      fin.name = nm2 + ' 折痕'; fin.description = '由分步折叠生成的折痕图';
      S.doc = fin;
    }
    var defName = (S.doc.name || '我的折纸').replace(/\s*折痕$/, '');
    var name = prompt('作品名称（会连同折叠顺序一起保存）', defName);
    if (name === null) return;
    S.doc.name = name.trim() || '我的折纸';
    var list = getMine();
    list.unshift({ name: S.doc.name, time: Date.now(), doc: S.doc, target: S.target, steps: steps || undefined });
    if (list.length > 60) list.length = 60;
    if (!lsSet(LS.mine, list)) { toast('保存失败：浏览器存储空间不足', true); return; }
    updateInfo(); renderMine(); saveCurrent();
    toast(steps && steps.length ? ('已保存到“我的作品”（含 ' + steps.length + ' 步顺序）') : '已保存到“我的作品”');
  }

  // ------------------------------------------------------------------ modes
  function switchMode(mode) {
    if (mode === S.mode) return;
    S.mode = mode;
    $('app').dataset.mode = mode;
    $$('.mode-tab').forEach(function (b) { var on = b.dataset.mode === mode; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
    requestAnimationFrame(function () {
      if (S.renderer) { S.renderer.resize(); S.renderer.fit(false); S.renderer.dirty = true; }
      if (mode === 'design') ensureEditor();
      if (mode === 'step') ensureStepView();
      if (S.editor && S.editor.resize) S.editor.resize();
      if (S.stepView && S.stepView.resize) S.stepView.resize();
      if (mode === 'design' && S.editor && S.editor.fit) S.editor.fit();
    });
    var p = lsGet(LS.prefs, {}); p.mode = mode; lsSet(LS.prefs, p);
  }

  // ------------------------------------------------------------------ crease-pattern editor
  function ensureEditor() {
    if (S.editor) return S.editor;
    if (typeof CPEditor === 'undefined') { $('edStatus').textContent = '折痕编辑器模块未加载'; return null; }
    S.editor = new CPEditor($('cpCanvas'), {
      onChange: function (doc) {
        S.doc = cleanDoc(Object.assign({}, S.doc, doc));
        S.presetId = null; $('paramCard').hidden = true; markActiveLib();
        if (/#cp=/.test(location.hash)) history.replaceState(null, '', location.href.split('#')[0]);
        clearTimeout(S.rebuildTimer);
        S.rebuildTimer = setTimeout(function () { rebuild({ fit: false, warn: false }); saveCurrent(); }, 150);
      },
      onStatus: function (t) { $('edStatus').textContent = t; },
      onSelectionChange: function () { }
    });
    S.editor.setDoc(S.doc, { resetHistory: true });
    applyGrid();
    S.editor.setLineType(currentLineType());
    S.editor.setDefaultAngle(+$('lineAngle').value || 180);
    if (S.editor.setValidation) S.editor.setValidation(CP.validate(S.doc));
    return S.editor;
  }
  function currentLineType() { var a = document.querySelector('#typeGroup .ltype.active'); return a ? a.dataset.type : 'M'; }
  function applyGrid() {
    if (!S.editor) return;
    var v = $('gridSel').value;
    if (v.charAt(0) === 't') S.editor.setGrid({ divisions: +v.slice(1), type: 'triangle' });
    else S.editor.setGrid({ divisions: +v, type: +v ? 'square' : 'none' });
    var on = $('snapChk').checked;
    S.editor.setSnap({ grid: on, vertex: on, midpoint: on, intersection: on, onLine: on, angle22_5: true });
  }
  function setTool(t) {
    $$('#toolGroup .tbtn').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
    if (S.editor) S.editor.setTool(t);
  }
  function setLineType(t) {
    $$('#typeGroup .ltype').forEach(function (b) { b.classList.toggle('active', b.dataset.type === t); });
    if (S.editor) S.editor.setLineType(t);
    if ((t === 'M' || t === 'V') && +$('lineAngle').value === 0) $('lineAngle').value = 180;
  }

  // ------------------------------------------------------------------ step folding
  function ensureStepView() {
    if (S.stepView) return S.stepView;
    if (typeof StepView === 'undefined') { $('stStatus').textContent = '分步折叠模块未加载'; return null; }
    S.stepView = new StepView($('stepCanvas'), {
      onChange: function () {
        renderStepList();
        // 折到最后一步、且这个作品能展开展示时，提示一次
        try {
          var v = S.stepView, info = v.getInfo();
          var m = v.model;
          if (m && m.displayAngles && info.modelSteps > 0 && info.stepIndex >= info.modelSteps) {
            S.hinted3D = S.hinted3D || {};
            if (!S.hinted3D[m.id]) {
              S.hinted3D[m.id] = 1;
              setTimeout(function () { toast('折完了！点「3D 展开展示」看看成品的三维样子'); }, 500);
            }
          }
        } catch (e) {}
      },
      onStatus: function (t) { $('stStatus').textContent = t; }
    });
    S.stepView.setPaperColors($('stFront').value, $('stBack').value);
    var sel = $('stepModelSel');
    sel.innerHTML = '<option value="">— 自由折叠（空白纸） —</option>' + StepModels.list().map(function (m) {
      return '<option value="' + m.id + '">' + esc(m.name) + '（' + '★'.repeat(m.difficulty || 1) + '）</option>';
    }).join('');
    renderStepList();
    return S.stepView;
  }
  function renderStepList() {
    var v = S.stepView; if (!v) return;
    var info = v.getInfo ? v.getInfo() : null;
    var steps = (info && info.steps) || (v.getSteps ? v.getSteps() : []);
    var cur = info ? info.stepIndex : 0;
    var box = $('stSteps');
    if (!steps.length) box.innerHTML = '<li class="user"><div><b>自由折叠</b><span>用工具栏中的工具在纸上自由折叠，或从上方选择教程模型。</span></div></li>';
    else box.innerHTML = steps.map(function (st, i) {
      var cls = i < cur ? 'done' : i === cur ? 'current' : '';
      return '<li class="' + cls + (st.user ? ' user' : '') + '" data-i="' + i + '"><div><b>' + esc(st.title || ('步骤 ' + (i + 1))) + '</b><span>' + esc(st.description || '') + '</span></div></li>';
    }).join('');
    var total = info && info.modelSteps !== undefined ? info.modelSteps : steps.length;
    $('stStepNo').textContent = (info ? Math.min(cur, total) : 0) + ' / ' + total;
    $('stUndo').disabled = $('stPrev').disabled = !v.canUndo(); $('stRedo').disabled = $('stNext').disabled = !v.canRedo();
    var curEl = box.querySelector('.current'); if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'nearest' });
  }
  function stepTo3D() {
    var v = S.stepView; if (!v) return;
    var doc = v.getCreasePattern();
    if (!doc || !doc.lines || !doc.lines.some(function (l) { return l.type === 'M' || l.type === 'V'; })) { toast('还没有折痕，先折几下吧', true); return; }
    var name = ($('stepModelSel').selectedOptions[0] && $('stepModelSel').value ? $('stepModelSel').selectedOptions[0].textContent.replace(/（.*$/, '') : '分步折叠') + ' 折痕';
    doc.name = doc.name || name;
    switchMode('sim');
    loadDoc(doc, { foldPercent: 0.9 });
    toast('已将折痕发送到 3D 仿真（分步折叠的层序信息不会保留，仿真按折痕重新折叠）');
  }

  // ------------------------------------------------------------------ import / export
  function importFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var text = String(reader.result), name = file.name.replace(/\.[^.]+$/, ''), doc;
        if (/^\s*</.test(text)) doc = CP.fromSVG(text, name);
        else {
          var obj = JSON.parse(text);
          if (obj.app === 'origami-studio' && obj.doc) {
            doc = obj.doc;
            if (obj.front) setColors(obj.front, obj.back);
            if (obj.sim) { S.sim = Object.assign({}, DEFAULT_SIM, obj.sim); renderSimParams(); }
          } else doc = CP.fromFOLD(obj, name);
        }
        if (obj && obj.steps && obj.steps.length && S.stepView) {
          // 带步骤的分步折叠工程：回到分步模式逐歩重放，改动不会丢
          switchMode('step');
          setTimeout(function () {
            var model = {
              id: 'imported-' + Date.now(), name: (doc.name || name).replace(/\s*折痕$/, '') || '导入的分步模型',
              width: doc.width, height: doc.height, frontColor: '#e8553d', difficulty: 1,
              description: '从文件导入的分步折叠（' + obj.steps.length + ' 步）', steps: obj.steps
            };
            var sel = $('stepModelSel');
            var opt = document.createElement('option');
            opt.value = model.id; opt.textContent = model.name; sel.appendChild(opt);
            sel.value = model.id;
            S.stepView.loadModel(model);
            $('stepModelDesc').textContent = model.description;
            toast('已导入分步模型：' + model.name + '（' + obj.steps.length + ' 步）');
          }, 60);
          return;
        }
        if (S.mode === 'step') switchMode('sim');
        loadDoc(doc, { foldPercent: doc.foldPercent !== undefined ? doc.foldPercent : 0.7 });
        toast('已导入：' + (doc.name || name));
      } catch (e) { console.error(e); toast('导入失败：' + e.message, true); }
    };
    reader.readAsText(file);
  }
  /** 当前模式下“看到的那张纸”对应的折痕图：分步折叠模式下要用分步视图的状态，
   *  不能再用 S.doc（那是上一次载入 3D 的文档，早就过期了——之前导出拿到旧文件就是这个 bug）。 */
  function currentDoc() {
    if (S.mode === 'step' && S.stepView) {
      var cp = S.stepView.getCreasePattern();
      if (cp && cp.lines && cp.lines.length) {
        var sel = $('stepModelSel');
        var nm = sel && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.replace(/（.*$/, '').trim() : '分步折叠';
        cp.name = nm + ' 折痕';
        cp.description = '由分步折叠生成的折痕图';
        return cp;
      }
    }
    return S.doc;
  }

  function doExport(kind) {
    var base = fileBase(), s = S.solver, doc = currentDoc();
    switch (kind) {
      case 'svg': download(base + '.svg', CP.toSVG(doc), 'image/svg+xml'); break;
      case 'fold': download(base + '.fold', JSON.stringify(CP.toFOLD(doc), null, 1), 'application/json'); break;
      case 'cp-png': {
        var c = document.createElement('canvas');
        var W = 1600, H = Math.round(1600 * (doc.height / doc.width));
        drawCP(c, { width: doc.width, height: doc.height, lines: CP.normalize(doc.lines, doc) }, { width: W, height: H, dpr: 1, dashed: true, lineScale: 3, pad: 40, normalized: true, bg: '#ffffff' });
        download(base + '-cp.png', dataURLtoBlob(c.toDataURL('image/png')));
        break;
      }
      case 'fold3d': if (s) download(base + '-folded.fold', JSON.stringify(s.toFOLD(S.doc.name), null, 1), 'application/json'); break;
      case 'obj': if (s) download(base + '.obj', s.toOBJ(S.doc.name), 'text/plain'); break;
      case 'stl': if (s) download(base + '.stl', new Blob([s.toSTL()], { type: 'model/stl' })); break;
      case 'png': {
        if (S.mode === 'step' && S.stepView) { download(base + '-step.png', dataURLtoBlob(S.stepView.exportPNG())); break; }
        var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#f3f1ec';
        download(base + '-3d.png', dataURLtoBlob(S.renderer.exportPNG(bg)));
        break;
      }
      case 'project': {
        var out = { app: 'origami-studio', version: 1, doc: doc, front: S.front, back: S.back, sim: S.sim, target: S.target };
        // 分步折叠模式下把步骤一起存下来，这样“改过哪一步”不会丢
        if (S.mode === 'step' && S.stepView) {
          out.steps = S.stepView.getSteps().map(function (st) { return { title: st.title, description: st.description, op: st.op }; });
          out.width = doc.width; out.height = doc.height;
        }
        download(base + '.origami.json', JSON.stringify(out, null, 1), 'application/json');
        break;
      }
      case 'link': {
        var url = location.href.split('#')[0] + '#cp=' + encodeShare(S.doc);
        history.replaceState(null, '', url);
        var done = function () { toast('分享链接已复制到剪贴板'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, function () { prompt('复制下面的链接：', url); });
        else prompt('复制下面的链接：', url);
        return;
      }
    }
    toast('已导出');
  }
  function encodeShare(doc) {
    var r = function (x) { return Math.round(x * 1e6) / 1e6; };
    var compact = { n: doc.name, w: r(doc.width), h: r(doc.height), l: doc.lines.filter(function (l) { return l.type !== 'B'; }).map(function (l) { return [r(l.a[0]), r(l.a[1]), r(l.b[0]), r(l.b[1]), l.type, l.angle === undefined ? 180 : r(l.angle)]; }) };
    return btoa(unescape(encodeURIComponent(JSON.stringify(compact)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    var o = JSON.parse(decodeURIComponent(escape(atob(str))));
    return { name: o.n || '分享的折痕图', width: o.w || 1, height: o.h || 1, lines: o.l.map(function (x) { return { a: [x[0], x[1]], b: [x[2], x[3]], type: x[4], angle: x[5] }; }) };
  }

  // ------------------------------------------------------------------ appearance & sim params
  function setColors(front, back) {
    S.front = front; S.back = back;
    $('colFront').value = front; $('colBack').value = back;
    if (S.renderer) S.renderer.set({ front: front, back: back });
    var p = lsGet(LS.prefs, {}); p.front = front; p.back = back; lsSet(LS.prefs, p);
  }
  function renderSimParams() {
    var box = $('simParams'); box.innerHTML = '';
    SIM_PARAMS.forEach(function (p) {
      var row = document.createElement('div'); row.className = 'param';
      var v = S.sim[p.key];
      row.innerHTML = '<label>' + p.label + '</label><input type="range" min="' + p.min + '" max="' + p.max + '" step="' + p.step + '" value="' + v + '"><output>' + v + '</output>';
      var inp = row.querySelector('input'), out = row.querySelector('output');
      inp.addEventListener('input', function () {
        S.sim[p.key] = +inp.value; out.textContent = inp.value;
        if (S.solver && p.key !== 'speed') { var o = {}; o[p.key] = +inp.value; S.solver.setParams(o); }
        S.settled = 0;
        var pr = lsGet(LS.prefs, {}); pr.sim = S.sim; lsSet(LS.prefs, pr);
      });
      box.appendChild(row);
    });
  }

  function toggle(id, on) { $(id).classList.toggle('on', on); }

  // ------------------------------------------------------------------ events
  function bindUI() {
    $$('.mode-tab').forEach(function (b) { b.addEventListener('click', function () { switchMode(b.dataset.mode); }); });
    $$('.ptab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.ptab').forEach(function (x) { x.classList.toggle('active', x === b); });
        $$('[data-ptab-body]').forEach(function (x) { x.hidden = x.dataset.ptabBody !== b.dataset.ptab; });
        if (b.dataset.ptab === 'mine') renderMine();
      });
    });
    $('libCats').addEventListener('click', function (e) { var c = e.target.closest('.chip'); if (!c) return; S.category = c.dataset.cat; renderCats(); renderLib(); });
    $('libSearch').addEventListener('input', renderLib);

    // fold controls
    $('foldRange').addEventListener('input', function () { setTarget(+this.value / 100, true); });
    $$('[data-fold]').forEach(function (b) { b.addEventListener('click', function () { setTarget(+b.dataset.fold / 100, true); }); });
    $('btnPlay').addEventListener('click', function () { setPlaying(!S.playing); });
    $('btnResetSim').addEventListener('click', resetSim);

    // view
    $$('[data-view]').forEach(function (b) { b.addEventListener('click', function () { S.renderer.setView(b.dataset.view); S.renderer.fit(true); }); });
    $('btnFit').addEventListener('click', function () { S.renderer.fit(true); });
    $('btnFull').addEventListener('click', function () {
      var el = $('viewport');
      if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(function () { toast('浏览器不允许全屏', true); });
    });
    document.addEventListener('fullscreenchange', function () { setTimeout(function () { S.renderer.resize(); S.renderer.dirty = true; }, 50); });
    $('togCreases').addEventListener('click', function () { var on = !this.classList.contains('on'); toggle('togCreases', on); S.renderer.set({ showCreases: on, showBoundary: true }); });
    $('togWire').addEventListener('click', function () { var on = !this.classList.contains('on'); toggle('togWire', on); S.renderer.set({ showWire: on }); S.renderer.updatePositions(S.solver.positions); });
    $('togStrain').addEventListener('click', function () {
      var on = !this.classList.contains('on'); toggle('togStrain', on); S.showStrain = on; S.renderer.set({ showStrain: on }); $('strainLegend').hidden = !on; S.settled = 0;
    });
    $('togGround').addEventListener('click', function () { var on = !this.classList.contains('on'); toggle('togGround', on); S.renderer.set({ showGround: on, showShadow: on }); });
    $('togGrab').addEventListener('click', function () { setGrab(!S.grab); });

    // appearance
    $('colFront').addEventListener('input', function () { setColors(this.value, S.back); });
    $('colBack').addEventListener('input', function () { setColors(S.front, this.value); });
    $('swatches').innerHTML = SWATCHES.map(function (s) { return '<button class="sw" style="--f:' + s[0] + ';--b:' + s[1] + '" data-f="' + s[0] + '" data-b="' + s[1] + '" title="' + s[0] + ' / ' + s[1] + '"></button>'; }).join('');
    $('swatches').addEventListener('click', function (e) { var b = e.target.closest('.sw'); if (b) setColors(b.dataset.f, b.dataset.b); });
    $('patternSel').addEventListener('change', function () { S.renderer.set({ pattern: +this.value }); });
    $('texChk').addEventListener('change', function () { S.renderer.set({ texture: this.checked }); });
    $('simDefaults').addEventListener('click', function () { S.sim = Object.assign({}, DEFAULT_SIM); renderSimParams(); if (S.solver) S.solver.setParams(S.sim); S.settled = 0; toast('仿真参数已恢复默认'); });
    $('autoFit').addEventListener('change', function () { S.autoFit = this.checked; });
    $('collisionChk').addEventListener('change', function () {
      S.collisionPref = this.checked;
      if (!S.solver) return;
      S.solver.params.collision = this.checked; S.settled = 0;
      var pr = lsGet(LS.prefs, {}); pr.collision = this.checked; lsSet(LS.prefs, pr);
      toast(this.checked ? '已开启自碰撞：纸张层与层之间会互相顶住' : '已关闭自碰撞：层与层可以互相穿过');
    });
    $('thicknessRange').addEventListener('input', function () {
      $('thicknessOut').textContent = this.value;
      if (S.solver) { S.solver.params.thickness = (+this.value) / 1000; S.settled = 0; }
      var pr = lsGet(LS.prefs, {}); pr.thickness = +this.value; lsSet(LS.prefs, pr);
    });
    $('flatChk').addEventListener('change', function () { S.renderer.flatShading = this.checked; S.renderer.fPos = null; S.renderer.updatePositions(S.solver.positions); });
    $('cpThumb').addEventListener('click', function () { switchMode('design'); });

    // import / export
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () { if (this.files[0]) importFile(this.files[0]); this.value = ''; });
    dropdown('btnExport', 'exportMenu');
    $('exportMenu').addEventListener('click', function (e) { var b = e.target.closest('[data-export]'); if (!b) return; this.hidden = true; doExport(b.dataset.export); });
    $('btnSaveLib').addEventListener('click', saveToMine);
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) { if (hasFiles(e)) { dragDepth++; $('dropMask').classList.add('show'); e.preventDefault(); } });
    window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; $('dropMask').classList.remove('show'); } });
    window.addEventListener('drop', function (e) {
      dragDepth = 0; $('dropMask').classList.remove('show');
      if (!hasFiles(e)) return; e.preventDefault();
      importFile(e.dataTransfer.files[0]);
    });

    // theme & help
    $('btnTheme').addEventListener('click', function () {
      var dark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : '';
      var p = lsGet(LS.prefs, {}); p.dark = dark; lsSet(LS.prefs, p);
      if (S.editor && S.editor.redraw) S.editor.redraw();
      S.renderer.dirty = true;
    });
    $('btnHelp').addEventListener('click', openHelp);
    $('helpModal').addEventListener('click', function (e) { if (e.target === this || e.target.classList.contains('modal-close')) closeHelp(); });

    // design toolbar
    $$('#toolGroup .tbtn').forEach(function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); }); });
    $$('#typeGroup .ltype').forEach(function (b) { b.addEventListener('click', function () { setLineType(b.dataset.type); }); });
    $('lineAngle').addEventListener('change', function () { var v = Math.max(0, Math.min(180, +this.value || 0)); this.value = v; if (S.editor) S.editor.setDefaultAngle(v); });
    $('edUndo').addEventListener('click', function () { if (S.editor) S.editor.undo(); });
    $('edRedo').addEventListener('click', function () { if (S.editor) S.editor.redo(); });
    $('gridSel').addEventListener('change', applyGrid);
    $('snapChk').addEventListener('change', applyGrid);
    dropdown('edMore', 'edMenu');
    $('edMenu').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ed]'); if (!b || !S.editor) return; this.hidden = true;
      var ed = S.editor;
      switch (b.dataset.ed) {
        case 'selectAll': ed.selectAll(); break;
        case 'deleteSelected': ed.deleteSelected(); break;
        case 'flipSelected': ed.flipSelectedMV(); break;
        case 'invertAll': ed.invertAllMV(); break;
        case 'selAngle': { var v = prompt('所选折痕的目标折角（0–180°）', '180'); if (v !== null && isFinite(+v)) ed.setSelectedAngle(Math.max(0, Math.min(180, +v))); break; }
        case 'clear': if (confirm('清空所有折痕？')) ed.clear(); break;
        case 'newSquare': newSheet(1, 1); break;
        case 'newRect': newSheet(1 / Math.SQRT2, 1); break;
        case 'newCustom': {
          var r = prompt('输入纸张宽:高（例如 2:1 或 1.5）', '2:1'); if (!r) break;
          var parts = r.split(/[:：x×]/).map(parseFloat), ratio = parts.length > 1 ? parts[0] / parts[1] : parts[0];
          if (!(ratio > 0.05 && ratio < 20)) { toast('比例无效', true); break; }
          newSheet(ratio >= 1 ? 1 : ratio, ratio >= 1 ? 1 / ratio : 1); break;
        }
      }
    });

    // step mode
    $$('#stepToolGroup .tbtn').forEach(function (b) {
      b.addEventListener('click', function () { $$('#stepToolGroup .tbtn').forEach(function (x) { x.classList.toggle('active', x === b); }); if (S.stepView) S.stepView.setTool(b.dataset.stool); });
    });
    $$('#kindSeg button').forEach(function (b) { b.addEventListener('click', function () { $$('#kindSeg button').forEach(function (x) { x.classList.toggle('active', x === b); }); if (S.stepView) S.stepView.setKind(b.dataset.kind); }); });
    $$('#scopeSeg button').forEach(function (b) { b.addEventListener('click', function () { $$('#scopeSeg button').forEach(function (x) { x.classList.toggle('active', x === b); }); if (S.stepView) S.stepView.setScope(b.dataset.scope); }); });
    $('stUndo').addEventListener('click', function () { if (S.stepView) S.stepView.undo(); });
    $('stRedo').addEventListener('click', function () { if (S.stepView) S.stepView.redo(); });
    $('stFlip').addEventListener('click', function () { if (S.stepView) S.stepView.flip(); });
    $('stRotL').addEventListener('click', function () { if (S.stepView) S.stepView.rotate(-45); });
    $('stRotR').addEventListener('click', function () { if (S.stepView) S.stepView.rotate(45); });
    $('stReset').addEventListener('click', function () { if (S.stepView) { $('stepModelSel').value = ''; S.stepView.reset(1, 1); $('stepModelDesc').textContent = ''; renderStepList(); } });
    $('stTo3D').addEventListener('click', stepTo3D);
    $('st3DAngle').addEventListener('input', function () {
      if (!S.stepView) return;
      S.stepView.setDisplayAngle(+this.value);
      $('st3DAngleOut').textContent = this.value + '°';
    });
    $('stUnfoldAll').addEventListener('click', function () {
      if (!S.stepView) return;
      if (S.stepView.show3d) { S.stepView.set3D(false); this.classList.remove('primary'); $('st3D').classList.remove('primary'); $('st3D').textContent = '3D 展开展示'; }
      if (S.stepView.unfoldAll()) toast('已展开铺平，折痕都留在纸上（用「导出 → 项目文件」可以存成折痕图）');
    });
    $('stUnfoldOne').addEventListener('click', function () {
      if (!S.stepView) return;
      if (S.stepView.unfoldOne()) toast('已打开上一折，折痕保留');
    });
    $('stAngle').addEventListener('change', function () {
      if (!S.stepView) return;
      var deg = S.stepView.setFoldAngle(+this.value);
      toast(deg >= 180 ? '折角 180°：折平（常规折法）' : ('折角 ' + deg + '°：这一折只折到 ' + deg + '°，点「3D 展开展示」看三维姿态'));
    });
    $('st3D').addEventListener('click', function () {
      if (!S.stepView) return;
      var on = S.stepView.set3D(!S.stepView.show3d);
      this.classList.toggle('primary', on);
      this.textContent = on ? '← 回到平面' : '3D 展开展示';
      $('st3DAngleWrap').hidden = !on;
    });
    $('stepModelSel').addEventListener('change', function () {
      var v = S.stepView; if (!v) return;
      stopAuto();
      if (!this.value) { v.reset(1, 1); $('stepModelDesc').textContent = ''; renderStepList(); return; }
      var m = StepModels.get(this.value);
      v.loadModel(m);
      if (m.frontColor) { $('stFront').value = m.frontColor; v.setPaperColors(m.frontColor, $('stBack').value); }
      $('stepModelDesc').textContent = (StepModels.list().filter(function (x) { return x.id === m.id; })[0] || {}).description || '';
      renderStepList();
    });
    $('stPrev').addEventListener('click', function () { stopAuto(); if (S.stepView) S.stepView.prev(); });
    $('stNext').addEventListener('click', function () { stopAuto(); if (S.stepView) S.stepView.next(); });
    $('stAuto').addEventListener('click', function () { if (S.autoTimer) stopAuto(); else startAuto(); });
    $('stSteps').addEventListener('click', function (e) { var li = e.target.closest('li[data-i]'); if (li && S.stepView && S.stepView.gotoStep) { stopAuto(); S.stepView.gotoStep(+li.dataset.i); } });
    $('stFront').addEventListener('input', function () { if (S.stepView) S.stepView.setPaperColors(this.value, $('stBack').value); });
    $('stBack').addEventListener('input', function () { if (S.stepView) S.stepView.setPaperColors($('stFront').value, this.value); });

    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', function () {
      if (S.renderer) { S.renderer.resize(); S.renderer.dirty = true; }
      if (S.editor && S.editor.resize) S.editor.resize();
      if (S.stepView && S.stepView.resize) S.stepView.resize();
      if (S.doc) updateCPPanel();
    });
    window.addEventListener('hashchange', loadFromHash);
    window.addEventListener('beforeunload', saveCurrent);
  }

  function startAuto() {
    var v = S.stepView; if (!v) return;
    var info = v.getInfo ? v.getInfo() : null;
    if (info && info.stepIndex >= info.modelSteps) v.gotoStep(0);
    $('stAuto').textContent = '■ 停止演示';
    S.autoTimer = setInterval(function () {
      var inf = v.getInfo ? v.getInfo() : null;
      if (!inf || inf.stepIndex >= inf.modelSteps) { stopAuto(); toast('演示完成'); return; }
      if (!inf.animating) v.next();
    }, 1600);
    v.next();
  }
  function stopAuto() { if (S.autoTimer) { clearInterval(S.autoTimer); S.autoTimer = 0; } $('stAuto').textContent = '▶ 自动演示'; }

  function newSheet(w, h) {
    loadDoc({ name: '新折痕图', width: w, height: h, lines: [] }, { foldPercent: 0 });
    if (S.editor && S.editor.fit) S.editor.fit();
    toast('已新建 ' + (+w.toFixed(3)) + ' × ' + (+h.toFixed(3)) + ' 纸张');
  }
  function resetSim() { if (!S.solver) return; S.solver.reset(); S.fp = 0; S.settled = 0; S.fitPending = true; S.renderer.updatePositions(S.solver.positions); }
  function setGrab(on) {
    S.grab = on; toggle('togGrab', on);
    S.renderer.grabEnabled = on;
    $('glCanvas').classList.toggle('grab', on);
    toast(on ? '拖拽模式：按住纸面上任意一点拖动（Shift+拖动 仍可旋转视角）' : '已退出拖拽模式');
  }
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }
  function dropdown(btnId, menuId) {
    var btn = $(btnId), menu = $(menuId);
    btn.addEventListener('click', function (e) { e.stopPropagation(); var open = menu.hidden; $$('.menu').forEach(function (m) { m.hidden = true; }); menu.hidden = !open; });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) menu.hidden = true; });
  }
  function openHelp() { $('helpModal').hidden = false; $('helpModal').querySelector('.modal-close').focus(); }
  function closeHelp() { $('helpModal').hidden = true; }

  function onKey(e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    if (!$('helpModal').hidden) { if (e.key === 'Escape') closeHelp(); return; }
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveToMine(); return; }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); return; }
    if (e.key === '?') { openHelp(); return; }
    var active = document.activeElement;
    if (S.mode === 'design' && (active === $('cpCanvas') || $('cpCanvas').matches(':hover'))) return; // editor handles its own keys
    if (S.mode === 'step') {
      if (active === $('stepCanvas') && !mod && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) S.stepView.redo(); else S.stepView.undo(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); stopAuto(); S.stepView && S.stepView.next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stopAuto(); S.stepView && S.stepView.prev(); }
      return;
    }
    if (mod) {
      if (S.mode === 'design' && S.editor && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) S.editor.redo(); else S.editor.undo(); }
      return;
    }
    var r = S.renderer;
    switch (e.key) {
      case ' ': e.preventDefault(); setPlaying(!S.playing); break;
      case 'f': case 'F': r.fit(true); break;
      case 'r': case 'R': resetSim(); break;
      case '0': r.setView('persp'); r.fit(true); break;
      case '1': r.setView('front'); r.fit(true); break;
      case '3': r.setView('right'); r.fit(true); break;
      case '7': r.setView('top'); r.fit(true); break;
      case 'w': case 'W': $('togWire').click(); break;
      case 'h': case 'H': $('togStrain').click(); break;
      case 'c': case 'C': $('togCreases').click(); break;
      case 'g': case 'G': setGrab(!S.grab); break;
      case 'ArrowRight': setTarget(S.target + 0.05, true); break;
      case 'ArrowLeft': setTarget(S.target - 0.05, true); break;
    }
  }

  function loadFromHash() {
    var m = location.hash.match(/#cp=([A-Za-z0-9_\-]+)/);
    if (!m) return false;
    try { loadDoc(decodeShare(m[1]), { foldPercent: 0.7, fromHash: true }); toast('已从分享链接载入折痕图'); return true; }
    catch (e) { toast('分享链接无效', true); return false; }
  }

  // ------------------------------------------------------------------ init
  function init() {
    var prefs = lsGet(LS.prefs, {});
    if (prefs.dark) document.documentElement.dataset.theme = 'dark';
    if (prefs.sim) S.sim = Object.assign({}, DEFAULT_SIM, prefs.sim);
    if (prefs.front) { S.front = prefs.front; S.back = prefs.back || S.back; }
    try {
      S.renderer = new PaperRenderer($('glCanvas'), {
        onDragNode: function (phase, node, p) {
          if (!S.solver) return;
          if (phase === 'end') S.solver.setGrab(null); else S.solver.setGrab(node, p);
          S.settled = 0;
        }
      });
      S.renderer.flatShading = true;
      S.renderer.set({ front: S.front, back: S.back });
    } catch (e) {
      console.error(e);
      $('glError').hidden = false;
      $('glError').innerHTML = '<div><b>无法初始化 WebGL</b><br>' + esc(e.message) + '<br>请使用支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari）。</div>';
    }
    bindUI();
    setColors(S.front, S.back);
    renderSimParams();
    renderCats(); renderLib(); renderMine();
    if (!loadFromHash()) {
      var cur = lsGet(LS.current, null);
      if (cur && cur.doc && cur.doc.lines) {
        try { loadDoc(cur.doc, { presetId: cur.presetId, foldPercent: cur.target !== undefined ? cur.target : 0.8 }); }
        catch (e) { loadPreset('bird-base'); }
      } else loadPreset('bird-base');
    }
    // apply saved collision prefs
    S.collisionPref = prefs.collision !== false;
    $('collisionChk').checked = S.collisionPref;
    if (S.solver && !S.doc.stackedLayers) S.solver.params.collision = S.collisionPref;
    if (prefs.thickness) {
      $('thicknessRange').value = prefs.thickness; $('thicknessOut').textContent = prefs.thickness;
      if (S.solver) S.solver.params.thickness = prefs.thickness / 1000;
    }
    if (prefs.mode && prefs.mode !== 'sim') switchMode(prefs.mode);
    showBuildVer();
    checkForUpdate();
    requestAnimationFrame(frame);
    window.OrigamiStudio = S; // for debugging / tests
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
