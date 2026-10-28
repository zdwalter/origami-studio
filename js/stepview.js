/*
 * stepview.js — Canvas2D view & interaction for step-by-step folding (uses StepFold, OG).
 *   var v = new StepView(canvas, { onChange(info), onStatus(text) })
 * Tools: 'line' (drag a fold line, then click the side to fold), 'p2p' (point onto point), 'e2e' (edge onto edge), 'pan'.
 * Folds animate as a 3D rotation about the fold line with perspective & shading.
 */
(function (global) {
  'use strict';
  var OG = global.OG, SF = global.StepFold;
  var DUR = 700;

  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function hexRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/(.)/g, '$1$1'); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function shade(rgb, k) { return 'rgb(' + rgb.map(function (c) { return Math.round(Math.max(0, Math.min(255, c * k))); }).join(',') + ')'; }

  function StepView(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.onChange = opts.onChange || function () { }; this.onStatus = opts.onStatus || function () { };
    this.tool = 'line'; this.kind = 'valley'; this.scope = 'all';
    this.front = hexRgb('#e8553d'); this.back = hexRgb('#f6f1e7');
    this.view = { s: 300, ox: 0, oy: 0 }; this.viewGoal = null; this.userView = false;
    this.ui = { mode: 'idle' };
    this.anim = null;
    this.noise = this._makeNoise();
    this._bind();
    this.reset(1, 1);
    var self = this;
    (function loop() { self._raf = requestAnimationFrame(loop); self._tick(); })();
  }
  var P = StepView.prototype;

  // ------------------------------------------------------------------ public API
  P.reset = function (w, h) {
    this.model = null;
    this.history = [SF.create({ width: w || 1, height: h || 1 })];
    this.steps = []; this.meta = []; this.pos = 0;
    this.anim = null; this.ui = { mode: 'idle' }; this.userView = false;
    this._fit(true); this._changed();
    this.onStatus(this._hint());
  };
  P.loadModel = function (m) {
    this.reset(m.width, m.height);
    this.model = m;
    var s = this.history[0];
    for (var i = 0; i < m.steps.length; i++) {
      var st = m.steps[i], r = SF.applyOp(s, st.op);
      if (r.error) { console.warn('step', i, r.error); break; }
      this.history.push(r.state);
      this.steps.push({ title: st.title, description: st.description, op: st.op });
      this.meta.push(this._metaFor(st.op, s, r));
      s = r.state;
    }
    this._fit(true); this._changed();
    this.onStatus('教程：' + m.name + ' — 点击“下一步”或按 → 键开始');
  };
  P.getInfo = function () { return { steps: this.steps.slice(), stepIndex: this.pos, modelSteps: this.steps.length, animating: !!this.anim, model: this.model ? this.model.id : null }; };
  P.getSteps = function () { return this.steps.slice(); };
  P.canUndo = function () { return this.pos > 0; };
  P.canRedo = function () { return this.pos < this.history.length - 1; };
  P.next = function () { if (this.anim) this._finishAnim(); if (!this.canRedo()) return; this._animate(this.pos, +1); };
  P.prev = function () { if (this.anim) this._finishAnim(); if (!this.canUndo()) return; this._animate(this.pos - 1, -1); };
  P.redo = P.next; P.undo = P.prev;
  P.gotoStep = function (i) {
    i = Math.max(0, Math.min(this.history.length - 1, i));
    if (this.anim) this._finishAnim();
    if (i === this.pos + 1) return this.next();
    if (i === this.pos - 1) return this.prev();
    this.pos = i; this.ui = { mode: 'idle' }; this._fit(); this._changed();
  };
  P.flip = function () { this._userOp({ type: 'flip' }, '翻面', '把纸翻过来。'); };
  P.rotate = function (deg) { this._userOp({ type: 'rotate', deg: deg }, '旋转 ' + (deg > 0 ? '+' : '') + deg + '°', '在桌面上旋转纸张。'); };
  P.setTool = function (t) { this.tool = t; this.ui = { mode: 'idle' }; this.dirty = true; this.onStatus(this._hint()); this.canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; };
  P.setKind = function (k) { this.kind = k === 'mountain' ? 'mountain' : 'valley'; this._invalidatePreview(); };
  P.setScope = function (s) { this.scope = s; this._invalidatePreview(); };
  P.setPaperColors = function (f, b) { this.front = hexRgb(f); this.back = hexRgb(b); this.dirty = true; };
  P.state = function () { return this.history[this.pos]; };
  P.getCreasePattern = function () { return SF.creasePattern(this.state(), this.model ? this.model.name + ' 折痕' : '分步折叠折痕'); };
  /** 全部步骤折完后的折痕图（保存作品时做缩略图用） */
  P.getFinalCreasePattern = function () {
    var st = this.history.length ? this.history[this.history.length - 1] : this.state();
    return SF.creasePattern(st, this.model ? this.model.name + ' 折痕' : '分步折叠折痕');
  };
  P.exportPNG = function () { this._draw(); return this.canvas.toDataURL('image/png'); };
  P.resize = function () { this._resize(); if (!this.userView) this._fit(true); this.dirty = true; };
  P.destroy = function () { cancelAnimationFrame(this._raf); this._unbind(); };

  // ------------------------------------------------------------------ history helpers
  P._metaFor = function (op, before, r) {
    if (op.type === 'fold') return { type: 'fold', a: op.a, b: op.b, kind: op.kind, moved: r.moved };
    if (op.type === 'flip') { var c = SF.bounds(before).center; return { type: 'flip', a: [c[0], c[1] - 1], b: [c[0], c[1] + 1], kind: 'valley', moved: 'all' }; }
    if (op.type === 'crease') return { type: 'crease', a: op.a, b: op.b, kind: op.kind, moved: r.moved };
    if (op.type === 'unfold') return { type: 'instant' };
    return { type: 'rotate', deg: op.deg, center: SF.bounds(before).center };
  };
  P._userOp = function (op, title, desc) {
    if (this.anim) this._finishAnim();
    var before = this.state(), r = SF.applyOp(before, op);
    if (r.error) { this.onStatus('⚠ ' + r.error); return false; }
    this.history.length = this.pos + 1; this.steps.length = this.pos; this.meta.length = this.pos;
    this.history.push(r.state);
    this.steps.push({ title: title, description: desc, op: op, user: true });
    this.meta.push(this._metaFor(op, before, r));
    this.ui = { mode: 'idle' };
    this._animate(this.pos, +1);
    return true;
  };

  // ------------------------------------------------------------------ animation
  P._animate = function (i, dir) {
    var m = this.meta[i];
    this.anim = { i: i, dir: dir, t0: performance.now(), meta: m, after: this.history[i + 1] };
    this.pos = dir > 0 ? i + 1 : i;
    this._fit();
    this.dirty = true;
  };
  P._finishAnim = function () { this.anim = null; this.dirty = true; this._changed(); };
  P._changed = function () { this._invalidatePreview(); this.dirty = true; this.onChange(this.getInfo()); };

  // ------------------------------------------------------------------ view transform
  P._resize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, 2), c = this.canvas;
    var w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.dpr = dpr; this.W = c.clientWidth; this.H = c.clientHeight;
  };
  P._fit = function (instant) {
    if (this.userView && !instant) return;
    this._resize();
    if (this.W < 2 || this.H < 2) { this.needFit = true; return; } // hidden: fit once visible again
    var st = this.history[this.pos], b = SF.bounds(st), sheet = Math.max(st.width, st.height);
    var size = Math.max(b.width, b.height, sheet * 0.45);
    var s = Math.min(this.W / (size * 1.45), this.H / (size * 1.45));
    s = Math.min(s, Math.min(this.W, this.H) / (sheet * 0.6));
    var goal = { s: s, ox: this.W / 2 - b.center[0] * s, oy: this.H / 2 - b.center[1] * s };
    if (instant || !this.view.s) { this.view = goal; this.viewGoal = null; } else this.viewGoal = goal;
    this.dirty = true;
  };
  P.fit = function () { this.userView = false; this._fit(); };
  P.toScreen = function (p) { return [p[0] * this.view.s + this.view.ox, p[1] * this.view.s + this.view.oy]; };
  P.toWorld = function (x, y) { return [(x - this.view.ox) / this.view.s, (y - this.view.oy) / this.view.s]; };

  // ------------------------------------------------------------------ rendering
  P._makeNoise = function () {
    if (typeof document === 'undefined') return null;
    var c = document.createElement('canvas'); c.width = c.height = 96;
    var x = c.getContext('2d'), img = x.createImageData(96, 96);
    for (var i = 0; i < img.data.length; i += 4) { var v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 14; }
    x.putImageData(img, 0, 0);
    return c;
  };
  P._tick = function () {
    if (this.viewGoal) {
      var v = this.view, g = this.viewGoal, k = 0.2, done = true;
      ['s', 'ox', 'oy'].forEach(function (key) { var d = g[key] - v[key]; if (Math.abs(d) > 0.05) done = false; v[key] += d * k; });
      if (done) { this.view = g; this.viewGoal = null; }
      this.dirty = true;
    }
    if (this.anim) {
      var t = (performance.now() - this.anim.t0) / DUR;
      if (t >= 1) this._finishAnim(); else this.dirty = true;
    }
    if (this.dirty) { this.dirty = false; this._draw(); }
    else if (this.canvas.clientWidth < 2) this.dirty = true;
  };

  P._bgColor = function () {
    var now = performance.now();
    if (!this._bg || now - this._bgT > 1000) {
      var cs = global.getComputedStyle ? getComputedStyle(this.canvas) : null;
      this._bg = (cs && cs.getPropertyValue('--bg').trim()) || '#f3f1ec';
      this._dark = document.documentElement.dataset.theme === 'dark';
      this._bgT = now;
    }
    return this._bg;
  };

  /** Build drawable polys: [{poly(screen), face, showBack, light, z}] in paint order. */
  P._drawables = function () {
    var self = this, a = this.anim;
    var st = a ? a.after : this.state();
    var faces = SF.visibleFaces(st);
    if (!a) return faces.map(function (f) { return { pts: f.poly.map(self.toScreen, self), face: f, back: f.flipped, light: 1, lift: 0 }; });
    var t = ease(Math.min(1, (performance.now() - a.t0) / DUR));
    var m = a.meta;
    if (m.type === 'instant') return faces.map(function (f) { return { pts: f.poly.map(self.toScreen, self), face: f, back: f.flipped, light: 1, lift: 0 }; });
    if (m.type === 'rotate') {
      var ang = -(a.dir > 0 ? 1 - t : t) * m.deg * Math.PI / 180, c = m.center;
      return faces.map(function (f) { return { pts: f.poly.map(function (p) { return self.toScreen(OG.rotate(p, ang, c)); }), face: f, back: f.flipped, light: 1, lift: 0 }; });
    }
    // 折出折痕再展开：折到一半再回到原位
    var theta = m.type === 'crease' ? Math.PI * Math.sin(Math.PI * t) : Math.PI * (a.dir > 0 ? t : 1 - t);
    var movedSet = {};
    if (m.moved === 'all') faces.forEach(function (f) { movedSet[f.id] = 1; }); else m.moved.forEach(function (id) { movedSet[id] = 1; });
    var A = m.a, u = OG.norm(OG.sub(m.b, m.a)), R = SF.affine.reflection(m.a, m.b);
    var zs = m.kind === 'mountain' ? -1 : 1;
    var b = SF.bounds(st), size = Math.max(b.width, b.height, 0.3), focal = size * 3.2;
    var vc = this.toWorld(this.W / 2, this.H / 2);
    var cos = Math.cos(theta), sin = Math.sin(theta);
    function proj(p, z) { var k = focal / (focal - z); return self.toScreen([vc[0] + (p[0] - vc[0]) * k, vc[1] + (p[1] - vc[1]) * k]); }
    var stat = [], mov = [];
    faces.forEach(function (f) {
      if (!movedSet[f.id]) { stat.push({ pts: f.poly.map(self.toScreen, self), face: f, back: f.flipped, light: 1, lift: 0 }); return; }
      var lift = 0;
      var pts = f.poly.map(function (q) {
        var p = SF.affine.apply(R, q); // position before the fold
        var foot = OG.add(A, OG.scale(u, OG.dot(OG.sub(p, A), u))), r = OG.sub(p, foot), d = OG.len(r);
        var z = zs * d * sin;
        lift = Math.max(lift, Math.abs(z));
        return proj(OG.add(foot, OG.scale(r, cos)), z);
      });
      var backBefore = !f.flipped;
      mov.push({ pts: pts, face: f, back: cos < 0 ? !backBefore : backBefore, light: 0.62 + 0.38 * Math.abs(cos), lift: lift });
    });
    mov.sort(function (x, y) { return theta > Math.PI / 2 ? x.face.layer - y.face.layer : y.face.layer - x.face.layer; });
    return m.kind === 'mountain' ? mov.concat(stat) : stat.concat(mov);
  };

  P._draw = function () {
    this._resize();
    if (this.W < 2 || this.H < 2) { this.dirty = true; return; } // not visible
    if (this.needFit) { this.needFit = false; this._fit(true); }
    var ctx = this.ctx, dpr = this.dpr, W = this.W, H = this.H, self = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this._bgColor(); ctx.fillRect(0, 0, W, H);
    // table grid
    ctx.save();
    ctx.strokeStyle = this._dark ? 'rgba(255,255,255,0.04)' : 'rgba(80,60,30,0.06)'; ctx.lineWidth = 1;
    var gs = Math.max(1e-3, this.view.s / 8); while (gs < 14) gs *= 2;
    var gx = ((this.view.ox % gs) + gs) % gs, gy = ((this.view.oy % gs) + gs) % gs;
    ctx.beginPath();
    for (var x = gx; x < W; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (var y = gy; y < H; y += gs) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke(); ctx.restore();

    var st = this.anim ? this.anim.after : this.state();
    var list = this._drawables();
    var creases = st.creases;
    list.forEach(function (d) {
      var rgb = d.back ? self.back : self.front;
      ctx.save();
      ctx.beginPath(); d.pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
      ctx.shadowColor = 'rgba(40,25,10,' + (0.16 + Math.min(0.2, d.lift * 0.4)) + ')';
      ctx.shadowBlur = 6 + d.lift * 40; ctx.shadowOffsetY = 1.5 + d.lift * 25;
      ctx.fillStyle = shade(rgb, d.light * (d.back ? 0.97 : 1));
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.clip();
      // subtle gradient + paper fibre noise
      var b0 = d.pts[0], b1 = d.pts[Math.floor(d.pts.length / 2)];
      var gr = ctx.createLinearGradient(b0[0], b0[1], b1[0], b1[1]);
      gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.06)');
      ctx.fillStyle = gr; ctx.fill();
      if (self.noise) { ctx.fillStyle = ctx.createPattern(self.noise, 'repeat'); ctx.fill(); }
      // creases visible on this facet (only when it is lying flat)
      if (!d.lift && creases.length) {
        ctx.beginPath();
        var T = d.face.T;
        creases.forEach(function (c) { var p = self.toScreen(SF.affine.apply(T, c.a)), q = self.toScreen(SF.affine.apply(T, c.b)); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); });
        ctx.strokeStyle = 'rgba(0,0,0,0.13)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
      ctx.beginPath(); d.pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); }); ctx.closePath();
      ctx.strokeStyle = shade(rgb, 0.55); ctx.globalAlpha = 0.75; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.stroke(); ctx.globalAlpha = 1;
    });
    if (!this.anim) this._drawUI(ctx);
  };

  P._lineStyle = function (ctx, kind) {
    if (kind === 'mountain') { ctx.strokeStyle = '#e5484d'; ctx.setLineDash([10, 4, 2, 4]); }
    else { ctx.strokeStyle = '#3e7bfa'; ctx.setLineDash([9, 6]); }
  };
  P._extended = function (a, b) {
    var st = this.state(), bb = SF.bounds(st), r = Math.max(bb.width, bb.height) * 0.75 + 0.05;
    var u = OG.norm(OG.sub(b, a)), c = bb.center;
    var foot = OG.add(a, OG.scale(u, OG.dot(OG.sub(c, a), u)));
    return [OG.sub(foot, OG.scale(u, r)), OG.add(foot, OG.scale(u, r))];
  };
  P._drawFoldLine = function (ctx, a, b, kind) {
    var e = this._extended(a, b), p = this.toScreen(e[0]), q = this.toScreen(e[1]);
    ctx.save(); ctx.lineWidth = 2; this._lineStyle(ctx, kind);
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); ctx.restore();
  };
  P._drawPreview = function (ctx, res, op) {
    if (!res || res.error) return;
    var self = this, after = res.state, movedSet = {};
    res.moved.forEach(function (id) { movedSet[id] = 1; });
    var R = SF.affine.reflection(op.a, op.b), c0 = [0, 0], c1 = [0, 0], n = 0;
    ctx.save();
    after.facets.forEach(function (f) {
      if (!movedSet[f.id]) return;
      var now = f.poly.map(function (q) { return SF.affine.apply(f.T, q); }), before = now.map(function (p) { return SF.affine.apply(R, p); });
      // highlight the moving flap where it is now
      ctx.beginPath(); before.forEach(function (p, i) { var s = self.toScreen(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath();
      ctx.fillStyle = 'rgba(255,200,60,0.28)'; ctx.fill();
      // ghost where it will land
      ctx.beginPath(); now.forEach(function (p, i) { var s = self.toScreen(p); if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); }); ctx.closePath();
      ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(40,40,40,0.65)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fill();
      var cb = OG.polyCentroid(before), cn = OG.polyCentroid(now), A = Math.abs(OG.polyArea(now));
      c0 = OG.add(c0, OG.scale(cb, A)); c1 = OG.add(c1, OG.scale(cn, A)); n += A;
    });
    if (n > 0) {
      var s0 = this.toScreen(OG.scale(c0, 1 / n)), s1 = this.toScreen(OG.scale(c1, 1 / n));
      var mid = [(s0[0] + s1[0]) / 2, (s0[1] + s1[1]) / 2], dv = [s1[0] - s0[0], s1[1] - s0[1]], L = Math.hypot(dv[0], dv[1]);
      if (L > 12) {
        var nrm = [-dv[1] / L, dv[0] / L], bend = L * 0.25, ctrl = [mid[0] + nrm[0] * bend, mid[1] + nrm[1] * bend];
        ctx.beginPath(); ctx.moveTo(s0[0], s0[1]); ctx.quadraticCurveTo(ctrl[0], ctrl[1], s1[0], s1[1]);
        ctx.strokeStyle = 'rgba(30,30,30,0.75)'; ctx.lineWidth = 2; ctx.stroke();
        var ang = Math.atan2(s1[1] - ctrl[1], s1[0] - ctrl[0]);
        ctx.beginPath(); ctx.moveTo(s1[0], s1[1]);
        ctx.lineTo(s1[0] - 11 * Math.cos(ang - 0.4), s1[1] - 11 * Math.sin(ang - 0.4));
        ctx.lineTo(s1[0] - 11 * Math.cos(ang + 0.4), s1[1] - 11 * Math.sin(ang + 0.4)); ctx.closePath();
        ctx.fillStyle = 'rgba(30,30,30,0.8)'; ctx.fill();
      }
    }
    ctx.restore();
  };
  P._drawUI = function (ctx) {
    var ui = this.ui, self = this;
    // snap points (faint)
    if (this.tool !== 'pan') {
      ctx.save(); ctx.fillStyle = 'rgba(30,30,30,0.28)';
      SF.snapPoints(this.state()).forEach(function (s) { var p = self.toScreen(s.p); ctx.beginPath(); ctx.arc(p[0], p[1], s.kind === 'vertex' ? 2.2 : 1.6, 0, 7); ctx.fill(); });
      ctx.restore();
    }
    if (ui.mode === 'drawing' && ui.a && ui.b && OG.dist(ui.a, ui.b) > 1e-4) {
      this._drawFoldLine(ctx, ui.a, ui.b, this.kind);
      var p = this.toScreen(ui.a), q = this.toScreen(ui.b);
      ctx.save(); ctx.strokeStyle = '#222'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); ctx.restore();
      var ang = Math.atan2(ui.b[1] - ui.a[1], ui.b[0] - ui.a[0]) * 180 / Math.PI;
      this._label(ctx, q, (Math.round(-ang * 10) / 10) + '°');
    }
    if (ui.mode === 'side' || ui.mode === 'p2p2' || ui.mode === 'e2e2') {
      if (ui.line) this._drawFoldLine(ctx, ui.line.a, ui.line.b, this.kind);
      if (ui.preview) this._drawPreview(ctx, ui.preview.res, ui.preview.op);
    }
    if (ui.mode === 'p2p2' && ui.p) { var s = this.toScreen(ui.p); ctx.save(); ctx.fillStyle = '#e8553d'; ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, 7); ctx.fill(); ctx.restore(); }
    if (ui.edge) this._hlEdge(ctx, ui.edge, '#e8553d');
    if (ui.hoverEdge) this._hlEdge(ctx, ui.hoverEdge, 'rgba(232,85,61,0.55)');
    if (ui.snap) {
      var sp = this.toScreen(ui.snap.p);
      ctx.save(); ctx.strokeStyle = ui.snap.kind === 'edge' ? '#2f6fed' : '#e8553d'; ctx.lineWidth = 2;
      ctx.beginPath();
      if (ui.snap.kind === 'midpoint') { ctx.moveTo(sp[0] - 6, sp[1] + 5); ctx.lineTo(sp[0], sp[1] - 6); ctx.lineTo(sp[0] + 6, sp[1] + 5); ctx.closePath(); }
      else if (ui.snap.kind === 'edge') { ctx.moveTo(sp[0] - 6, sp[1] - 6); ctx.lineTo(sp[0] + 6, sp[1] + 6); ctx.moveTo(sp[0] + 6, sp[1] - 6); ctx.lineTo(sp[0] - 6, sp[1] + 6); }
      else ctx.arc(sp[0], sp[1], 6, 0, 7);
      ctx.stroke(); ctx.restore();
    }
  };
  P._hlEdge = function (ctx, e, col) {
    var p = this.toScreen(e[0]), q = this.toScreen(e[1]);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); ctx.restore();
  };
  P._label = function (ctx, p, text) {
    ctx.save(); ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    var w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(30,30,30,0.82)'; ctx.fillRect(p[0] + 10, p[1] - 24, w, 18);
    ctx.fillStyle = '#fff'; ctx.fillText(text, p[0] + 15, p[1] - 11); ctx.restore();
  };

  // ------------------------------------------------------------------ interaction
  P._hint = function () {
    return {
      line: '折线：在纸上拖出一条折线（Shift 约束 22.5°），然后点击要翻折的一侧；Esc 取消',
      p2p: '点到点：先点击要移动的点，再点击目标点',
      e2e: '边到边：先点击要移动的边，再点击目标边',
      pan: '平移：拖动画布；滚轮缩放，双击复位视图'
    }[this.tool] || '';
  };
  P._snap = function (w, free) {
    var tol = 12 / this.view.s, best = null, bd = tol;
    SF.snapPoints(this.state()).forEach(function (s) { var d = OG.dist(s.p, w); if (d < bd) { bd = d; best = { p: s.p.slice(), kind: s.kind }; } });
    if (best) return best;
    if (free) return { p: w, kind: 'free' };
    var be = null; bd = tol * 0.8;
    SF.outlineEdges(this.state()).forEach(function (e) { var d = OG.pointSegDist(w, e[0], e[1]); if (d < bd) { bd = d; be = e; } });
    if (be) return { p: OG.lerp(be[0], be[1], OG.projectT(w, be[0], be[1])), kind: 'edge' };
    return { p: w, kind: 'free' };
  };
  P._nearestEdge = function (w) {
    var tol = 14 / this.view.s, best = null, bd = tol;
    SF.outlineEdges(this.state()).forEach(function (e) { if (OG.dist(e[0], e[1]) < 1e-6) return; var d = OG.pointSegDist(w, e[0], e[1]); if (d < bd) { bd = d; best = e; } });
    return best;
  };
  P._invalidatePreview = function () { if (this.ui) { this.ui.previewKey = null; if (this.ui.lastW) this._updatePreview(this.ui.lastW); } this.dirty = true; };
  P._makeOp = function (line, side) { return { type: 'fold', a: line.a, b: line.b, side: side, kind: this.kind, scope: this.scope }; };
  P._updatePreview = function (w) {
    var ui = this.ui, line = null, side = null;
    ui.lastW = w;
    if (ui.mode === 'side') { line = ui.line; side = w; }
    else if (ui.mode === 'p2p2') { var q = this._snap(w).p; ui.snap = this._snap(w); if (OG.dist(q, ui.p) < 1e-5) { ui.preview = null; ui.line = null; return; } line = SF.pointToPoint(ui.p, q); ui.line = line; side = ui.p; }
    else if (ui.mode === 'e2e2') {
      var e = this._nearestEdge(w); ui.hoverEdge = e;
      if (!e || e === ui.edge) { ui.preview = null; ui.line = null; return; }
      line = SF.edgeToEdge(ui.edge, e); ui.line = line; side = this._edgeSide(ui.edge, line);
    }
    if (!line || !side || Math.abs(OG.orient(line.a, line.b, side)) < 1e-9) { ui.preview = null; return; }
    var key = [line.a, line.b, Math.sign(OG.orient(line.a, line.b, side)), this.kind, this.scope, this.scope === 'all' ? '' : side.map(function (x) { return x.toFixed(3); })].join('|');
    if (ui.previewKey === key) return;
    ui.previewKey = key;
    var op = this._makeOp(line, side);
    ui.preview = { op: op, res: SF.fold(this.state(), op) };
  };
  P._edgeSide = function (e, line) {
    var m = OG.lerp(e[0], e[1], 0.5);
    if (Math.abs(OG.orient(line.a, line.b, m)) > 1e-7) return m;
    return OG.dist(e[0], line.a) > OG.dist(e[1], line.a) ? e[0] : e[1];
  };
  P._commit = function () {
    var pv = this.ui.preview;
    if (!pv) return;
    if (pv.res.error) { this.onStatus('⚠ ' + pv.res.error); return; }
    var n = this.steps.filter(function (s) { return s.user; }).length + 1;
    var kindName = this.kind === 'valley' ? '谷折' : '山折';
    var ok = this._userOp(pv.op, kindName + '（第 ' + n + ' 次自定义）', (this.scope === 'all' ? '折叠所有层' : this.scope === 'topSheet' ? '自动选中点击处最上层所在的整叠翻片' : this.scope === 'top' ? '只折叠最上层' : '只折叠最下层') + '，折痕长 ' + OG.dist(pv.op.a, pv.op.b).toFixed(3));
    if (ok) this.onStatus(this._hint());
  };

  P._bind = function () {
    var self = this, c = this.canvas, drag = null;
    c.style.touchAction = 'none'; c.style.cursor = 'crosshair';
    function pos(e) { var r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    this._h = {
      down: function (e) {
        c.focus && c.focus();
        var sp = pos(e), w = self.toWorld(sp[0], sp[1]);
        if (self.anim) return;
        c.setPointerCapture && c.setPointerCapture(e.pointerId);
        if (e.button === 1 || e.button === 2 || self.tool === 'pan' || self._space) { drag = { mode: 'pan', sx: sp[0], sy: sp[1], ox: self.view.ox, oy: self.view.oy }; c.style.cursor = 'grabbing'; return; }
        drag = { mode: 'tool', sx: sp[0], sy: sp[1], w: w, moved: false };
        if (self.tool === 'line' && self.ui.mode !== 'side') { var s0 = self._snap(w); self.ui = { mode: 'drawing', a: s0.p, b: s0.p, snap: s0 }; }
        self.dirty = true;
      },
      move: function (e) {
        var sp = pos(e), w = self.toWorld(sp[0], sp[1]);
        if (drag && drag.mode === 'pan') { self.view.ox = drag.ox + sp[0] - drag.sx; self.view.oy = drag.oy + sp[1] - drag.sy; self.userView = true; self.viewGoal = null; self.dirty = true; return; }
        if (self.anim) return;
        var ui = self.ui;
        if (drag && drag.mode === 'tool' && Math.hypot(sp[0] - drag.sx, sp[1] - drag.sy) > 5) drag.moved = true;
        if (self.tool === 'line') {
          if (ui.mode === 'side' && drag && drag.moved) { var s1 = self._snap(drag.w); self.ui = ui = { mode: 'drawing', a: s1.p, b: s1.p }; }
          if (ui.mode === 'drawing' && drag) {
            var sn = self._snap(w);
            var b = sn.p;
            if (e.shiftKey) {
              var d = OG.sub(w, ui.a), L = OG.len(d), ang = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 8)) * (Math.PI / 8);
              b = OG.add(ui.a, [Math.cos(ang) * L, Math.sin(ang) * L]); sn = null;
            }
            ui.b = b; ui.snap = sn; self.dirty = true; return;
          }
          if (ui.mode === 'side') { self._updatePreview(w); self.dirty = true; return; }
          ui.snap = self._snap(w); self.dirty = true; return;
        }
        if (self.tool === 'p2p') {
          if (ui.mode === 'p2p2') self._updatePreview(w); else ui.snap = self._snap(w);
          self.dirty = true; return;
        }
        if (self.tool === 'e2e') {
          if (ui.mode === 'e2e2') self._updatePreview(w); else ui.hoverEdge = self._nearestEdge(w);
          self.dirty = true;
        }
      },
      up: function (e) {
        var sp = pos(e), w = self.toWorld(sp[0], sp[1]), d = drag; drag = null;
        if (d && d.mode === 'pan') { c.style.cursor = self.tool === 'pan' ? 'grab' : 'crosshair'; return; }
        if (!d || self.anim) return;
        var ui = self.ui;
        if (self.tool === 'line') {
          if (ui.mode === 'drawing') {
            if (OG.dist(ui.a, ui.b) * self.view.s > 8) {
              self.ui = { mode: 'side', line: { a: ui.a, b: ui.b } };
              self.onStatus('点击折线的一侧，那一侧的纸将被' + (self.kind === 'valley' ? '向前（谷折）' : '向后（山折）') + '翻折；拖动可重画折线，Esc 取消');
              self._updatePreview(w);
            } else self.ui = { mode: 'idle' };
          } else if (ui.mode === 'side' && !d.moved) { self._updatePreview(w); self._commit(); }
        } else if (self.tool === 'p2p' && !d.moved) {
          if (ui.mode !== 'p2p2') { self.ui = { mode: 'p2p2', p: self._snap(w).p }; self.onStatus('现在点击目标点：第一个点将被折到这里'); }
          else { self._updatePreview(w); self._commit(); }
        } else if (self.tool === 'e2e' && !d.moved) {
          if (ui.mode !== 'e2e2') { var ed = self._nearestEdge(w); if (ed) { self.ui = { mode: 'e2e2', edge: ed }; self.onStatus('现在点击目标边：第一条边将被折到它上面'); } }
          else { self._updatePreview(w); self._commit(); }
        }
        self.dirty = true;
      },
      wheel: function (e) {
        e.preventDefault();
        var sp = pos(e), k = Math.exp(-e.deltaY * 0.0015), v = self.view;
        var s = Math.max(20, Math.min(20000, v.s * k)); k = s / v.s;
        v.ox = sp[0] - (sp[0] - v.ox) * k; v.oy = sp[1] - (sp[1] - v.oy) * k; v.s = s;
        self.userView = true; self.viewGoal = null; self.dirty = true;
      },
      dbl: function () { self.userView = false; self._fit(); },
      key: function (e) {
        if (e.key === 'Escape') { self.ui = { mode: 'idle' }; self.dirty = true; self.onStatus(self._hint()); }
        if (e.key === ' ') { self._space = true; e.preventDefault(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) self.redo(); else self.undo(); }
      },
      keyup: function (e) { if (e.key === ' ') self._space = false; },
      ctx: function (e) { e.preventDefault(); if (self.ui.mode !== 'idle') { self.ui = { mode: 'idle' }; self.dirty = true; self.onStatus(self._hint()); } },
      leave: function () { if (self.ui) { self.ui.snap = null; self.ui.hoverEdge = null; self.dirty = true; } }
    };
    c.addEventListener('pointerdown', this._h.down);
    c.addEventListener('pointermove', this._h.move);
    c.addEventListener('pointerup', this._h.up);
    c.addEventListener('pointercancel', this._h.up);
    c.addEventListener('pointerleave', this._h.leave);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    c.addEventListener('dblclick', this._h.dbl);
    c.addEventListener('keydown', this._h.key);
    c.addEventListener('keyup', this._h.keyup);
    c.addEventListener('contextmenu', this._h.ctx);
  };
  P._unbind = function () {
    var c = this.canvas, h = this._h;
    c.removeEventListener('pointerdown', h.down); c.removeEventListener('pointermove', h.move); c.removeEventListener('pointerup', h.up);
    c.removeEventListener('pointercancel', h.up); c.removeEventListener('pointerleave', h.leave); c.removeEventListener('wheel', h.wheel);
    c.removeEventListener('dblclick', h.dbl); c.removeEventListener('keydown', h.key); c.removeEventListener('keyup', h.keyup); c.removeEventListener('contextmenu', h.ctx);
  };

  global.StepView = StepView;
})(typeof window !== 'undefined' ? window : globalThis);
