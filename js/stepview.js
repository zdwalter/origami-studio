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
    this.tool = 'line'; this.kind = 'valley'; this.scope = 'all'; this.creaseOnly = false;
    this.front = hexRgb('#e8553d'); this.back = hexRgb('#f6f1e7');
    this.view = { s: 300, ox: 0, oy: 0 }; this.viewGoal = null; this.userView = false;
    this.ui = { mode: 'idle' };
    this.anim = null;
    this.show3d = false;                       // 3D 展开展示
    this.angleOverride = null;                 // 手动指定折角（3D 展示时）
    this.foldAngle = 180;                      // 手动折叠使用的折角
    this.showStages = true;                    // 折痕上是否标注步骤号
    this.rot3d = { yaw: -0.72, pitch: 0.46 };   // 3D 展示的视角
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
  /**
   * 改某一步的「谷折 / 山折」，然后从头自动重折一遍。
   * 谷折 → 山折 会让这一折的纸翻到另一侧（层序反过来），也就是“把一层塞到后面”。
   */
  P.setStepKind = function (i, kind) {
    var step = this.steps[i];
    if (!step || !step.op) return null;
    var t = step.op.type;
    if (t !== 'fold' && t !== 'crease') return null;
    if (!kind) kind = step.op.kind === 'mountain' ? 'valley' : 'mountain';
    if (step.op.kind === kind) return kind;
    if (this.anim) this._finishAnim();
    var w = this.history[0].width, h = this.history[0].height;
    var steps = this.steps.map(function (x, k) {
      return { title: x.title, description: x.description, user: x.user,
               op: k === i ? Object.assign({}, x.op, { kind: kind }) : x.op };
    });
    // 从头重放：改动只影响这一折及其之后的层序
    var hist = [SF.create({ width: w, height: h })], metas = [], st = hist[0];
    for (var k = 0; k < steps.length; k++) {
      var r = SF.applyOp(st, steps[k].op);
      if (r.error) { this.onStatus('⚠ 第 ' + (k + 1) + ' 步折不出来：' + r.error); return null; }
      hist.push(r.state); metas.push(this._metaFor(steps[k].op, st, r)); st = r.state;
    }
    var keepPos = Math.min(this.pos, hist.length - 1);
    this.steps = steps; this.history = hist; this.meta = metas;
    this.pos = keepPos;
    this.creases = [];
    this._changed();
    this.onStatus('第 ' + (i + 1) + ' 步已改成' + (kind === 'mountain' ? '山折' : '谷折') + '，并自动重折了一遍');
    return kind;
  };

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
  /**
   * 点击处：打开该处最上面那一层所在的折——效果是回到“折这一层之前”的样子。
   * 引擎会把那一折从历史里去掉后按纸面坐标重放，所以后面的折、折痕都不受影响。
   */
  /** 「点折痕折一步」：点到哪条折痕，就按**那条折痕自己的山/谷**沿它折一步（Shift 反向折） */
  P.foldAlongCreaseAt = function (world, invert) {
    var seg = this._nearestCrease(world, null);
    if (!seg) { this.onStatus('⚠ 点在纸上的折痕附近（会高亮），再点一次'); this.dirty = true; return false; }
    var line = { a: seg.a.slice(), b: seg.b.slice() };
    var side = world;
    if (Math.abs(OG.orient(line.a, line.b, side)) < 1e-9) {
      // 正好点在折痕上：两侧各取一个小偏移，折“纸面积小”的那一侧（通常就是想折的那片角）
      var stt = this.state();
      var eps = 0.03 * Math.max(stt.width, stt.height);
      var dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1], L = Math.hypot(dx, dy) || 1;
      var nx = -dy / L, ny = dx / L;
      var best = null;
      [[1], [-1]].forEach(function (sgn) {
        var q = [world[0] + nx * eps * sgn[0], world[1] + ny * eps * sgn[0]];
        if (!SF.facetAt(stt, q)) return;
        // 这一侧的纸面积
        var area = 0;
        stt.facets.forEach(function (f) {
          var P = f.poly.map(function (q2) { return SF.affine.apply(f.T, q2); });
          var c = OG.polyCentroid(P);
          if (OG.orient(line.a, line.b, c) * sgn[0] <= 0) return;
          area += Math.abs(OG.polyArea(P));
        });
        if (!best || area < best.area) best = { q: q, area: area };
      });
      if (!best) { this.onStatus('⚠ 折痕这一侧没有纸'); this.dirty = true; return false; }
      side = best.q;
    }
    if (Math.abs(OG.orient(line.a, line.b, side)) < 1e-9) { this.onStatus('⚠ 点在折痕的一侧再试'); this.dirty = true; return false; }
    // 山/谷按折痕本身来（折痕图里设的是谷就谷折、是山就山折）；没有类型时退回工具栏选择
    var kind = seg.type === 'M' ? 'mountain' : (seg.type === 'V' ? 'valley' : this.kind);
    if (invert) kind = kind === 'mountain' ? 'valley' : 'mountain';
    var op = { type: 'fold', a: line.a, b: line.b, side: side, kind: kind, scope: this.scope };
    if (this.foldAngle && this.foldAngle < 180) op.angle = this.foldAngle;
    var n = this.steps.filter(function (x) { return x.user; }).length + 1;
    var ok = this._userOp(op, (kind === 'mountain' ? '山折' : '谷折') + '（沿折痕，第 ' + n + ' 次自定义）',
      '沿纸上已有的折痕折一步' + (invert ? '（Shift 反向）' : ''));
    if (ok) this.onStatus('这条折痕是' + (kind === 'mountain' ? '山折' : '谷折') + '，已按它折了一步' + (invert ? '（Shift 反向）' : ''));
    return ok;
  };

  P.unfoldLayerAt = function (world) {
    var st0 = this.state();
    var facet = SF.facetAt(st0, world);
    if (!facet) { this.onStatus('这里没有纸'); return false; }
    var paperPt = SF.affine.apply(SF.affine.invert(facet.T), world);
    // 该处从最上层往下数第几层
    var layerFromTop = 1;
    st0.facets.forEach(function (f) {
      if (f === facet || f.layer <= facet.layer) return;
      var P = f.poly.map(function (q) { return SF.affine.apply(f.T, q); });
      if (OG.pointInPoly(world, P)) layerFromTop++;
    });
    var probe = SF.unfoldLayer(st0, paperPt, 1);
    if (probe.error) { this.onStatus('⚠ ' + probe.error); return false; }
    var n = this.steps.filter(function (x) { return x.user; }).length + 1;
    // 折叠序号 → 步骤号（教程里“第 8 步”这种）
    var stepNo = 0, ord = 0;
    this.steps.forEach(function (st2, i) {
      var t = st2.op && st2.op.type;
      if (t === 'fold' || t === 'crease') ord++;
      if (ord === probe.foldNo) stepNo = i + 1;
    });
    var where = stepNo ? ('第 ' + stepNo + ' 步') : ('第 ' + probe.foldNo + ' 折');
    this.onStatus('打开了' + where + '折的那一折，回到折之前的样子（折痕保留）');
    return this._userOp({ type: 'unfoldLayer', point: paperPt, nth: 1 },
      '打开第 ' + layerFromTop + ' 层（' + where + '）（第 ' + n + ' 次自定义）',
      '打开' + where + '折的那一折，回到折之前的样子；折痕保留');
  };

  P.setTool = function (t) { this.tool = t; this.ui = { mode: 'idle' }; this.dirty = true; this.onStatus(this._hint()); this.canvas.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; };
  P.setKind = function (k) { this.kind = k === 'mountain' ? 'mountain' : 'valley'; this._invalidatePreview(); };
  P.setScope = function (s) { this.scope = s; this._invalidatePreview(); };
  P.setPaperColors = function (f, b) { this.front = hexRgb(f); this.back = hexRgb(b); this.dirty = true; };
  /** 展开复原：纸回到整张平面，折痕全部留下（记成一步，可撤销） */
  P.unfoldAll = function () {
    var st = this.state();
    if (!st.creases || !st.creases.length) { this.onStatus('还没有折过，展开后不会留下折痕'); return false; }
    return this._userOp({ type: 'unfoldAll' }, '展开复原', '把纸重新打开铺平，保留折痕（共 ' + st.creases.length + ' 条）');
  };
  /** 打开上一折（几何复原一步，折痕保留） */
  P.unfoldOne = function () {
    var st = this.state();
    // 按「折」的历史判断（翻面/旋转之后也能打开上次的折）
    var hasFold = (st.ops || []).some(function (o) { return o.type === 'fold'; }) || (st.snaps && st.snaps.length);
    if (!hasFold) { this.onStatus('还没有可以打开的折了'); return false; }
    return this._userOp({ type: 'unfold' }, '打开上一折（留折痕）', '把最近折的那一下打开，折痕留在纸上');
  };

  /** 手动指定展开角度（null = 用模型自带的角度） */
  /**
   * 修改某一步的折角（0..180，180 = 折平）。几何不变（平面引擎始终折平），
   * 只影响：这一步折痕记录的 foldAngle、3D 展开展示、以及发送到 3D 的折叠树。
   * 修改后重放所有步骤，保证折痕元数据与状态一致。
   */
  /**
   * 修改某一步的折角（0..180，180 = 折平）。
   * 只改这一步：写 op.angle + 把这一步自己折出来的那些折痕的 foldAngle 改掉。
   * 不复算、不重放——后续步骤的状态、折痕、编号、历史全部原样保留。
   */
  P.setStepAngle = function (i, deg) {
    var st = this.steps[i];
    if (!st || !st.op || st.op.type !== 'fold') return false;
    deg = Math.max(0, Math.min(180, Math.round(deg)));
    if (deg >= 180) delete st.op.angle; else st.op.angle = deg;

    // 这一步是第几次折叠（fold 与 crease 都会记折痕，折叠序号一致）
    var ordinal = 0;
    for (var q = 0; q <= i; q++) {
      var t = this.steps[q] && this.steps[q].op && this.steps[q].op.type;
      if (t === 'fold' || t === 'crease') ordinal++;
    }
    // 只改「这一步折出来的」折痕，后续步骤的折痕不动
    this.history.forEach(function (state) {
      if (!state || !state.creases) return;
      state.creases.forEach(function (c) { if (c.stage === ordinal) c.foldAngle = deg; });
    });
    if (this.anim) this._finishAnim();
    this.dirty = true;
    this._changed();
    return true;
  };

  /** 用当前 steps 重新重放（慎用：会重建全部历史状态；改折角不要用这个） */
  P._replay = function () {
    if (this.anim) this._finishAnim();
    var w = this.history[0].width, h = this.history[0].height;
    var s = SF.create({ width: w, height: h });
    var history = [s], meta = [];
    for (var i = 0; i < this.steps.length; i++) {
      var before = s, r = SF.applyOp(s, this.steps[i].op);
      if (r.error) { this.onStatus('⚠ 步骤 ' + (i + 1) + '：' + r.error); break; }
      history.push(r.state); meta.push(this._metaFor(this.steps[i].op, before, r));
      s = r.state;
    }
    var keep = Math.min(this.pos, history.length - 1);
    this.history = history; this.meta = meta; this.pos = keep;
    this.steps.length = history.length - 1;
    this._fit(); this._changed();
    return this;
  };

  P.setShowStages = function (on) { this.showStages = !!on; this.dirty = true; return this.showStages; };

  P.setDisplayAngle = function (deg) { this.angleOverride = (deg === null || deg === undefined) ? null : +deg; this.dirty = true; };

  /** 这个作品能不能展开展示（有折角信息） */
  P.hasOpenMode = function () { return !!(this.model && (this.model.displayOpen || this.model.displayAngles)); };

  P.canShow3D = function () {
    var m = this.model, self2 = this;
    if (!m || !this.steps.length) return false;
    if (m.displayAngles) return true;
    return this.steps.some(function (s2) { return s2.op && (s2.op.angle !== undefined || s2.op.foldAngle !== undefined); });
  };

  /** 切换到「3D 展开展示」：把折好的成品按折角打开成三维姿态 */
  P.set3D = function (on) {
    this.show3d = !!on;
    this.ui = { mode: 'idle' };
    this.dirty = true;
    this.onStatus(this.show3d ? '3D 展示：拖动可以转动视角，再点一次「3D 展示」回到平面' : this._hint());
    return this.show3d;
  };

  /** 3D 展示：按 displayAngles 把折痕打开、投影绘制 */
  P._draw3D = function (ctx) {
    var self = this, W = this.W, H = this.H;
    var m = this.model || { width: 1, height: 1 };
    // 每一步的折角：模型 displayAngles < 这一折操作自带的 angle < 180°；手动覆盖优先
    var self0 = this, angles = {};
    this.steps.forEach(function (s2, i) {
      var base = (m.displayAngles && m.displayAngles[i] !== undefined) ? m.displayAngles[i]
        : (s2.op && (s2.op.angle !== undefined ? s2.op.angle : s2.op.foldAngle) !== undefined
          ? (s2.op.angle !== undefined ? s2.op.angle : s2.op.foldAngle) : 180);
      if (base < 180 && self0.angleOverride != null) base = self0.angleOverride;
      angles[i] = base;
    });
    var openOpt = null;
    if (m.displayOpen) {
      var o = { step: m.displayOpen.step, angle: m.displayOpen.angle === undefined ? 90 : m.displayOpen.angle };
      if (self0.angleOverride != null) o.angle = self0.angleOverride;
      openOpt = o;
      angles = {};   // 对称对开时，其余折痕都折平
      this.steps.forEach(function (s3, i3) { angles[i3] = (m.displayAngles && m.displayAngles[i3] !== undefined) ? m.displayAngles[i3] : 180; });
    }
    var pose = SF.threeDPose(this.steps.map(function (s2) { return { op: s2.op }; }), {
      width: m.width || 1, height: m.height || 1, angles: angles, openByLine: openOpt || undefined
    });
    var mn = pose.min, mx = pose.max;
    var size = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1e-3);
    var s = Math.min(W, H) / (size * 1.5);
    var cx = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    var yaw = this.rot3d.yaw, pitch = this.rot3d.pitch;
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    function project(p) {
      var x = p[0] - cx[0], y = p[1] - cx[1], z = p[2] - cx[2];
      var x1 = cy * x - sy * y, y1 = sy * x + cy * y;
      var y2 = cp * y1 - sp * z, z2 = sp * y1 + cp * z;
      return [W / 2 + x1 * s, H / 2 + y2 * s, z2];
    }
    var items = [];
    var LIGHT = (function () { var l = [0.35, -0.45, 0.82], n = Math.sqrt(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]); return [l[0] / n, l[1] / n, l[2] / n]; })();
    pose.polys.forEach(function (poly) {
      if (poly.pts.length < 3) return;
      var pr = poly.pts.map(project);
      var zs = 0;
      pr.forEach(function (q) { zs += q[2]; });
      zs /= pr.length;
      var ax = pr[1][0] - pr[0][0], ay = pr[1][1] - pr[0][1], bx = pr[2][0] - pr[0][0], by = pr[2][1] - pr[0][1];
      var cross = ax * by - ay * bx;
      // 用三维法向做朗伯光照，让立起来的机翼看得出厚度方向
      var A = poly.pts[0], B = poly.pts[1], C = poly.pts[2];
      var u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      var n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      var nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
      n = [n[0] / nl, n[1] / nl, n[2] / nl];
      // 把法向旋到相机空间
      var n1x = cy * n[0] - sy * n[1], n1y = sy * n[0] + cy * n[1], n1z = n[2];
      var n2y = cp * n1y - sp * n1z, n2z = sp * n1y + cp * n1z;
      var lam = Math.abs(n1x * LIGHT[0] + n2y * LIGHT[1] + n2z * LIGHT[2]);
      items.push({ pr: pr, z: zs, front: cross < 0, lit: 0.72 + 0.42 * lam });
    });
    items.sort(function (a, b) { return a.z - b.z; });
    items.forEach(function (d) {
      var rgb = d.front ? self.front : self.back;
      var lit = d.lit;
      ctx.beginPath();
      d.pr.forEach(function (q, i) { if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
      ctx.closePath();
      ctx.fillStyle = shade(rgb, lit);
      ctx.fill();
      ctx.strokeStyle = shade(rgb, 0.62); ctx.globalAlpha = 0.8; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.stroke(); ctx.globalAlpha = 1;
    });
    // 提示文字
    ctx.save();
    ctx.fillStyle = this._dark ? 'rgba(255,255,255,.55)' : 'rgba(70,55,35,.55)';
    ctx.font = '13px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('3D 展示：拖动旋转', 14, H - 16);
    ctx.restore();
  };
  P.state = function () { return this.history[this.pos]; };
  /** 折痕图：每条折痕带上“是第几步折出来的”（1 基，按步骤号而不是按折叠次数） */
  P.getCreasePattern = function () {
    var cp = SF.creasePattern(this.state(), this.model ? this.model.name + ' 折痕' : '分步折叠折痕');
    var stepOf = this._creaseStepMap();
    cp.lines.forEach(function (l) {
      if (l.type === 'B') return;
      var k = (Math.min(l.a[0], l.b[0]).toFixed(6) + ',' + Math.min(l.a[1], l.b[1]).toFixed(6) + ',' +
               Math.max(l.a[0], l.b[0]).toFixed(6) + ',' + Math.max(l.a[1], l.b[1]).toFixed(6) + ',' + l.type);
      if (stepOf[k]) l.stage = stepOf[k];
    });
    return cp;
  };
  /** 重放一遍步骤，记录每条折痕是哪一步产生的：key → 步号(1 基) */
  P._creaseStepMap = function () {
    var out = {};
    var st = SF.create({ width: this.history[0].width, height: this.history[0].height });
    var before = {};
    function keyOf(c) {
      var A = c.a, B = c.b;
      return (Math.min(A[0], B[0]).toFixed(6) + ',' + Math.min(A[1], B[1]).toFixed(6) + ',' +
              Math.max(A[0], B[0]).toFixed(6) + ',' + Math.max(A[1], B[1]).toFixed(6) + ',' + c.type);
    }
    this.steps.forEach(function (step, i) {
      var r = SF.applyOp(st, step.op);
      if (r.error) return;
      st = r.state;
      st.creases.forEach(function (c) {
        var k = keyOf(c);
        if (before[k] === undefined) { before[k] = i + 1; out[k] = i + 1; }
      });
    });
    return out;
  };
  /** 全部步骤折完后的折痕图（保存作品时做缩略图用） */
  P.getFinalCreasePattern = function () {
    var st = this.history.length ? this.history[this.history.length - 1] : this.state();
    return SF.creasePattern(st, this.model ? this.model.name + ' 折痕' : '分步折叠折痕');
  };
  /**
   * 插入一个“基本型”：清空当前纸，按基本型的步骤折好，之后可以在它上面继续折。
   * 已有步骤时先问一下（会覆盖），因为基本型必须从整张纸开始。
   */
  P.insertBase = function (base) {
    if (!base) return false;
    var stepList = base.steps || (base.state && base.state.steps) || [];
    if (!stepList.length) return false;
    if (this.steps.length) {
      var n = this.steps.length;
      if (!window.confirm('当前已有 ' + n + ' 步。插入基本型会清空这些步骤，从整张纸重新折。要继续吗？')) return false;
    }
    if (this.anim) this._finishAnim();
    // 用当前选中的纸张：正方形纸直接放；长方形的纸（A4）只在“上方最大的一块正方形”里折基本型，
    // 剩下的那截纸留着当平纸条（和图纸上“三角 + 下方纸条”的样子一致）。
    var cur = this.state();
    var bw = base.width || 1, bh = base.height || 1;
    var w = cur.width || bw, h = cur.height || bh;
    var side = Math.min(w, h);            // 正方形区域边长
    var sx = side / bw, sy = side / bh;   // 等比缩放（基本型必须放在正方形里）
    var at = function (p) { return [p[0] * sx, p[1] * sy]; };
    var strip = null;                     // 剩下的那截纸（长方形时才有）
    if (h > side + 1e-9) strip = [[0, side], [side, side], [side, h], [0, h]];
    else if (w > side + 1e-9) strip = [[side, 0], [w, 0], [w, h], [side, h]];
    this.reset(w, h);
    // 有 state 的（真正的收拢结果）直接放进去，算作一步
    if (base.state && base.state.facets && base.state.facets.length) {
      var st0 = SF.clone(this.history[0]);
      st0.facets = base.state.facets.map(function (f, i) {
        var m = f.T.m;
        return {
          id: i,
          poly: f.poly.map(function (q) { return at(q); }),
          // 世界坐标也跟着纸张比例拉伸：m' = S·m·S⁻¹，t' = S·t
          T: { m: [m[0], m[1] * sy / sx, m[2] * sx / sy, m[3]], t: [f.T.t[0] * sx, f.T.t[1] * sy] },
          layer: f.layer
        };
      });
      st0.nextId = st0.facets.length + 1;
      st0.creases = (base.state.creases || []).map(function (c) {
        return { a: at(c.a), b: at(c.b), type: c.type, angle: c.angle == null ? 180 : c.angle };
      });
      if (strip) {
        st0.facets.push({ id: st0.facets.length, poly: strip.map(function (q) { return q.slice(); }),
                          T: { m: [1, 0, 0, 1], t: [0, 0] }, layer: 0 });
        st0.nextId = st0.facets.length + 1;
      }
      if (SF.compactLayers) SF.compactLayers(st0);
      this.history.push(st0);
      this.steps.push({ title: (base.state.steps && base.state.steps[0] && base.state.steps[0].title) || base.name,
                        description: (base.state.steps && base.state.steps[0] && base.state.steps[0].description) || base.description,
                        op: { type: 'base' }, user: true });
      this.meta.push({ type: 'instant' });
      this.pos = this.history.length - 1;
      this._fit(true);
      this._changed();
      this.onStatus('已插入「' + base.name + '」：4 层、中间一条脊，可以接着往下折');
      return true;
    }
    var s = this.history[0];
    for (var i = 0; i < stepList.length; i++) {
      var st = stepList[i];
      var op = st.op;
      if (sx !== 1 || sy !== 1) {
        op = JSON.parse(JSON.stringify(st.op));
        if (op.a) op.a = at(op.a);
        if (op.b) op.b = at(op.b);
        if (op.side) op.side = at(op.side);
      }
      var r = SF.applyOp(s, op);
      if (r.error) { this.onStatus('⚠ 基本型第 ' + (i + 1) + ' 步折不出来：' + r.error); return false; }
      this.history.push(r.state);
      this.steps.push({ title: st.title, description: st.description, op: op, user: true });
      this.meta.push(this._metaFor(op, s, r));
      s = r.state;
    }
    this.pos = this.history.length - 1;
    if (strip) {
      var sp = SF.clone(this.history[this.pos]);
      sp.facets.push({ id: sp.facets.length, poly: strip.map(function (q) { return q.slice(); }), T: { m: [1, 0, 0, 1], t: [0, 0] }, layer: 0 });
      sp.nextId = sp.facets.length + 1;
      if (SF.compactLayers) SF.compactLayers(sp);
      this.history[this.pos] = sp;
    }
    this._fit(true);
    this._changed();
    this.onStatus('已插入「' + base.name + '」：共 ' + stepList.length + ' 步，可以接着往下折');
    return true;
  };

  /** 把一张折痕图作为“参考折痕”载入当前状态：只画在纸上（角度 0），方便一条条点着折 */
  P.setGuideCreases = function (doc) {
    if (!doc || !doc.lines || !doc.lines.length) return 0;
    var st = SF.clone(this.state());
    var seen = {};
    function key(c) {
      var A = c.a, B = c.b;
      return [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])]
        .map(function (x) { return (+x).toFixed(6); }).join(',');
    }
    st.creases.forEach(function (c) { seen[key(c)] = 1; });
    var added = 0;
    doc.lines.forEach(function (l) {
      if (l.type === 'B') return;
      var c = { a: [l.a[0], l.a[1]], b: [l.b[0], l.b[1]], type: (l.type === 'M' ? 'M' : 'V'), angle: 0,
                stage: l.stage, foldAngle: l.foldAngle };
      if (seen[key(c)]) return;
      seen[key(c)] = 1; st.creases.push(c); added++;
    });
    this.history[this.pos] = st;
    this._invalidatePreview && this._invalidatePreview();
    this.dirty = true;
    this.onStatus('已载入 ' + added + ' 条参考折痕：用「点折痕折一步」一条条点着折');
    return added;
  };

  P.exportPNG = function () { this._draw(); return this.canvas.toDataURL('image/png'); };
  P.resize = function () { this._resize(); if (!this.userView) this._fit(true); this.dirty = true; };
  P.destroy = function () { cancelAnimationFrame(this._raf); this._unbind(); };

  // ------------------------------------------------------------------ history helpers
  P._metaFor = function (op, before, r) {
    if (op.type === 'fold') return { type: 'fold', a: op.a, b: op.b, kind: op.kind, moved: r.moved };
    if (op.type === 'flip') { var c = SF.bounds(before).center; return { type: 'flip', a: [c[0], c[1] - 1], b: [c[0], c[1] + 1], kind: 'valley', moved: 'all' }; }
    if (op.type === 'crease') return { type: 'crease', a: op.a, b: op.b, kind: op.kind, moved: r.moved };
    if (op.type === 'unfold' || op.type === 'unfoldAll' || op.type === 'unfoldLayer' || op.type === 'peelLayer') return { type: 'instant' };
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
    if (m.type === 'rotate' && m.deg && m.center) {
      var ang = -(a.dir > 0 ? 1 - t : t) * m.deg * Math.PI / 180, c = m.center;
      return faces.map(function (f) { return { pts: f.poly.map(function (p) { return self.toScreen(OG.rotate(p, ang, c)); }), face: f, back: f.flipped, light: 1, lift: 0 }; });
    }
    // 折出折痕再展开：折到一半再回到原位
    // flip 也用折页动画演（整张纸绕竖直轴翻过去，翻到一半能看到侧边）
    if (m.type !== 'fold' && m.type !== 'crease' && m.type !== 'flip') {
      return faces.map(function (f) { return { pts: f.poly.map(self.toScreen, self), face: f, back: f.flipped, light: 1, lift: 0 }; });
    }
    var theta = m.type === 'crease' ? Math.PI * Math.sin(Math.PI * t) : Math.PI * (a.dir > 0 ? t : 1 - t);
    if (!isFinite(theta)) theta = 0;
    var movedSet = {};
    if (m.moved === 'all') faces.forEach(function (f) { movedSet[f.id] = 1; }); else m.moved.forEach(function (id) { movedSet[id] = 1; });
    var A = m.a, u = OG.norm(OG.sub(m.b, m.a)), R = SF.affine.reflection(m.a, m.b);
    var zs = m.kind === 'mountain' ? -1 : 1;
    var b = SF.bounds(st), size = Math.max(b.width, b.height, 0.3), focal = size * 3.2;
    var vc = this.toWorld(this.W / 2, this.H / 2);
    var cos = Math.cos(theta), sin = Math.sin(theta);
    function proj(p, z) {
      // 掀开远处的层时 z 可能接近焦点距离，这里夹一下，避免除零产生 NaN
      var k = focal / Math.max(focal * 0.08, focal - z);
      return self.toScreen([vc[0] + (p[0] - vc[0]) * k, vc[1] + (p[1] - vc[1]) * k]);
    }
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

    if (this.show3d) { this._draw3D(ctx); return; }
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
        var labelPts = [];
        creases.forEach(function (c) {
          var p = self.toScreen(SF.affine.apply(T, c.a)), q = self.toScreen(SF.affine.apply(T, c.b));
          ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
          labelPts.push({ p: p, q: q, stage: c.stage, foldAngle: c.foldAngle, type: c.type });
        });
        ctx.strokeStyle = 'rgba(0,0,0,0.30)'; ctx.lineWidth = 1.2; ctx.stroke();
        // 折痕上标注「第几步折出来的」（有 stage 时才标）
        if (self.showStages !== false && labelPts.some(function (L) { return L.stage > 0; })) {
          ctx.save();
          ctx.font = '600 10px system-ui, -apple-system, "PingFang SC", sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          labelPts.forEach(function (L) {
            if (!(L.stage > 0)) return;
            var mx = (L.p[0] + L.q[0]) / 2, my = (L.p[1] + L.q[1]) / 2;
            if (mx < 6 || my < 6 || mx > self.W - 6 || my > self.H - 6) return;
            var txt = String(L.stage);
            var w2 = ctx.measureText(txt).width + 6;
            ctx.fillStyle = 'rgba(255,255,255,0.82)';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(mx - w2 / 2, my - 7, w2, 14, 7); else ctx.rect(mx - w2 / 2, my - 7, w2, 14);
            ctx.fill();
            ctx.fillStyle = L.foldAngle !== undefined && L.foldAngle < 180 ? '#c2410c' : 'rgba(60,50,40,0.85)';
            ctx.fillText(txt, mx, my);
          });
          ctx.restore();
        }
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
    if (ui.mode === 'side' || ui.mode === 'p2p2' || ui.mode === 'e2e2' || ui.mode === 'pt2axis') {
      if (ui.line) this._drawFoldLine(ctx, ui.line.a, ui.line.b, this.kind);
      if (ui.preview) this._drawPreview(ctx, ui.preview.res, ui.preview.op);
    }
    if (ui.mode === 'p2p2' && ui.p && ui.ortho) {
      var sp1 = this.toScreen(ui.p);
      ctx.save(); ctx.strokeStyle = 'rgba(232,85,61,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      var L = 4000;
      if (ui.ortho === 'h') { ctx.beginPath(); ctx.moveTo(0, sp1[1]); ctx.lineTo(L, sp1[1]); }
      else if (ui.ortho === 'v') { ctx.beginPath(); ctx.moveTo(sp1[0], 0); ctx.lineTo(sp1[0], L); }
      else { ctx.beginPath(); ctx.moveTo(sp1[0] - L, sp1[1] - L); ctx.lineTo(sp1[0] + L, sp1[1] + L);
             ctx.moveTo(sp1[0] - L, sp1[1] + L); ctx.lineTo(sp1[0] + L, sp1[1] - L); }
      ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
    if (ui.mode === 'p2p2' && ui.p) { var s = this.toScreen(ui.p); ctx.save(); ctx.fillStyle = '#e8553d'; ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, 7); ctx.fill(); ctx.restore(); }
    if (ui.edge) this._hlEdge(ctx, ui.edge, '#e8553d');
    if (ui.hoverEdge) this._hlEdge(ctx, ui.hoverEdge, 'rgba(232,85,61,0.55)');
    if (ui.mode === 'pt2axis' && ui.p) {
      var sp0 = this.toScreen(ui.p);
      ctx.save(); ctx.fillStyle = '#e8553d'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sp0[0], sp0[1], 6, 0, 7); ctx.fill(); ctx.stroke(); ctx.restore();
      if (ui.land && ui.preview && !ui.preview.res.error) {
        var sl = this.toScreen(ui.land);
        ctx.save(); ctx.strokeStyle = '#e8553d'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(sp0[0], sp0[1]); ctx.lineTo(sl[0], sl[1]); ctx.stroke();
        ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sl[0], sl[1], 5, 0, 7); ctx.stroke(); ctx.restore();
      }
    }
    if (ui.hoverCrease) {
      var hc0 = this.toScreen(ui.hoverCrease.a), hc1 = this.toScreen(ui.hoverCrease.b);
      ctx.save();
      ctx.strokeStyle = ui.hoverCrease.type === 'M' ? 'rgba(214,60,80,0.9)' : 'rgba(47,111,237,0.9)';   // 山=红、谷=蓝
      ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(hc0[0], hc0[1]); ctx.lineTo(hc1[0], hc1[1]); ctx.stroke(); ctx.restore();
    }
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
      p2p: '点到点：先点击要移动的点，再点击目标点（靠近水平/垂直/45° 会自动对齐）',
      e2e: '边到边：先点击要移动的边（纸边或压痕），再点击目标边',
      foldcrease: '点折痕折一步：鼠标靠近折痕会高亮，点一下按这条折痕自己的山/谷折（Shift 反向折）；点在哪一侧，那一侧就翻过去',
      linefold: '点到对称线：先点要折的那一层上的一个点，再点作为对称轴的折痕或纸边，这一层就沿它翻过去',
      pan: '平移：拖动画布；滚轮缩放，双击复位视图'
    }[this.tool] || '';
  };
  /** 当前平面里所有可当对称轴的线段：每片纸的边 + 压平的折痕（都换算到平面坐标） */
  P._axisSegments = function () {
    var st = this.state(), out = [];
    function add(A, B, type) {
      if (OG.dist(A, B) < 1e-6) return;
      for (var i = 0; i < out.length; i++) {
        var o = out[i];
        if ((OG.dist(o.a, A) < 1e-7 && OG.dist(o.b, B) < 1e-7) || (OG.dist(o.a, B) < 1e-7 && OG.dist(o.b, A) < 1e-7)) return;
      }
      out.push({ a: A, b: B, type: type });
    }
    st.facets.forEach(function (f) {
      var P = f.poly.map(function (q) { return SF.affine.apply(f.T, q); });
      for (var i = 0; i < P.length; i++) add(P[i], P[(i + 1) % P.length], 'edge');
      // 压平的折痕：纸面线段裁到这片纸里，再映射到平面
      st.creases.forEach(function (c) {
        var seg = clipSegConvex(c.a, c.b, f.poly);
        if (seg) add(SF.affine.apply(f.T, seg[0]), SF.affine.apply(f.T, seg[1]), c.type);
      });
    });
    return out;
  };
  function clipSegConvex(A, B, poly) {       // Cyrus–Beck，poly 为凸多边形
    var t0 = 0, t1 = 1, d = [B[0] - A[0], B[1] - A[1]];
    var area = 0;
    for (var k = 0; k < poly.length; k++) { var p = poly[k], q = poly[(k + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
    var sgn = area > 0 ? 1 : -1;
    for (var i = 0; i < poly.length; i++) {
      var P0 = poly[i], P1 = poly[(i + 1) % poly.length];
      var n = [-(P1[1] - P0[1]) * sgn, (P1[0] - P0[0]) * sgn];     // 内法向
      var num = n[0] * (A[0] - P0[0]) + n[1] * (A[1] - P0[1]);
      var den = n[0] * d[0] + n[1] * d[1];
      if (Math.abs(den) < 1e-14) { if (num < -1e-12) return null; continue; }
      var t = -num / den;
      if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1 + 1e-12) return null;
    }
    if (t1 - t0 < 1e-9) return null;
    return [[A[0] + d[0] * t0, A[1] + d[1] * t0], [A[0] + d[0] * t1, A[1] + d[1] * t1]];
  }
  /** 离鼠标最近的对称轴线段（屏幕上 10 像素以内） */
  P._nearestCrease = function (w, exceptPoint) {
    var tol = 10 / this.view.s, best = null, bd = tol;
    this._axisSegments().forEach(function (sg) {
      if (exceptPoint && Math.abs(OG.orient(sg.a, sg.b, exceptPoint)) / OG.dist(sg.a, sg.b) < 1e-6) return;   // 点在这条线上就不能当轴
      var d = OG.pointSegDist(w, sg.a, sg.b);
      if (d < bd) { bd = d; best = { a: sg.a.slice(), b: sg.b.slice(), type: sg.type, dist: d }; }
    });
    return best;
  };
  P._snap = function (w, free) {
    var tol = 12 / this.view.s, best = null, bd = tol;
    SF.snapPoints(this.state()).forEach(function (s) { var d = OG.dist(s.p, w); if (d < bd) { bd = d; best = { p: s.p.slice(), kind: s.kind }; } });
    if (best) return best;
    if (free) return { p: w, kind: 'free' };
    // 点在边上也算吸附：纸边与压痕都吸（点到点、画线都用这套）
    var be = null; bd = tol * 1.35;      // 线吸附的判定范围略大于顶点，贴线时更容易吸上
    this._axisSegments().forEach(function (sg) {
      if (OG.dist(sg.a, sg.b) < 1e-9) return;
      var d = OG.pointSegDist(w, sg.a, sg.b);
      if (d < bd) { bd = d; be = [sg.a, sg.b]; }
    });
    if (be) return { p: OG.lerp(be[0], be[1], OG.projectT(w, be[0], be[1])), kind: 'edge' };
    return { p: w, kind: 'free' };
  };
  /** 点到点：第二个点靠近第一个点的水平/垂直/45° 方向时自动对齐（返回 {p, axis}） */
  P._orthoSnap = function (p, q, axes) {
    if (!p || !q) return { p: q, axis: null, shift: 0 };
    var tol = 10 / this.view.s;
    var dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy);
    if (d < 1e-9) return { p: q, axis: null };
    var dirs = [
      { v: [1, 0], axis: 'h' }, { v: [0, 1], axis: 'v' },
      { v: [Math.SQRT1_2, Math.SQRT1_2], axis: 'd' }, { v: [Math.SQRT1_2, -Math.SQRT1_2], axis: 'd' }
    ];
    var best = null, bd = tol;
    dirs.forEach(function (dd) {
      if (axes && axes.indexOf(dd.axis) < 0) return;
      // 沿这个方向的垂距（考虑正反两个朝向）
      var u = [dd.v[0], dd.v[1]];
      var t = dx * u[0] + dy * u[1];
      var perp = Math.abs(dx * -u[1] + dy * u[0]);
      // 反方向也要考虑（例如向下垂直线）
      var perp2 = Math.abs(dx * u[1] - dy * u[0]);
      if (t >= 0 && perp < bd) { bd = perp; best = { u: u, t: t, axis: dd.axis }; }
      if (t < 0 && perp2 < bd) { bd = perp2; best = { u: [-u[0], -u[1]], t: -t, axis: dd.axis }; }
    });
    if (!best) return { p: q, axis: null, shift: 0 };
    var np = [p[0] + best.u[0] * best.t, p[1] + best.u[1] * best.t];
    return { p: np, axis: best.axis, shift: Math.hypot(np[0] - q[0], np[1] - q[1]) };
  };
  /** 最近的“边”：纸边或压痕（压痕也能当边用） */
  P._nearestEdge = function (w) {
    var tol = 14 / this.view.s, best = null, bd = tol;
    this._axisSegments().forEach(function (sg) {
      if (OG.dist(sg.a, sg.b) < 1e-6) return;
      var d = OG.pointSegDist(w, sg.a, sg.b);
      if (d < bd) { bd = d; best = [sg.a.slice(), sg.b.slice()]; }
    });
    return best;
  };
  P._invalidatePreview = function () { if (this.ui) { this.ui.previewKey = null; if (this.ui.lastW) this._updatePreview(this.ui.lastW); } this.dirty = true; };
  P._makeOp = function (line, side) {
    var scope = this.scope;
    if (this.tool === 'linefold' && scope === 'all') scope = 'topSheet';
    var op = { type: this.creaseOnly ? 'crease' : 'fold', a: line.a, b: line.b, side: side, kind: this.kind, scope: scope };
    if (this.foldAngle && this.foldAngle < 180) op.angle = this.foldAngle;   // 折角（默认 180° 折平）
    return op;
  };
  /** 设置手动折叠的折角（180 = 折平） */
  /** 「压痕」模式：画出折线后只压出折痕（折一下再展开），纸保持平面 */
  P.setCreaseOnly = function (on) { this.creaseOnly = !!on; this.ui = { mode: 'idle' }; this.dirty = true; this.onStatus(this._hint()); return this.creaseOnly; };
  P.setFoldAngle = function (deg) { this.foldAngle = Math.max(0, Math.min(180, +deg || 180)); return this.foldAngle; };
  P._updatePreview = function (w) {
    var ui = this.ui, line = null, side = null;
    ui.lastW = w;
    if (ui.mode === 'side') { line = ui.line; side = w; }
    else if (ui.mode === 'p2p2') {
      var snp = this._snap(w), q = snp.p;
      ui.snap = snp;
      ui.ortho = null;
      if (snp.kind === 'free') {
        // 自由点：自动对齐水平/垂直/45°
        var ort = this._orthoSnap(ui.p, q);
        if (ort.axis) { q = ort.p; ui.ortho = ort.axis; }
      } else {
        // 吸到顶点/边：如果只微调一点点就能让折痕变成水平/垂直，就微调（顶点几乎不动）
        var ort2 = this._orthoSnap(ui.p, q, ['h', 'v']);
        var maxShift = 12 / this.view.s;
        if (ort2.axis && ort2.shift <= maxShift) { q = ort2.p; ui.ortho = ort2.axis; }
      }
      if (OG.dist(q, ui.p) < 1e-5) { ui.preview = null; ui.line = null; return; }
      line = SF.pointToPoint(ui.p, q); ui.line = line; side = ui.p;
    }
    else if (ui.mode === 'pt2axis') {
      var seg = this._nearestCrease(w, ui.p);
      ui.hoverCrease = seg;
      if (!seg) { ui.preview = null; ui.line = null; ui.land = null; return; }
      line = { a: seg.a, b: seg.b }; ui.line = line; side = ui.p;
      ui.land = SF.affine.apply(SF.affine.reflection(line.a, line.b), ui.p);   // 这个点折过去落在哪
    }
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
    ui.preview = { op: op, res: (op.type === 'crease' ? SF.crease(this.state(), op) : SF.fold(this.state(), op)) };
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
    var ifCrease = pv.op.type === 'crease';
    var ok = this._userOp(pv.op,
      (ifCrease ? '压痕（' + kindName + '）' : kindName) + '（第 ' + n + ' 次自定义）',
      (ifCrease ? '先折一下再展开，只留下折痕' : (this.scope === 'all' ? '折叠所有层' : this.scope === 'topSheet' ? '自动选中点击处最上层所在的整叠翻片' : this.scope === 'top' ? '只折叠最上层' : '只折叠最下层')) + '，折痕长 ' + OG.dist(pv.op.a, pv.op.b).toFixed(3));
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
        if (self.show3d) { drag = { mode: 'orbit', sx: sp[0], sy: sp[1], yaw: self.rot3d.yaw, pitch: self.rot3d.pitch }; c.style.cursor = 'grabbing'; return; }
        if (e.button === 1 || e.button === 2 || self.tool === 'pan' || self._space) { drag = { mode: 'pan', sx: sp[0], sy: sp[1], ox: self.view.ox, oy: self.view.oy }; c.style.cursor = 'grabbing'; return; }
        drag = { mode: 'tool', sx: sp[0], sy: sp[1], w: w, moved: false };
        if (self.tool === 'peel') { self.unfoldLayerAt(w); self.dirty = true; return; }
        if (self.tool === 'foldcrease') { self.foldAlongCreaseAt(w, e.shiftKey); self.dirty = true; return; }
        if (self.tool === 'linefold') { self.dirty = true; return; }
        if (self.tool === 'line' && self.ui.mode !== 'side') { var s0 = self._snap(w); self.ui = { mode: 'drawing', a: s0.p, b: s0.p, snap: s0 }; }
        self.dirty = true;
      },
      move: function (e) {
        var sp = pos(e), w = self.toWorld(sp[0], sp[1]);
        self._lastW = w;
        if (drag && drag.mode === 'orbit') {
          self.rot3d.yaw = drag.yaw + (sp[0] - drag.sx) * 0.01;
          self.rot3d.pitch = Math.max(-1.45, Math.min(1.45, drag.pitch + (sp[1] - drag.sy) * 0.008));
          self.dirty = true; return;
        }
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
        if (self.tool === 'linefold') {
          if (ui.mode === 'pt2axis') self._updatePreview(w);
          else ui.hoverCrease = null;
          self.dirty = true;
          return;
        }
        if (self.tool === 'foldcrease') { ui.hoverCrease = self._nearestCrease(w, null); self.dirty = true; return; }
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
        if (self.show3d) { drag = null; c.style.cursor = 'grab'; self.dirty = true; return; }
        var sp = pos(e), w = self.toWorld(sp[0], sp[1]), d = drag; drag = null;
        if (d && d.mode === 'pan') { c.style.cursor = self.tool === 'pan' ? 'grab' : 'crosshair'; return; }
        if (!d || self.anim) return;
        var ui = self.ui;
        if (self.tool === 'linefold') {
          if (ui.mode === 'pt2axis') {
            self._updatePreview(w);
            if (self.ui.preview && !self.ui.preview.res.error) {
              self._commit();
              self.ui = { mode: 'idle' };
              self.onStatus('已沿对称线折好；再点一个点开始下一折');
            } else if (!self.ui.hoverCrease) {
              // 没点在线上：把这一下当成重新选点
              if (SF.facetAt(self.state(), w)) { self.ui = { mode: 'pt2axis', p: w }; self.onStatus('已重新选点。现在点作为对称轴的那条线（折痕或纸边）'); }
            } else if (self.ui.preview && self.ui.preview.res.error) {
              self.onStatus('⚠ ' + self.ui.preview.res.error);
            }
          } else {
            if (!SF.facetAt(self.state(), w)) { self.onStatus('请点在纸上：选要折的那一层上的一个点'); }
            else { self.ui = { mode: 'pt2axis', p: w }; self.onStatus('现在点作为对称轴的那条线（折痕或纸边），点到的那一层会沿它翻过去；Esc 取消'); }
          }
          self.dirty = true;
          return;
        }
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
