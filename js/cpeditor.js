/*
 * cpeditor.js — 2D crease-pattern (折痕图) editor on a <canvas>.
 * Exposes global CPEditor. Depends on OG (geom.js); uses CP (cp.js) when available.
 *
 *   var ed = new CPEditor(canvas, { onChange, onSelectionChange, onStatus, onToolChange, onLineTypeChange,
 *                                   onHistoryChange, autoValidate });
 *
 * Paper coordinates: y DOWN, sheet [0,w]x[0,h] (see SPEC.md). All drawing is done in CSS pixels with a
 * devicePixelRatio transform so lines stay crisp on HiDPI screens.
 */
(function (global) {
  'use strict';
  var OG = global.OG;

  var COLORS = { B: '#1f2328', M: '#e5484d', V: '#3e7bfa', F: '#b6b6b6', U: '#e0a526', C: '#2fb36d' };
  var NAMES = { B: '边界', M: '山折', V: '谷折', F: '平面线', U: '未指定', C: '剪切' };
  var TYPES = ['M', 'V', 'F', 'U', 'C', 'B'];
  var STYLE = {
    M: { w: 2, dash: [10, 3, 2, 3] },   // dash-dot (mountain)
    V: { w: 2, dash: [7, 4] },          // dashed (valley)
    F: { w: 1, dash: [] },
    U: { w: 1.6, dash: [] },
    C: { w: 2.2, dash: [] },
    B: { w: 2.6, dash: [] }
  };
  var DRAW_ORDER = ['F', 'U', 'C', 'V', 'M', 'B'];
  var TOOLS = ['line', 'select', 'erase', 'type', 'bisector', 'perp', 'pbisect', 'mirror', 'ray', 'pan'];
  var TOOL_NAMES = {
    line: '画线', select: '选择', erase: '擦除', type: '改类型', bisector: '角平分线', perp: '垂线',
    pbisect: '中垂线', mirror: '镜像', ray: '延长至边界', pan: '平移'
  };
  var SNAP_NAMES = { vertex: '顶点', midpoint: '中点', grid: '网格点', intersection: '交点', online: '线上', angle: '22.5°', free: '' };
  var PRIORITY = { vertex: 0, intersection: 1, midpoint: 2, grid: 3, online: 4 };
  var ACCENT = '#f06d1f';
  var FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  var SQ3 = Math.sqrt(3);

  function noop() {}
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isMV(t) { return t === 'M' || t === 'V'; }
  function fmtNum(n, d) { var s = n.toFixed(d === undefined ? 4 : d); return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s; }
  function gcd(a, b) { while (b) { var t = b; b = a % b; a = t; } return a; }
  function frac(i, n) { if (i === 0) return '0'; if (i === n) return '1'; var g = gcd(i, n); return (i / g) + '/' + (n / g); }

  // Liang–Barsky clip of segment to [0,w]x[0,h]
  function clipRect(a, b, w, h, x0, y0) {
    x0 = x0 || 0; y0 = y0 || 0;
    var t0 = 0, t1 = 1, dx = b[0] - a[0], dy = b[1] - a[1];
    var p = [-dx, dx, -dy, dy], q = [a[0] - x0, x0 + w - a[0], a[1] - y0, y0 + h - a[1]];
    for (var i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-15) { if (q[i] < -1e-12) return null; continue; }
      var r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
  }
  function reflect(p, a, b) {
    var d = OG.norm(OG.sub(b, a)), v = OG.sub(p, a), t = OG.dot(v, d);
    var f = [a[0] + d[0] * t, a[1] + d[1] * t];
    return [2 * f[0] - p[0], 2 * f[1] - p[1]];
  }
  function foot(p, a, b) {
    var d = OG.sub(b, a), l2 = OG.dot(d, d);
    if (l2 < 1e-30) return [a[0], a[1]];
    var t = OG.dot(OG.sub(p, a), d) / l2;
    return [a[0] + d[0] * t, a[1] + d[1] * t];
  }
  // intersection of infinite line (o + t d) with segment [a,b]: returns {t,u,p} or null
  function raySeg(o, d, a, b) {
    var s = OG.sub(b, a), rs = OG.cross(d, s);
    if (Math.abs(rs) < 1e-12 * (OG.len(d) * OG.len(s) + 1e-30)) return null;
    var qp = OG.sub(a, o), t = OG.cross(qp, s) / rs, u = OG.cross(qp, d) / rs;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    return { t: t, u: u, p: [o[0] + d[0] * t, o[1] + d[1] * t] };
  }
  function sameSide(a, b, w, h, tol) {
    return (Math.abs(a[0]) < tol && Math.abs(b[0]) < tol) || (Math.abs(a[1]) < tol && Math.abs(b[1]) < tol) ||
      (Math.abs(a[0] - w) < tol && Math.abs(b[0] - w) < tol) || (Math.abs(a[1] - h) < tol && Math.abs(b[1] - h) < tol);
  }

  /* ---------- minimal internal planarizer (used only when CP.normalize is unavailable) ---------- */
  function fallbackNormalize(lines, w, h) {
    var tol = 1e-7 * Math.max(w, h), segs = [];
    var cs = [[0, 0], [w, 0], [w, h], [0, h]];
    for (var c = 0; c < 4; c++) segs.push({ a: cs[c], b: cs[(c + 1) % 4], type: 'B', angle: 0 });
    (lines || []).forEach(function (l) {
      if (!l || !l.a || !l.b) return;
      var cl = clipRect([+l.a[0], +l.a[1]], [+l.b[0], +l.b[1]], w, h);
      if (!cl || OG.dist(cl[0], cl[1]) < tol * 10) return;
      var type = TYPES.indexOf(l.type) >= 0 ? l.type : 'U';
      if (sameSide(cl[0], cl[1], w, h, tol)) type = 'B'; else if (type === 'B') type = 'F';
      var ang = isMV(type) ? (l.angle === undefined || l.angle === null ? 180 : Math.min(180, Math.abs(+l.angle))) : 0;
      segs.push({ a: cl[0], b: cl[1], type: type, angle: ang });
    });
    var n = segs.length, params = segs.map(function () { return [0, 1]; });
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var A = segs[i], B = segs[j], r = OG.sub(A.b, A.a), s = OG.sub(B.b, B.a), La = OG.len(r), Lb = OG.len(s);
      var rs = OG.cross(r, s);
      if (Math.abs(rs) / (La * Lb) > 1e-9) {
        var qp = OG.sub(B.a, A.a), t = OG.cross(qp, s) / rs, u = OG.cross(qp, r) / rs, et = tol / La, eu = tol / Lb;
        if (t > -et && t < 1 + et && u > -eu && u < 1 + eu) { params[i].push(OG.clamp(t, 0, 1)); params[j].push(OG.clamp(u, 0, 1)); }
      } else if (Math.abs(OG.cross(r, OG.sub(B.a, A.a))) / La < tol) {
        [B.a, B.b].forEach(function (p) { var tt = OG.dot(OG.sub(p, A.a), r) / (La * La); if (tt > 0 && tt < 1) params[i].push(tt); });
        [A.a, A.b].forEach(function (p) { var uu = OG.dot(OG.sub(p, B.a), s) / (Lb * Lb); if (uu > 0 && uu < 1) params[j].push(uu); });
      }
    }
    var verts = [];
    function vid(p) {
      for (var k = 0; k < verts.length; k++) if (OG.dist(verts[k], p) <= tol * 2) return k;
      var q = [p[0], p[1]];
      if (Math.abs(q[0]) < tol) q[0] = 0; if (Math.abs(q[0] - w) < tol) q[0] = w;
      if (Math.abs(q[1]) < tol) q[1] = 0; if (Math.abs(q[1] - h) < tol) q[1] = h;
      verts.push(q); return verts.length - 1;
    }
    var map = {}, order = 0;
    for (i = 0; i < n; i++) {
      var ps = params[i].sort(function (x, y) { return x - y; }), S = segs[i], prev = null;
      for (var k = 0; k < ps.length; k++) {
        var id = vid(OG.lerp(S.a, S.b, ps[k]));
        if (prev !== null && prev !== id) {
          var key = prev < id ? prev + '_' + id : id + '_' + prev, old = map[key];
          if (!old || old.type !== 'B') map[key] = { v: [prev, id], type: S.type, angle: S.angle, o: order++ };
        }
        prev = id;
      }
    }
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (x, y) { return x.o - y.o; })
      .map(function (e) { return { a: verts[e.v[0]].slice(), b: verts[e.v[1]].slice(), type: e.type, angle: e.angle }; });
  }

  // Merge collinear same-type segments that meet at a degree-2 vertex (left over after erasing a crossing crease).
  function mergeCollinear(lines, scale) {
    var q = 1e-6 * scale;
    function key(p) { return Math.round(p[0] / q) + ',' + Math.round(p[1] / q); }
    var L = lines.slice(), adj = {};
    L.forEach(function (l, i) {
      [l.a, l.b].forEach(function (p) { var k = key(p); (adj[k] = adj[k] || []).push(i); });
    });
    var changed = true, guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      for (var k in adj) {
        var list = adj[k];
        if (!list || list.length !== 2 || list[0] === list[1]) continue;
        var i = list[0], j = list[1], li = L[i], lj = L[j];
        if (!li || !lj || li.type !== lj.type || (li.angle || 0) !== (lj.angle || 0)) continue;
        // 带“第几步”信息的折痕（从分步折叠送进来的）不合并：合并会丢掉步骤对应关系
        if (li.stage !== undefined && lj.stage !== undefined && li.stage !== lj.stage) continue;
        var atA = key(li.a) === k, P = atA ? li.a : li.b, fi = atA ? li.b : li.a, fj = key(lj.a) === k ? lj.b : lj.a;
        var d1 = OG.norm(OG.sub(fi, P)), d2 = OG.norm(OG.sub(fj, P));
        if (Math.abs(OG.cross(d1, d2)) > 1e-9 || OG.dot(d1, d2) > -0.5) continue;
        var m = { a: fi, b: fj, type: li.type };
        if (li.angle !== undefined) m.angle = li.angle;
        if (li.stage !== undefined) m.stage = li.stage;
        if (li.foldAngle !== undefined) m.foldAngle = li.foldAngle;
        L[i] = m; L[j] = null;
        delete adj[k];
        var kj = key(fj);
        adj[kj] = (adj[kj] || []).map(function (x) { return x === j ? i : x; });
        changed = true;
      }
    }
    return L.filter(Boolean);
  }

  /* ======================================================================================= */
  function CPEditor(canvas, opts) {
    if (!(this instanceof CPEditor)) return new CPEditor(canvas, opts);
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.onChange = opts.onChange || noop;
    this.onSelectionChange = opts.onSelectionChange || noop;
    this.onStatus = opts.onStatus || noop;
    this.onToolChange = opts.onToolChange || noop;
    this.onLineTypeChange = opts.onLineTypeChange || noop;
    this.onHistoryChange = opts.onHistoryChange || noop;
    this.autoValidate = !!opts.autoValidate;
    this.historyLimit = opts.historyLimit || 200;

    this.doc = { name: '未命名', description: '', width: 1, height: 1, lines: [] };
    this.tool = 'line';
    this.lineType = 'M';
    this.defaultAngle = 180;
    this.grid = { divisions: 8, type: 'square' };
    this.snapOpts = { grid: true, vertex: true, midpoint: true, intersection: true, onLine: true, angle22_5: true };
    this.showLabels = false;
    this.showAngles = true;
    this.sel = {};
    this.past = []; this.future = [];
    this.validation = null;
    this.scale = 400; this.ox = 0; this.oy = 0; this.fitScale = 400;
    this.dpr = 1; this.cssW = 0; this.cssH = 0;
    this.op = null; this.picks = [];
    this.mouse = null; this.hovered = false;
    this.hover = { line: -1, vertex: null, snap: null };
    this.keys = { shift: false, alt: false, space: false };
    this.pointers = {}; this.pinch = null; this.panning = null;
    this._raf = 0; this._lastStatus = ''; this._destroyed = false;

    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    canvas.style.touchAction = 'none';
    canvas.style.outline = 'none';
    canvas.style.userSelect = 'none';
    canvas.style.webkitUserSelect = 'none';

    this.doc.lines = this._normalize([]);
    this._rebuild();
    this._bind();
    this.resize();
    this.fit();
    this._updateCursor();
  }

  var P = CPEditor.prototype;
  CPEditor.COLORS = COLORS; CPEditor.NAMES = NAMES; CPEditor.TYPES = TYPES; CPEditor.TOOLS = TOOLS; CPEditor.TOOL_NAMES = TOOL_NAMES;
  CPEditor.mergeCollinear = mergeCollinear; CPEditor.fallbackNormalize = fallbackNormalize;

  /* ------------------------------ document / history ------------------------------ */
  P._normalize = function (lines) {
    var w = this.doc.width, h = this.doc.height, out;
    var CPg = global.CP;
    if (CPg && typeof CPg.normalize === 'function') out = CPg.normalize(lines, { width: w, height: h });
    else out = fallbackNormalize(lines, w, h);
    out = mergeCollinear(out, Math.max(w, h));
    // 归一化会重建线条（可能合并/拆分），这里把 stage / foldAngle 按几何位置重新挂回去
    var src = (lines || []).filter(function (q) { return q.stage !== undefined || q.foldAngle !== undefined; });
    function sameInfLine(q, l) {
      var q1 = q.a, q2 = q.b, l1 = l.a, l2 = l.b;
      var dq = [q2[0] - q1[0], q2[1] - q1[1]], dl = [l2[0] - l1[0], l2[1] - l1[1]];
      var Lq = Math.hypot(dq[0], dq[1]), Ll = Math.hypot(dl[0], dl[1]);
      if (Lq < 1e-12 || Ll < 1e-12) return false;
      var crs = Math.abs(dq[0] * dl[1] - dq[1] * dl[0]) / (Lq * Ll);
      if (crs > 1e-6) return false;                                   // 不平行
      var off = Math.abs((l1[0] - q1[0]) * dq[1] - (l1[1] - q1[1]) * dq[0]) / Lq;
      return off < 1e-6 * Math.max(w, h);                             // 同一条直线
    }
    return out.map(function (l) {
      var o = { a: [l.a[0], l.a[1]], b: [l.b[0], l.b[1]], type: l.type };
      if (isMV(l.type)) o.angle = (l.angle === undefined || l.angle === null) ? 180 : l.angle;
      else if (l.angle) o.angle = l.angle;
      for (var i = 0; i < src.length; i++) {
        var q = src[i];
        if (q.type !== l.type) continue;
        if (!sameInfLine(q, l)) continue;
        if (q.stage !== undefined) o.stage = q.stage;
        if (q.foldAngle !== undefined) o.foldAngle = q.foldAngle;
        break;
      }
      return o;
    });
  };

  P.setDoc = function (doc, o) {
    o = o || {};
    var reset = o.resetHistory === undefined ? true : !!o.resetHistory;
    doc = doc ? clone(doc) : {};
    var before = JSON.stringify(this.doc);
    var oldW = this.doc.width, oldH = this.doc.height;
    this.doc = {
      name: doc.name !== undefined ? doc.name : '未命名', description: doc.description || '',
      width: +doc.width || 1, height: +doc.height || 1, lines: []
    };
    for (var k in doc) if (!(k in this.doc)) this.doc[k] = doc[k];
    this.doc.lines = this._normalize(doc.lines || []);
    if (reset) { this.past = []; this.future = []; }
    else { this.past.push(before); if (this.past.length > this.historyLimit) this.past.shift(); this.future = []; }
    this._cancelOp();
    this.sel = {};
    this._rebuild();
    if (o.fit !== false && (reset || oldW !== this.doc.width || oldH !== this.doc.height)) this.fit();
    if (this.autoValidate) this._autoValidate();
    this._emitSel(); this._emitHistory();
    if (o.emit) this.onChange(this.getDoc());
    this._draw();
  };
  P.getDoc = function () { return clone(this.doc); };
  P.getLines = function () { return clone(this.doc.lines); };

  // Commit a new line array. selSegs: array of [a,b] to re-select after normalization.
  P._commit = function (lines, selSegs) {
    var before = JSON.stringify(this.doc);
    var norm = this._normalize(lines);
    if (JSON.stringify(norm) === JSON.stringify(this.doc.lines)) { this._rebuild(); this._draw(); return false; }
    this.past.push(before);
    if (this.past.length > this.historyLimit) this.past.shift();
    this.future = [];
    this.doc.lines = norm;
    this._rebuild();
    this.sel = selSegs ? this._selectBySegs(selSegs) : {};
    if (this.autoValidate) this._autoValidate();
    this._emitSel(); this._emitHistory();
    this.onChange(this.getDoc());
    this._draw();
    return true;
  };
  P.addLines = function (lines, select) {
    var self = this, add = (lines || []).map(function (l) { return self._mkLine(l.a, l.b, l.type, l.angle); });
    return this._commit(this.doc.lines.concat(add), select ? add.map(function (l) { return [l.a, l.b]; }) : null);
  };
  P._mkLine = function (a, b, type, angle) {
    type = type || this.lineType;
    var l = { a: [a[0], a[1]], b: [b[0], b[1]], type: type };
    if (isMV(type)) l.angle = angle === undefined || angle === null ? this.defaultAngle : angle;
    return l;
  };
  P._selectBySegs = function (segs) {
    var tol = 1e-6 * Math.max(this.doc.width, this.doc.height), sel = {};
    this.doc.lines.forEach(function (l, i) {
      if (l.type === 'B') return;
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k];
        if (OG.pointSegDist(l.a, s[0], s[1]) < tol && OG.pointSegDist(l.b, s[0], s[1]) < tol) { sel[i] = true; break; }
      }
    });
    return sel;
  };
  P._restore = function (json) {
    var d = JSON.parse(json), sizeChanged = d.width !== this.doc.width || d.height !== this.doc.height;
    this.doc = d;
    this._cancelOp(); this.sel = {};
    this._rebuild();
    if (sizeChanged) this.fit();
    if (this.autoValidate) this._autoValidate();
    this._emitSel(); this._emitHistory();
    this.onChange(this.getDoc());
    this._draw();
  };
  P.undo = function () {
    if (this.op || this.picks.length) { this._cancelOp(); this._draw(); }
    if (!this.past.length) return false;
    this.future.push(JSON.stringify(this.doc));
    this._restore(this.past.pop());
    this._status('已撤销');
    return true;
  };
  P.redo = function () {
    if (!this.future.length) return false;
    this.past.push(JSON.stringify(this.doc));
    this._restore(this.future.pop());
    this._status('已重做');
    return true;
  };
  P.canUndo = function () { return this.past.length > 0; };
  P.canRedo = function () { return this.future.length > 0; };
  P._emitHistory = function () { this.onHistoryChange({ canUndo: this.canUndo(), canRedo: this.canRedo(), undoCount: this.past.length, redoCount: this.future.length }); };

  P.clear = function () {
    this._cancelOp();
    return this._commit(this.doc.lines.filter(function (l) { return l.type === 'B'; }));
  };

  /* ------------------------------ selection ops ------------------------------ */
  P.getSelection = function () { return Object.keys(this.sel).map(Number).sort(function (a, b) { return a - b; }); };
  P.setSelection = function (indices) {
    var s = {}, lines = this.doc.lines;
    (indices || []).forEach(function (i) { if (lines[i] && lines[i].type !== 'B') s[i] = true; });
    this.sel = s; this._emitSel(); this._draw();
  };
  P._selLines = function () { var self = this; return this.getSelection().map(function (i) { return self.doc.lines[i]; }); };
  P._emitSel = function () {
    var types = { M: 0, V: 0, F: 0, U: 0, C: 0, B: 0 }, count = 0, angle = null, mixed = false, lines = this.doc.lines;
    for (var k in this.sel) {
      var l = lines[k]; if (!l) continue;
      count++; types[l.type]++;
      if (isMV(l.type)) { if (angle === null) angle = l.angle; else if (angle !== l.angle) mixed = true; }
    }
    this.onSelectionChange({ count: count, types: types, angle: mixed ? null : angle, indices: this.getSelection() });
  };
  P.selectAll = function () {
    var s = {};
    this.doc.lines.forEach(function (l, i) { if (l.type !== 'B') s[i] = true; });
    this.sel = s; this._emitSel(); this._draw();
  };
  P.clearSelection = function () { this.sel = {}; this._emitSel(); this._draw(); };
  P._modifySelected = function (fn) {
    var idx = this.getSelection();
    if (!idx.length) return false;
    var lines = clone(this.doc.lines), segs = [];
    idx.forEach(function (i) { fn(lines[i]); segs.push([lines[i].a, lines[i].b]); });
    return this._commit(lines, segs);
  };
  P.deleteSelected = function () {
    var sel = this.sel;
    if (!Object.keys(sel).length) return false;
    var r = this._commit(this.doc.lines.filter(function (l, i) { return !sel[i]; }));
    this._status('已删除所选折痕');
    return r;
  };
  P.setSelectedType = function (t) {
    if (TYPES.indexOf(t) < 0) return false;
    var self = this;
    return this._modifySelected(function (l) {
      l.type = t;
      if (isMV(t)) { if (l.angle === undefined || !l.angle) l.angle = self.defaultAngle; } else delete l.angle;
    });
  };
  P.setSelectedAngle = function (deg) {
    deg = Math.max(0, Math.min(180, Math.abs(+deg || 0)));
    return this._modifySelected(function (l) { if (isMV(l.type)) l.angle = deg; });
  };
  P.flipSelectedMV = function () {
    return this._modifySelected(function (l) { if (l.type === 'M') l.type = 'V'; else if (l.type === 'V') l.type = 'M'; });
  };
  P.invertAllMV = function () {
    var lines = clone(this.doc.lines), sel = this.getSelection().map(function (i) { return [lines[i].a, lines[i].b]; });
    lines.forEach(function (l) { if (l.type === 'M') l.type = 'V'; else if (l.type === 'V') l.type = 'M'; });
    return this._commit(lines, sel);
  };

  /* ------------------------------ settings ------------------------------ */
  P.setTool = function (t) {
    if (TOOLS.indexOf(t) < 0) return;
    this._cancelOp();
    this.tool = t;
    this._updateCursor();
    this._refreshHover();
    this._status();
    this.onToolChange(t);
    this._draw();
  };
  P.getTool = function () { return this.tool; };
  P.setLineType = function (t) {
    if (TYPES.indexOf(t) < 0) return;
    this.lineType = t;
    this._status();
    this.onLineTypeChange(t);
    this._draw();
  };
  P.getLineType = function () { return this.lineType; };
  P.setDefaultAngle = function (deg) { this.defaultAngle = Math.max(0, Math.min(180, Math.abs(+deg || 0))); };
  P.getDefaultAngle = function () { return this.defaultAngle; };
  P.setGrid = function (g) {
    g = g || {};
    if (g.divisions !== undefined) this.grid.divisions = Math.max(0, Math.min(256, Math.round(+g.divisions || 0)));
    if (g.type) this.grid.type = g.type;
    this._rebuild(); this._draw();
  };
  P.getGrid = function () { return { divisions: this.grid.divisions, type: this.grid.type }; };
  P.setSnap = function (s) {
    s = s || {};
    for (var k in this.snapOpts) if (s[k] !== undefined) this.snapOpts[k] = !!s[k];
    this._refreshHover(); this._draw();
  };
  P.getSnap = function () { return clone(this.snapOpts); };
  P.setValidation = function (r) { this.validation = r || null; this._draw(); };
  P.setAutoValidate = function (on) { this.autoValidate = !!on; if (on) this._autoValidate(); else this.validation = null; this._draw(); };
  P._autoValidate = function () {
    if (global.CP && CP.validate) { try { this.validation = CP.validate(this.doc); } catch (e) { this.validation = null; } }
  };
  P.setShowLabels = function (b) { this.showLabels = !!b; this._draw(); };
  P.setShowAngles = function (b) { this.showAngles = !!b; this._draw(); };

  /* ------------------------------ view ------------------------------ */
  P.toScreen = function (p) { return [this.ox + p[0] * this.scale, this.oy + p[1] * this.scale]; };
  P.toPaper = function (s) { return [(s[0] - this.ox) / this.scale, (s[1] - this.oy) / this.scale]; };
  P.resize = function () {
    var c = this.canvas, dpr = global.devicePixelRatio || 1;
    var w = c.clientWidth || +c.getAttribute('width') || 600, h = c.clientHeight || +c.getAttribute('height') || 600;
    if (this.cssW && (w !== this.cssW || h !== this.cssH)) { this.ox += (w - this.cssW) / 2; this.oy += (h - this.cssH) / 2; }
    this.cssW = w; this.cssH = h; this.dpr = dpr;
    var bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    this._render();
  };
  P.fit = function () {
    var W = this.cssW, H = this.cssH, w = this.doc.width, h = this.doc.height;
    var pad = Math.max(22, Math.min(W, H) * 0.06);
    this.scale = Math.max(1, Math.min((W - 2 * pad) / w, (H - 2 * pad) / h));
    this.fitScale = this.scale;
    this.ox = (W - w * this.scale) / 2; this.oy = (H - h * this.scale) / 2;
    this._refreshHover(); this._draw();
  };
  P.zoomAt = function (s, factor) {
    var ns = OG.clamp(this.scale * factor, this.fitScale * 0.2, this.fitScale * 80);
    var f = ns / this.scale;
    this.ox = s[0] - (s[0] - this.ox) * f; this.oy = s[1] - (s[1] - this.oy) * f;
    this.scale = ns;
    this._refreshHover(); this._draw();
  };
  P.zoom = function (factor) { this.zoomAt([this.cssW / 2, this.cssH / 2], factor || 1.25); };
  P.getView = function () { return { scale: this.scale, ox: this.ox, oy: this.oy, fitScale: this.fitScale }; };
  P.setView = function (v) { if (v.scale) this.scale = v.scale; if (v.ox !== undefined) this.ox = v.ox; if (v.oy !== undefined) this.oy = v.oy; this._draw(); };

  /* ------------------------------ caches ------------------------------ */
  P._rebuild = function () {
    var lines = this.doc.lines, w = this.doc.width, h = this.doc.height, q = 1e-7 * Math.max(w, h);
    var vmap = {}, verts = [], mids = [];
    function key(p) { return Math.round(p[0] / q) + ',' + Math.round(p[1] / q); }
    lines.forEach(function (l, i) {
      [l.a, l.b].forEach(function (p) {
        var k = key(p);
        if (vmap[k] === undefined) { vmap[k] = verts.length; verts.push({ p: p, lines: [] }); }
        verts[vmap[k]].lines.push(i);
      });
      mids.push({ p: OG.lerp(l.a, l.b, 0.5), line: i });
    });
    [[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]].forEach(function (p) {
      if (vmap[key(p)] === undefined) mids.push({ p: p, line: -1 });
    });
    this._verts = verts; this._vmap = vmap; this._vkey = key; this._mids = mids;
    this._gridLines = this._computeGridLines();
    // crease × grid-line intersections
    var ints = [];
    if (this._gridLines.length) {
      var gl = this._gridLines;
      lines.forEach(function (l) {
        if (l.type === 'B') return;
        for (var g = 0; g < gl.length; g++) {
          var r = OG.segIntersect(l.a, l.b, gl[g][0], gl[g][1], 1e-9);
          if (r && r.t > 1e-6 && r.t < 1 - 1e-6) ints.push(r.p);
        }
      });
    }
    this._ints = ints;
  };
  P._computeGridLines = function () {
    var n = this.grid.divisions, w = this.doc.width, h = this.doc.height, out = [];
    if (!n || this.grid.type === 'none') return out;
    var i;
    if (this.grid.type === 'triangle') {
      var s = w / n, r = s * SQ3 / 2;
      for (i = 1; i * r < h - 1e-9; i++) out.push([[0, i * r], [w, i * r], i]);
      var k0 = Math.floor(-h / SQ3 / s) - 1, k1 = Math.ceil((w + h / SQ3) / s) + 1;
      for (i = k0; i <= k1; i++) {
        var c1 = clipRect([i * s, 0], [i * s + h / SQ3, h], w, h);
        if (c1 && OG.dist(c1[0], c1[1]) > 1e-9) out.push([c1[0], c1[1], i]);
        var c2 = clipRect([i * s, 0], [i * s - h / SQ3, h], w, h);
        if (c2 && OG.dist(c2[0], c2[1]) > 1e-9) out.push([c2[0], c2[1], i]);
      }
    } else {
      var nx = n, ny = Math.max(1, Math.round(n * h / w));
      for (i = 1; i < nx; i++) out.push([[i * w / nx, 0], [i * w / nx, h], i, nx]);
      for (i = 1; i < ny; i++) out.push([[0, i * h / ny], [w, i * h / ny], i, ny]);
    }
    return out;
  };
  P._nearestGrid = function (p) {
    var n = this.grid.divisions, w = this.doc.width, h = this.doc.height, tol = 1e-9;
    if (!n || this.grid.type === 'none') return null;
    if (this.grid.type === 'triangle') {
      var s = w / n, r = s * SQ3 / 2, best = null, bd = Infinity, j0 = Math.round(p[1] / r);
      for (var j = j0 - 1; j <= j0 + 1; j++) {
        var y = j * r; if (y < -tol || y > h + tol) continue;
        var off = (j % 2 + 2) % 2 * s / 2, i = Math.round((p[0] - off) / s);
        for (var di = -1; di <= 1; di++) {
          var x = (i + di) * s + off;
          if (x < -tol || x > w + tol) continue;
          var d = OG.dist([x, y], p); if (d < bd) { bd = d; best = [x, y]; }
        }
      }
      return best;
    }
    var nx = n, ny = Math.max(1, Math.round(n * h / w));
    return [OG.clamp(Math.round(p[0] / w * nx), 0, nx) * w / nx, OG.clamp(Math.round(p[1] / h * ny), 0, ny) * h / ny];
  };

  /* ------------------------------ hit testing & snapping ------------------------------ */
  P._thr = function () { return this._touch ? 18 : 10; };
  P._hitLine = function (s, includeB, exclude) {
    var p = this.toPaper(s), thr = this._thr() * 0.8, best = -1, bd = Infinity, lines = this.doc.lines;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.type === 'B' && !includeB) continue;
      if (exclude && exclude[i]) continue;
      var d = OG.pointSegDist(p, l.a, l.b) * this.scale + (l.type === 'B' ? 2 : 0);
      if (d < thr && d < bd) { bd = d; best = i; }
    }
    return best;
  };
  P._hitVertex = function (s, needCrease) {
    var p = this.toPaper(s), thr = this._thr(), best = null, bd = Infinity, lines = this.doc.lines;
    for (var i = 0; i < this._verts.length; i++) {
      var v = this._verts[i];
      if (needCrease && !v.lines.some(function (k) { return lines[k].type !== 'B'; })) continue;
      var d = OG.dist(v.p, p) * this.scale;
      if (d < thr && d < bd) { bd = d; best = v; }
    }
    return best;
  };
  // o: { from, exclude:{p, lines} }
  P._snap = function (s, o) {
    o = o || {};
    var p = this.toPaper(s), thr = this._thr() / this.scale, so = this.snapOpts, best = null;
    if (o.from && this.keys.shift && so.angle22_5) return this._snapAngle(o.from, p, thr, o);
    var exP = o.exclude && o.exclude.p, exL = (o.exclude && o.exclude.lines) || {};
    function consider(q, kind) {
      var d = OG.dist(q, p); if (d > thr) return;
      var pr = PRIORITY[kind];
      if (!best || pr < best.pr || (pr === best.pr && d < best.d)) best = { p: [q[0], q[1]], kind: kind, d: d, pr: pr };
    }
    var i;
    if (so.vertex) for (i = 0; i < this._verts.length; i++) {
      var v = this._verts[i].p;
      if (exP && OG.dist(v, exP) < 1e-9) continue;
      consider(v, 'vertex');
    }
    if (so.intersection) for (i = 0; i < this._ints.length; i++) consider(this._ints[i], 'intersection');
    if (so.midpoint) for (i = 0; i < this._mids.length; i++) { var m = this._mids[i]; if (m.line >= 0 && exL[m.line]) continue; consider(m.p, 'midpoint'); }
    if (so.grid) { var g = this._nearestGrid(p); if (g) consider(g, 'grid'); }
    if (!best && so.onLine) {
      var li = this._hitLine(s, true, exL);
      if (li >= 0) { var l = this.doc.lines[li]; consider(OG.lerp(l.a, l.b, OG.projectT(p, l.a, l.b)), 'online'); }
    }
    if (best) return { p: best.p, kind: best.kind };
    return { p: p, kind: 'free' };
  };
  P._snapAngle = function (from, p, thr, o) {
    var d = OG.sub(p, from), ang = Math.atan2(d[1], d[0]), step = Math.PI / 8;
    var a2 = Math.round(ang / step) * step, dir = [Math.cos(a2), Math.sin(a2)];
    var t = OG.dot(d, dir), q = [from[0] + dir[0] * t, from[1] + dir[1] * t];
    var best = null, bd = thr;
    var exL = (o && o.exclude && o.exclude.lines) || {};
    function test(a, b, kind) {
      var r = raySeg(from, dir, a, b);
      if (!r || Math.abs(r.t) < 1e-9) return;
      var dd = OG.dist(r.p, q);
      if (dd < bd) { bd = dd; best = { p: r.p, kind: kind }; }
    }
    var lines = this.doc.lines;
    for (var i = 0; i < lines.length; i++) if (!exL[i]) test(lines[i].a, lines[i].b, 'intersection');
    for (i = 0; i < this._gridLines.length; i++) test(this._gridLines[i][0], this._gridLines[i][1], 'intersection');
    if (best) {
      for (i = 0; i < this._verts.length; i++) if (OG.dist(this._verts[i].p, best.p) < 1e-7) { best.p = this._verts[i].p.slice(); best.kind = 'vertex'; break; }
      best.constrained = true;
      return best;
    }
    return { p: q, kind: 'angle', constrained: true };
  };
  // first hit of a ray from o along unit d (creases + sheet edge). ignoreCreases → sheet edge only.
  P._rayCast = function (o, d, ignoreCreases) {
    var w = this.doc.width, h = this.doc.height, best = Infinity, eps = 1e-7 * Math.max(w, h);
    function test(a, b) {
      var r = raySeg(o, d, a, b);
      if (r && r.t > eps && r.t < best) best = r.t;
    }
    if (!ignoreCreases) this.doc.lines.forEach(function (l) { test(l.a, l.b); });
    test([0, 0], [w, 0]); test([w, 0], [w, h]); test([w, h], [0, h]); test([0, h], [0, 0]);
    if (best === Infinity) return null;
    return [o[0] + d[0] * best, o[1] + d[1] * best];
  };
  P._fullLine = function (o, d) {
    var big = 4 * Math.max(this.doc.width, this.doc.height);
    return clipRect([o[0] - d[0] * big, o[1] - d[1] * big], [o[0] + d[0] * big, o[1] + d[1] * big], this.doc.width, this.doc.height);
  };
  P._twoWay = function (o, d, full) {
    if (full) return this._fullLine(o, d);
    var a = this._rayCast(o, [-d[0], -d[1]], false), b = this._rayCast(o, d, false);
    if (!a || !b) return this._fullLine(o, d);
    return [a, b];
  };

  /* ------------------------------ constructions ------------------------------ */
  // returns array of [a,b] segments or null
  P._construct = function (picks) {
    var t = this.tool, full = this.keys.alt, self = this, d, o, r;
    function pts() { return picks.filter(function (k) { return k.kind === 'point'; }); }
    function lns() { return picks.filter(function (k) { return k.kind === 'line'; }); }
    function ray(o, d) { var e = self._rayCast(o, d, full); return e ? [[o, e]] : null; }
    if (t === 'ray') {
      if (picks.length < 2) return null;
      d = OG.sub(picks[1].p, picks[0].p);
      if (OG.len(d) < 1e-9) return null;
      return ray(picks[0].p, OG.norm(d));
    }
    if (t === 'pbisect') {
      if (picks.length < 2) return null;
      var A = picks[0].p, B = picks[1].p;
      if (OG.dist(A, B) < 1e-9) return null;
      r = this._twoWay(OG.lerp(A, B, 0.5), OG.perp(OG.norm(OG.sub(B, A))), full);
      return r ? [r] : null;
    }
    if (t === 'perp') {
      var ps = pts(), ls = lns();
      if (!ps.length || !ls.length) return null;
      var Pp = ps[0].p, L = ls[0], F = foot(Pp, L.a, L.b), dl = OG.norm(OG.sub(L.b, L.a));
      if (OG.dist(Pp, F) * this.scale > 0.5) {
        if (full) { r = this._fullLine(Pp, OG.norm(OG.sub(F, Pp))); return r ? [r] : null; }
        var c = clipRect(Pp, F, this.doc.width, this.doc.height);
        return c ? [c] : null;
      }
      r = this._twoWay(Pp, OG.perp(dl), full);
      return r ? [r] : null;
    }
    if (t === 'bisector') {
      if (picks.length && picks[0].kind === 'point') {
        if (picks.length < 3) return null;
        var a = picks[0].p, b = picks[1].p, c3 = picks[2].p;
        var u = OG.norm(OG.sub(a, b)), v = OG.norm(OG.sub(c3, b));
        if (OG.len(u) < 1e-12 || OG.len(v) < 1e-12) return null;
        d = OG.add(u, v);
        d = OG.len(d) < 1e-9 ? OG.perp(u) : OG.norm(d);
        return ray(b, d);
      }
      if (picks.length < 2) return null;
      var L1 = picks[0], L2 = picks[1];
      var r1 = OG.sub(L1.b, L1.a), r2 = OG.sub(L2.b, L2.a);
      var X = OG.lineIntersect(L1.a, r1, L2.a, r2);
      if (!X || Math.abs(OG.cross(OG.norm(r1), OG.norm(r2))) < 1e-9) {
        // parallel: mid-line
        var f2 = foot(L1.at, L2.a, L2.b), m = OG.lerp(L1.at, f2, 0.5);
        if (OG.dist(L1.at, f2) < 1e-9) return null;
        r = this._twoWay(m, OG.norm(r1), full);
        return r ? [r] : null;
      }
      var d1 = OG.sub(L1.at, X), d2 = OG.sub(L2.at, X);
      d1 = OG.len(d1) < 1e-9 ? OG.norm(r1) : OG.norm(d1);
      d2 = OG.len(d2) < 1e-9 ? OG.norm(r2) : OG.norm(d2);
      d = OG.add(d1, d2);
      d = OG.len(d) < 1e-9 ? OG.perp(d1) : OG.norm(d);
      var w = this.doc.width, h = this.doc.height, e = 1e-9;
      if (X[0] > -e && X[0] < w + e && X[1] > -e && X[1] < h + e) return ray(X, d);
      var fl = this._fullLine(X, d);
      if (!fl) return null;
      var start = OG.dist(fl[0], X) < OG.dist(fl[1], X) ? fl[0] : fl[1];
      if (OG.dot(OG.sub(start, X), d) < 0) return null;
      return ray(start, d);
    }
    if (t === 'mirror') {
      if (!picks.length) return null;
      var ax = picks[0], out = [];
      this._selLines().forEach(function (l) {
        var cl = clipRect(reflect(l.a, ax.a, ax.b), reflect(l.b, ax.a, ax.b), self.doc.width, self.doc.height);
        if (cl && OG.dist(cl[0], cl[1]) > 1e-9) out.push([cl[0], cl[1], l.type, l.angle]);
      });
      return out.length ? out : null;
    }
    return null;
  };
  P._needs = function () {
    var t = this.tool, pk = this.picks;
    if (t === 'ray' || t === 'pbisect') return 'point';
    if (t === 'mirror') return 'line';
    if (t === 'perp') {
      if (pk.length && pk[0].kind === 'point') return 'line';
      if (pk.length && pk[0].kind === 'line') return 'point';
      return 'either';
    }
    if (t === 'bisector') return pk.length ? pk[0].kind : 'either';
    return null;
  };
  // determine what a click at s would pick
  P._candidatePick = function (s) {
    var need = this._needs(); if (!need) return null;
    var from = (this.tool === 'ray' && this.picks.length) ? this.picks[0].p : null;
    var sn = this._snap(s, { from: from });
    var strong = sn.kind !== 'free' && sn.kind !== 'online';
    var li = this._hitLine(s, true);
    var asLine = function () {
      var l = this.doc.lines[li];
      return { kind: 'line', idx: li, a: l.a.slice(), b: l.b.slice(), at: OG.lerp(l.a, l.b, OG.projectT(this.toPaper(s), l.a, l.b)) };
    }.bind(this);
    if (need === 'point') return { kind: 'point', p: sn.p, snap: sn };
    if (need === 'line') return li >= 0 ? asLine() : null;
    if (strong || li < 0) return { kind: 'point', p: sn.p, snap: sn };
    return asLine();
  };

  /* ------------------------------ events ------------------------------ */
  P._bind = function () {
    var self = this, c = this.canvas;
    this._h = {
      down: function (e) { self._onDown(e); },
      move: function (e) { self._onMove(e); },
      up: function (e) { self._onUp(e); },
      cancel: function (e) { delete self.pointers[e.pointerId]; self.pinch = null; self.panning = null; self._cancelOp(); self._draw(); },
      enter: function () { self.hovered = true; },
      leave: function (e) {
        self.hovered = false;
        if (!self.op && !self.panning) { self.mouse = null; self.hover = { line: -1, vertex: null, snap: null }; self._draw(); }
      },
      wheel: function (e) { self._onWheel(e); },
      key: function (e) { self._onKey(e); },
      keyup: function (e) { self._onKeyUp(e); },
      ctx: function (e) { e.preventDefault(); },
      blur: function () { self.keys.space = false; self.keys.shift = false; self.keys.alt = false; self._updateCursor(); },
      resize: function () { self.resize(); }
    };
    c.addEventListener('pointerdown', this._h.down);
    c.addEventListener('pointermove', this._h.move);
    c.addEventListener('pointerup', this._h.up);
    c.addEventListener('pointercancel', this._h.cancel);
    c.addEventListener('pointerenter', this._h.enter);
    c.addEventListener('pointerleave', this._h.leave);
    c.addEventListener('wheel', this._h.wheel, { passive: false });
    c.addEventListener('contextmenu', this._h.ctx);
    global.addEventListener('keydown', this._h.key);
    global.addEventListener('keyup', this._h.keyup);
    global.addEventListener('blur', this._h.blur);
    global.addEventListener('resize', this._h.resize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(c);
    }
  };
  P.destroy = function () {
    var c = this.canvas, h = this._h;
    this._destroyed = true;
    c.removeEventListener('pointerdown', h.down); c.removeEventListener('pointermove', h.move);
    c.removeEventListener('pointerup', h.up); c.removeEventListener('pointercancel', h.cancel);
    c.removeEventListener('pointerenter', h.enter); c.removeEventListener('pointerleave', h.leave);
    c.removeEventListener('wheel', h.wheel); c.removeEventListener('contextmenu', h.ctx);
    global.removeEventListener('keydown', h.key); global.removeEventListener('keyup', h.keyup);
    global.removeEventListener('blur', h.blur); global.removeEventListener('resize', h.resize);
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };
  P._pos = function (e) {
    var r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  P._syncMods = function (e) {
    var ch = this.keys.shift !== !!e.shiftKey || this.keys.alt !== !!e.altKey;
    this.keys.shift = !!e.shiftKey; this.keys.alt = !!e.altKey;
    return ch;
  };
  P._onDown = function (e) {
    var s = this._pos(e);
    this._touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    try { this.canvas.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
    this._syncMods(e);
    this.pointers[e.pointerId] = s;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err2) { /* ignore */ }
    var ids = Object.keys(this.pointers);
    if (ids.length === 2 && e.pointerType === 'touch') {
      this._cancelOp();
      var a = this.pointers[ids[0]], b = this.pointers[ids[1]];
      this.pinch = { d: OG.dist(a, b), m: OG.lerp(a, b, 0.5) };
      this._draw();
      return;
    }
    if (ids.length > 2 || this.pinch) return;
    e.preventDefault();
    if (e.button === 2) { this.cancel(); return; }
    if (e.button === 1 || this.keys.space || this.tool === 'pan') {
      this.panning = { last: s };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    this.mouse = s;
    this._toolDown(s, e);
    this._refreshHover();
    this._status();
    this._draw();
  };
  P._onMove = function (e) {
    var s = this._pos(e);
    if (e.pointerType === 'mouse') this._touch = false;
    if (this.pointers[e.pointerId]) this.pointers[e.pointerId] = s;
    this._syncMods(e);
    if (this.pinch) {
      var ids = Object.keys(this.pointers);
      if (ids.length >= 2) {
        var a = this.pointers[ids[0]], b = this.pointers[ids[1]], d = OG.dist(a, b), m = OG.lerp(a, b, 0.5);
        this.ox += m[0] - this.pinch.m[0]; this.oy += m[1] - this.pinch.m[1];
        if (this.pinch.d > 1 && d > 1) this.zoomAt(m, d / this.pinch.d);
        this.pinch = { d: d, m: m };
        this._draw();
      }
      return;
    }
    if (this.panning) {
      this.ox += s[0] - this.panning.last[0]; this.oy += s[1] - this.panning.last[1];
      this.panning.last = s;
      this._draw();
      return;
    }
    this.mouse = s; this.hovered = true;
    this._toolMove(s, e);
    this._refreshHover();
    this._status();
    this._draw();
  };
  P._onUp = function (e) {
    var s = this._pos(e);
    delete this.pointers[e.pointerId];
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (this.pinch) { if (Object.keys(this.pointers).length < 2) this.pinch = null; return; }
    if (this.panning) { this.panning = null; this._updateCursor(); return; }
    this._syncMods(e);
    if (e.button === 0 || e.pointerType !== 'mouse') {
      this.mouse = s;
      this._toolUp(s, e);
    }
    if (this._touch && !this.op && !this.picks.length) this.mouse = null;
    this._refreshHover();
    this._status();
    this._draw();
  };
  P._onWheel = function (e) {
    e.preventDefault();
    var s = this._pos(e), dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    var k = e.ctrlKey ? 0.012 : 0.0018;
    this.zoomAt(s, Math.exp(-OG.clamp(dy, -300, 300) * k));
    this.mouse = s;
    this._refreshHover();
  };
  function isEditable(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      return ['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file', 'image'].indexOf(t) < 0;
    }
    return !!el.isContentEditable;
  }
  P._keyActive = function () {
    var ae = typeof document !== 'undefined' ? document.activeElement : null;
    if (ae === this.canvas) return true;
    if (isEditable(ae)) return false;
    return this.hovered;
  };
  P._onKey = function (e) {
    if (e.key === 'Shift' || e.key === 'Alt') {
      this.keys.shift = e.key === 'Shift' ? true : this.keys.shift; this.keys.alt = e.key === 'Alt' ? true : this.keys.alt;
      if (this.mouse) { this._toolMove(this.mouse, e); this._refreshHover(); this._status(); this._draw(); }
      return;
    }
    if (!this._keyActive()) return;
    var k = e.key, mod = e.ctrlKey || e.metaKey, lk = (k || '').toLowerCase();
    if (k === ' ' || e.code === 'Space') {
      if (!this.keys.space) { this.keys.space = true; this._updateCursor(); }
      e.preventDefault(); return;
    }
    if (mod && lk === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && lk === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && lk === 'a') { e.preventDefault(); this.selectAll(); return; }
    if (mod) return;
    if (k === 'Escape') { e.preventDefault(); this.cancel(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.deleteSelected(); return; }
    if (e.altKey) return;
    if (k >= '1' && k <= '6' && k.length === 1) { e.preventDefault(); this.setLineType(TYPES[+k - 1]); return; }
    var map = { m: 'M', v: 'V', f: 'F', u: 'U' };
    if (map[lk]) { e.preventDefault(); this.setLineType(map[lk]); return; }
    if (k === 'Home' || k === '0') { e.preventDefault(); this.fit(); return; }
    if (k === '+' || k === '=') { e.preventDefault(); this.zoom(1.25); return; }
    if (k === '-' || k === '_') { e.preventDefault(); this.zoom(0.8); return; }
  };
  P._onKeyUp = function (e) {
    if (e.key === 'Shift') this.keys.shift = false;
    if (e.key === 'Alt') this.keys.alt = false;
    if (e.key === ' ' || e.code === 'Space') { this.keys.space = false; this._updateCursor(); }
    if (this.mouse && (e.key === 'Shift' || e.key === 'Alt')) { this._toolMove(this.mouse, e); this._refreshHover(); this._status(); this._draw(); }
  };
  P._updateCursor = function () {
    var t = this.tool, c = 'crosshair';
    if (this.keys.space || t === 'pan') c = 'grab';
    else if (t === 'select') c = 'default';
    else if (t === 'erase' || t === 'type' || t === 'mirror') c = 'pointer';
    this.canvas.style.cursor = c;
  };
  P._cancelOp = function () { this.op = null; this.picks = []; };
  P.cancel = function () {
    if (this.op || this.picks.length) { this._cancelOp(); this._status('已取消当前操作'); }
    else if (Object.keys(this.sel).length) this.clearSelection();
    this._draw();
  };

  /* ------------------------------ tool state machine ------------------------------ */
  P._refreshHover = function () {
    var s = this.mouse, t = this.tool;
    if (!s) { this.hover = { line: -1, vertex: null, snap: null }; return; }
    var hv = { line: -1, vertex: null, snap: null };
    if (t === 'select' || t === 'erase' || t === 'type') hv.line = this._hitLine(s, false);
    if (t === 'select') hv.vertex = this._hitVertex(s, true);
    else if (t !== 'pan') hv.vertex = this._hitVertex(s, false);
    if (t === 'line') hv.snap = this._snap(s, { from: this.op && this.op.kind === 'draw' ? this.op.start : null });
    if (this._needs()) {
      var cp = this._candidatePick(s);
      hv.pick = cp;
      if (cp && cp.kind === 'point') hv.snap = cp.snap;
      if (cp && cp.kind === 'line') hv.line = cp.idx;
    }
    if (this.op && this.op.kind === 'vertex') hv.snap = this.op.snap;
    if (this.op && this.op.kind === 'move') hv.snap = this.op.snap;
    this.hover = hv;
  };
  P._toolDown = function (s, e) {
    var t = this.tool, p = this.toPaper(s);
    if (t === 'line') {
      var sn = this._snap(s, { from: this.op ? this.op.start : null });
      if (!this.op) this.op = { kind: 'draw', start: sn.p, startKind: sn.kind, down: s, end: sn.p, endKind: sn.kind, dragging: true };
      else { this._commitDraw(sn.p); }
      return;
    }
    if (t === 'select') {
      var v = this._hitVertex(s, true), li = this._hitLine(s, false);
      if (v && !(li >= 0 && this.sel[li] && !e.shiftKey && OG.dist(this.toScreen(v.p), s) > 5)) {
        var lines = this.doc.lines, att = {};
        v.lines.forEach(function (k) { if (lines[k].type !== 'B') att[k] = true; });
        this.op = { kind: 'vertex', p0: v.p.slice(), att: att, cur: v.p.slice(), down: s, moved: false, snap: null };
        return;
      }
      if (li >= 0) {
        if (e.shiftKey) { if (this.sel[li]) delete this.sel[li]; else this.sel[li] = true; this._emitSel(); this.op = null; return; }
        var wasSel = !!this.sel[li];
        if (!wasSel) { this.sel = {}; this.sel[li] = true; this._emitSel(); }
        var exl = {}; for (var k in this.sel) exl[k] = true;
        var g = this._snap(s, { exclude: {} });
        if (g.kind === 'free' || g.kind === 'online') { var L = this.doc.lines[li]; g = { p: OG.lerp(L.a, L.b, OG.projectT(p, L.a, L.b)), kind: 'online' }; }
        this.op = { kind: 'move', grab: g.p, delta: [0, 0], down: s, moved: false, line: li, wasSel: wasSel, exl: exl };
        return;
      }
      this.op = { kind: 'box', s0: s, s1: s, add: e.shiftKey };
      return;
    }
    if (t === 'erase' || t === 'type') {
      this.op = { kind: 'brush', mode: t, marked: {}, last: p, path: [s] };
      var h = this._hitLine(s, false); if (h >= 0) this.op.marked[h] = true;
      return;
    }
    if (this._needs()) {
      if (t === 'mirror' && (e.shiftKey || !Object.keys(this.sel).length)) {
        var lm = this._hitLine(s, false);
        if (lm >= 0) { if (this.sel[lm]) delete this.sel[lm]; else this.sel[lm] = true; this._emitSel(); }
        return;
      }
      var cp = this._candidatePick(s);
      if (!cp) return;
      this.picks.push(cp);
      var res = this._construct(this.picks);
      if (res) {
        var self = this, add = res.map(function (sg) { return self._mkLine(sg[0], sg[1], sg[2] || self.lineType, sg[3]); });
        var picksDone = this.picks; this.picks = [];
        this._commit(this.doc.lines.concat(add), t === 'mirror' ? add.map(function (l) { return [l.a, l.b]; }) : null);
        this._status(TOOL_NAMES[t] + '：已添加 ' + add.length + ' 条折痕');
        this._lastPicks = picksDone;
      } else if (this._isComplete()) {
        this.picks = [];
        this._status(TOOL_NAMES[t] + '：无法构造（点重合或无交点）');
      }
    }
  };
  P._isComplete = function () {
    var t = this.tool, n = this.picks.length;
    if (t === 'ray' || t === 'pbisect' || t === 'perp') return n >= 2;
    if (t === 'mirror') return n >= 1;
    if (t === 'bisector') return n && this.picks[0].kind === 'point' ? n >= 3 : n >= 2;
    return false;
  };
  P._toolMove = function (s, e) {
    var op = this.op; if (!op) return;
    var p = this.toPaper(s);
    if (op.kind === 'draw') {
      var sn = this._snap(s, { from: op.start });
      op.end = sn.p; op.endKind = sn.kind;
    } else if (op.kind === 'vertex') {
      if (!op.moved && OG.dist(s, op.down) < 4) return;
      op.moved = true;
      var sv = this._snap(s, { from: op.p0, exclude: { p: op.p0, lines: op.att } });
      op.cur = sv.p; op.snap = sv;
    } else if (op.kind === 'move') {
      if (!op.moved && OG.dist(s, op.down) < 4) return;
      op.moved = true;
      var sm = this._snap(s, { from: op.grab, exclude: { lines: op.exl } });
      op.delta = OG.sub(sm.p, op.grab); op.snap = sm;
    } else if (op.kind === 'box') {
      op.s1 = s;
    } else if (op.kind === 'brush') {
      var lines = this.doc.lines, thr = this._thr() * 0.8 / this.scale;
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i]; if (l.type === 'B' || op.marked[i]) continue;
        if (OG.segIntersect(op.last, p, l.a, l.b, 1e-9) || OG.pointSegDist(p, l.a, l.b) < thr) op.marked[i] = true;
      }
      op.last = p; op.path.push(s);
    }
  };
  P._toolUp = function (s, e) {
    var op = this.op; if (!op) return;
    var self = this;
    if (op.kind === 'draw') {
      if (op.dragging && OG.dist(s, op.down) > 6) { var sn = this._snap(s, { from: op.start }); this._commitDraw(sn.p); }
      else if (this.op) this.op.dragging = false;
      return;
    }
    if (op.kind === 'vertex') {
      this.op = null;
      if (!op.moved || OG.dist(op.cur, op.p0) < 1e-9) {
        var li = this._hitLine(s, false);
        if (li >= 0) { this.sel = {}; this.sel[li] = true; } else if (!e.shiftKey) this.sel = {};
        this._emitSel();
        return;
      }
      var lines = clone(this.doc.lines), segs = [];
      lines.forEach(function (l, i) {
        if (!op.att[i]) return;
        if (OG.dist(l.a, op.p0) < 1e-9) l.a = op.cur.slice();
        if (OG.dist(l.b, op.p0) < 1e-9) l.b = op.cur.slice();
        segs.push([l.a, l.b]);
      });
      this._commit(lines, segs);
      this._status('已移动顶点');
      return;
    }
    if (op.kind === 'move') {
      this.op = null;
      if (!op.moved) {
        if (op.wasSel) { this.sel = {}; this.sel[op.line] = true; this._emitSel(); }
        return;
      }
      var dl = op.delta;
      if (OG.len(dl) < 1e-12) return;
      var copy = this.keys.alt, out = [], moved = [], w = this.doc.width, h = this.doc.height;
      this.doc.lines.forEach(function (l, i) {
        if (!self.sel[i]) { out.push(l); return; }
        if (copy) out.push(l);
        var c = clipRect(OG.add(l.a, dl), OG.add(l.b, dl), w, h);
        if (c) { var nl = clone(l); nl.a = c[0]; nl.b = c[1]; moved.push(nl); }
      });
      this._commit(out.concat(moved), moved.map(function (l) { return [l.a, l.b]; }));
      this._status(copy ? '已复制所选折痕' : '已平移所选折痕');
      return;
    }
    if (op.kind === 'box') {
      this.op = null;
      var a = this.toPaper(op.s0), b = this.toPaper(op.s1);
      if (OG.dist(op.s0, op.s1) < 3) { if (!op.add) { this.sel = {}; this._emitSel(); } return; }
      var x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]), bw = Math.abs(a[0] - b[0]), bh = Math.abs(a[1] - b[1]);
      var crossing = op.s1[0] < op.s0[0];
      var ns = op.add ? this.sel : {};
      this.doc.lines.forEach(function (l, i) {
        if (l.type === 'B') return;
        var inside = function (p) { return p[0] >= x0 && p[0] <= x0 + bw && p[1] >= y0 && p[1] <= y0 + bh; };
        if (crossing ? !!clipRect(l.a, l.b, bw, bh, x0, y0) : (inside(l.a) && inside(l.b))) ns[i] = true;
      });
      this.sel = ns; this._emitSel();
      return;
    }
    if (op.kind === 'brush') {
      this.op = null;
      var marked = op.marked, keys = Object.keys(marked);
      if (!keys.length) return;
      // 「改类型」是点一下改一条：只在“点”而不是“划过”时，收窄成离点击处最近的那一条，
      // 否则多层折痕重叠的地方一点会改掉一串折痕（分步折叠里会连带改好几步）。
      if (op.mode !== 'erase' && op.path && op.path.length <= 2 && keys.length > 1) {
        var pp = this.toPaper(s), bestK = null, bestD = Infinity;
        keys.forEach(function (k) {
          var l = self.doc.lines[+k];
          var d = OG.pointSegDist(pp, l.a, l.b);
          if (d < bestD) { bestD = d; bestK = k; }
        });
        var one = {}; if (bestK !== null) one[bestK] = true;
        marked = one; keys = Object.keys(marked);
        if (!keys.length) return;
      }
      if (op.mode === 'erase') {
        this._commit(this.doc.lines.filter(function (l, i) { return !marked[i]; }));
        this._status('已擦除 ' + keys.length + ' 条折痕');
      } else {
        var t = this.lineType, ls = clone(this.doc.lines);
        keys.forEach(function (k) {
          var l = ls[k]; l.type = t;
          if (isMV(t)) l.angle = self.defaultAngle; else delete l.angle;
        });
        this._commit(ls);
        this._status('已将 ' + keys.length + ' 条折痕改为' + NAMES[t]);
      }
    }
  };
  P._commitDraw = function (end) {
    var op = this.op; this.op = null;
    if (!op) return;
    var a = op.start, b = end;
    if (OG.dist(a, b) * this.scale < 2) { this._status('线段过短，已忽略'); return; }
    var c = clipRect(a, b, this.doc.width, this.doc.height);
    if (!c || OG.dist(c[0], c[1]) < 1e-9) { this._status('线段在纸张外，已忽略'); return; }
    this._commit(this.doc.lines.concat([this._mkLine(c[0], c[1])]));
    this._status('已添加' + NAMES[this.lineType] + (/线$/.test(NAMES[this.lineType]) ? '' : '线'));
  };

  /* ------------------------------ status ------------------------------ */
  P._toolHint = function () {
    var t = this.tool, tn = NAMES[this.lineType], n = this.picks.length;
    switch (t) {
      case 'line': return this.op ? '画线（' + tn + '）：点击终点完成 · Shift 锁定 22.5° · Esc 取消'
        : '画线（' + tn + '）：点击起点和终点或直接拖动 · Shift 锁定 22.5° · 1–6 / M V F U 切换类型';
      case 'select': return '选择：点击选中（Shift 加选），拖动空白框选（→ 完全包含 / ← 相交），拖动顶点移动端点，拖动选中线平移（Alt 复制）';
      case 'erase': return '擦除：点击折痕删除，或按住拖动划过多条折痕';
      case 'type': return '改类型：点击或划过折痕，将其改为' + tn;
      case 'bisector':
        if (!n) return '角平分线：依次点击三个点（第二点为角顶点），或点击两条线';
        if (this.picks[0].kind === 'point') return '角平分线：已选 ' + n + ' 个点，' + (n === 1 ? '请点击角顶点' : '请点击第三个点');
        return '角平分线：请点击第二条线 · Alt 延伸到纸边';
      case 'perp':
        if (!n) return '垂线：点击一个点和一条线（顺序任意）';
        return this.picks[0].kind === 'point' ? '垂线：请点击一条线' : '垂线：请点击一个点';
      case 'pbisect': return n ? '中垂线：请点击第二个点 · Alt 延伸到纸边' : '中垂线：点击两个点';
      case 'mirror':
        var sc = Object.keys(this.sel).length;
        return sc ? '镜像：点击对称轴（已选 ' + sc + ' 条，Shift+点击 增减选择）' : '镜像：先点击要镜像的折痕（Shift+点击 多选），再点击对称轴';
      case 'ray': return n ? '延长至边界：点击方向点（Shift 22.5°），折痕延伸到遇到的第一条线 · Alt 直达纸边' : '延长至边界：点击起点';
      case 'pan': return '平移：拖动画布 · 滚轮缩放 · 0 键适应窗口';
    }
    return '';
  };
  P._status = function (msg) {
    var parts = [msg || this._toolHint()];
    if (this.mouse) {
      var sn = this.hover.snap, p = sn ? sn.p : this.toPaper(this.mouse);
      parts.push('x ' + p[0].toFixed(4) + '  y ' + p[1].toFixed(4));
      if (sn && SNAP_NAMES[sn.kind]) parts.push('吸附：' + SNAP_NAMES[sn.kind]);
      var seg = this._activeSegment();
      if (seg) parts.push(this._segReadout(seg[0], seg[1]));
    }
    var text = parts.join('  ·  ');
    if (msg) this._flash = { text: msg, until: Date.now() + 1600 };
    if (text !== this._lastStatus) { this._lastStatus = text; this.onStatus(text); }
  };
  P._segReadout = function (a, b) {
    var d = OG.sub(b, a), L = OG.len(d), ang = Math.atan2(-d[1], d[0]) * 180 / Math.PI;
    if (ang < 0) ang += 360; if (ang >= 359.995) ang = 0;
    return '长度 ' + fmtNum(L, 4) + '  角度 ' + fmtNum(ang, 2) + '°';
  };
  P._activeSegment = function () {
    if (this.op && this.op.kind === 'draw' && this.op.end) return [this.op.start, this.op.end];
    return null;
  };

  /* ------------------------------ rendering ------------------------------ */
  P._draw = function () {
    if (this._raf || this._destroyed) return;
    var self = this;
    if (typeof requestAnimationFrame === 'undefined') { this._render(); return; }
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._render(); });
  };
  P.render = function () { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } this._render(); };
  P.redraw = function () { this._rebuild(); this._draw(); };

  function strokeLines(ctx, lines, map, k, filter) {
    // lines: [{a,b,type}] ; map: paper->screen ; k: width multiplier
    DRAW_ORDER.forEach(function (t) {
      var st = STYLE[t], any = false;
      ctx.beginPath();
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (l.type !== t || (filter && !filter(l, i))) continue;
        var a = map(l.a), b = map(l.b);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); any = true;
      }
      if (!any) return;
      ctx.strokeStyle = COLORS[t];
      ctx.lineWidth = st.w * k;
      ctx.setLineDash(st.dash.map(function (x) { return x * k; }));
      ctx.lineCap = st.dash.length ? 'butt' : 'round';
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  P._render = function () {
    var ctx = this.ctx, W = this.cssW, H = this.cssH, dpr = this.dpr, self = this;
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round';
    var map = function (p) { return [self.ox + p[0] * self.scale, self.oy + p[1] * self.scale]; };
    // background
    var bg = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#f6f4ee'); bg.addColorStop(1, '#e6e3db');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    var dw = this.doc.width, dh = this.doc.height, p0 = map([0, 0]), p1 = map([dw, dh]);
    var sw = p1[0] - p0[0], sh = p1[1] - p0[1];
    // paper
    ctx.save();
    ctx.shadowColor = 'rgba(70,55,30,0.16)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#fffdf8'; ctx.fillRect(p0[0], p0[1], sw, sh);
    ctx.restore();
    ctx.save();
    ctx.shadowColor = 'rgba(70,55,30,0.10)'; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#fffdf8'; ctx.fillRect(p0[0], p0[1], sw, sh);
    ctx.restore();
    // grid
    if (this._gridLines.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(p0[0], p0[1], sw, sh); ctx.clip();
      var minor = [], major = [], n = this.grid.divisions;
      this._gridLines.forEach(function (g) {
        var isMajor = self.grid.type === 'square' && g[3] && (g[2] * 2 === g[3] || (g[3] % 4 === 0 && g[2] * 4 % g[3] === 0));
        (isMajor ? major : minor).push(g);
      });
      var gstep = Math.min(sw, sh) / Math.max(1, n);
      ctx.lineWidth = 1;
      ctx.strokeStyle = gstep < 6 ? 'rgba(160,145,115,0.10)' : 'rgba(160,145,115,0.22)';
      ctx.beginPath();
      minor.forEach(function (g) { var a = map(g[0]), b = map(g[1]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
      ctx.strokeStyle = 'rgba(150,130,95,0.34)';
      ctx.beginPath();
      major.forEach(function (g) { var a = map(g[0]), b = map(g[1]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
      ctx.restore();
    }
    if (this.showLabels) this._drawLabels(ctx, map, p0, p1);

    var lines = this.doc.lines, op = this.op, hv = this.hover;
    var hideIdx = {};
    if (op && op.kind === 'vertex' && op.moved) for (var k1 in op.att) hideIdx[k1] = true;
    if (op && op.kind === 'move' && op.moved && !this.keys.alt) for (var k2 in this.sel) hideIdx[k2] = true;

    // selection glow
    var selKeys = Object.keys(this.sel);
    if (selKeys.length) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,176,32,0.55)'; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(255,160,0,0.9)'; ctx.shadowBlur = 10;
      ctx.beginPath();
      selKeys.forEach(function (k) { if (hideIdx[k]) return; var l = lines[k]; if (!l) return; var a = map(l.a), b = map(l.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
      ctx.restore();
    }
    // brush marks
    if (op && op.kind === 'brush') {
      ctx.save();
      ctx.strokeStyle = op.mode === 'erase' ? 'rgba(229,72,77,0.30)' : this._tint(COLORS[this.lineType], 0.3);
      ctx.lineWidth = 10; ctx.lineCap = 'round';
      ctx.beginPath();
      Object.keys(op.marked).forEach(function (k) { var l = lines[k]; var a = map(l.a), b = map(l.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
      ctx.restore();
    }
    // hover highlight
    if (hv.line >= 0 && lines[hv.line] && !(op && (op.kind === 'move' || op.kind === 'vertex') && op.moved)) {
      var hl = lines[hv.line], ha = map(hl.a), hb = map(hl.b);
      ctx.save();
      var hcol = 'rgba(70,130,255,0.22)';
      if (this.tool === 'erase') hcol = 'rgba(229,72,77,0.28)';
      else if (this.tool === 'type') hcol = this._tint(COLORS[this.lineType], 0.3);
      else if (this.tool === 'mirror' && Object.keys(this.sel).length && !this.keys.shift) hcol = 'rgba(124,92,255,0.30)';
      ctx.strokeStyle = hcol; ctx.lineWidth = 11; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(ha[0], ha[1]); ctx.lineTo(hb[0], hb[1]); ctx.stroke();
      ctx.restore();
    }
    // creases
    strokeLines(ctx, lines, map, 1, function (l, i) { return !hideIdx[i]; });

    // vertex dots
    if (this.tool === 'select') {
      ctx.fillStyle = 'rgba(31,35,40,0.55)';
      ctx.beginPath();
      this._verts.forEach(function (v) {
        if (!v.lines.some(function (k) { return lines[k].type !== 'B'; })) return;
        var s = map(v.p); ctx.moveTo(s[0] + 2.2, s[1]); ctx.arc(s[0], s[1], 2.2, 0, Math.PI * 2);
      });
      ctx.fill();
    }

    // validation markers
    if (this.validation && this.validation.vertices) this._drawValidation(ctx, map);

    // operation previews
    this._drawOverlay(ctx, map);
  };
  P._tint = function (hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  };
  P._drawLabels = function (ctx, map, p0, p1) {
    var n = this.grid.divisions || 4, w = this.doc.width, h = this.doc.height;
    if (this.grid.type === 'triangle') n = this.grid.divisions || 4;
    var step = (p1[0] - p0[0]) / n, every = Math.max(1, Math.ceil(26 / Math.max(step, 1)));
    ctx.save();
    ctx.font = '10px ' + FONT; ctx.fillStyle = '#8b8577';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (var i = 0; i <= n; i += every) { var s = map([i * w / n, 0]); ctx.fillText(frac(i, n), s[0], p0[1] - 6); }
    var ny = Math.max(1, Math.round(n * h / w));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (i = 0; i <= ny; i += every) { var t = map([0, i * h / ny]); ctx.fillText(frac(i, ny), p0[0] - 7, t[1]); }
    ctx.restore();
  };
  P._drawValidation = function (ctx, map) {
    var vs = this.validation.vertices, hoverV = null, m = this.mouse;
    ctx.save();
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i], s = map(v.p);
      if (s[0] < -20 || s[1] < -20 || s[0] > this.cssW + 20 || s[1] > this.cssH + 20) continue;
      ctx.beginPath();
      if (v.ok) {
        ctx.arc(s[0], s[1], 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(47,179,109,0.14)'; ctx.fill();
        ctx.strokeStyle = '#2fb36d'; ctx.lineWidth = 1.5; ctx.stroke();
      } else {
        ctx.arc(s[0], s[1], 7, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(229,72,77,0.18)'; ctx.fill();
        ctx.strokeStyle = '#d93036'; ctx.lineWidth = 2; ctx.stroke();
      }
      if (m && OG.dist(m, s) < 9 && (!hoverV || OG.dist(m, s) < hoverV.d)) hoverV = { v: v, s: s, d: OG.dist(m, s) };
    }
    ctx.restore();
    if (hoverV && !this.op) {
      var v2 = hoverV.v, linesTxt = [];
      linesTxt.push(v2.ok ? '✓ 局部可平折' : '✗ 不满足平折条件');
      var mv = v2.mv || [0, 0];
      linesTxt.push('Maekawa：山 ' + mv[0] + ' / 谷 ' + mv[1] + '  ' + (v2.maekawa ? '✓' : '✗ (|M−V|≠2)'));
      var ke = (v2.kawasakiError || 0) * 180 / Math.PI;
      linesTxt.push('Kawasaki：误差 ' + fmtNum(ke, 3) + '°  ' + (v2.kawasaki ? '✓' : '✗'));
      linesTxt.push('位置 (' + v2.p[0].toFixed(4) + ', ' + v2.p[1].toFixed(4) + ')');
      this._tooltip(ctx, hoverV.s[0] + 14, hoverV.s[1] + 14, linesTxt, v2.ok ? '#2fb36d' : '#d93036');
    }
  };
  P._tooltip = function (ctx, x, y, lines, accent) {
    ctx.save();
    ctx.font = '12px ' + FONT;
    var w = 0, lh = 18;
    lines.forEach(function (t) { w = Math.max(w, ctx.measureText(t).width); });
    var bw = w + 20, bh = lines.length * lh + 10;
    if (x + bw > this.cssW - 4) x = this.cssW - 4 - bw;
    if (y + bh > this.cssH - 4) y = y - bh - 28;
    if (x < 4) x = 4; if (y < 4) y = 4;
    ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    roundRect(ctx, x, y, bw, bh, 7); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1; ctx.stroke();
    if (accent) { ctx.fillStyle = accent; roundRect(ctx, x, y + 6, 3, bh - 12, 1.5); ctx.fill(); }
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    lines.forEach(function (t, i) {
      ctx.fillStyle = i === 0 && accent ? accent : '#2b2f36';
      ctx.font = (i === 0 ? '600 12px ' : '12px ') + FONT;
      ctx.fillText(t, x + 11, y + 5 + lh * i + lh / 2);
    });
    ctx.restore();
  };
  P._snapGlyph = function (ctx, s, kind) {
    var x = s[0], y = s[1];
    ctx.save();
    ctx.strokeStyle = ACCENT; ctx.fillStyle = ACCENT; ctx.lineWidth = 1.8;
    ctx.beginPath();
    switch (kind) {
      case 'vertex':
        ctx.arc(x, y, 6.5, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill(); break;
      case 'midpoint':
        ctx.moveTo(x, y - 7); ctx.lineTo(x + 6.5, y + 4.5); ctx.lineTo(x - 6.5, y + 4.5); ctx.closePath(); ctx.stroke(); break;
      case 'grid':
        ctx.rect(x - 5, y - 5, 10, 10); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); break;
      case 'intersection':
        ctx.moveTo(x - 5.5, y - 5.5); ctx.lineTo(x + 5.5, y + 5.5); ctx.moveTo(x + 5.5, y - 5.5); ctx.lineTo(x - 5.5, y + 5.5); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.stroke(); break;
      case 'online':
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke(); break;
      case 'angle':
        ctx.setLineDash([2, 2]); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); break;
      default:
        ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(40,40,40,0.55)';
        ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke();
    }
    if (SNAP_NAMES[kind]) {
      ctx.font = '600 10px ' + FONT; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
      var tw = ctx.measureText(SNAP_NAMES[kind]).width;
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      roundRect(ctx, x + 8, y - 22, tw + 8, 15, 4); ctx.fill();
      ctx.fillStyle = ACCENT; ctx.fillText(SNAP_NAMES[kind], x + 12, y - 9);
    }
    ctx.restore();
  };
  P._previewSeg = function (ctx, map, a, b, type, alpha) {
    var sa = map(a), sb = map(b), st = STYLE[type];
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 0.9 : alpha;
    ctx.strokeStyle = this._tint(COLORS[type], 0.22); ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
    ctx.strokeStyle = COLORS[type]; ctx.lineWidth = st.w + 0.4; ctx.setLineDash(st.dash.length ? st.dash : []);
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
    ctx.restore();
  };
  P._readout = function (ctx, at, a, b) {
    var txt = this._segReadout(a, b);
    ctx.save();
    ctx.font = '600 11px ' + FONT;
    var tw = ctx.measureText(txt).width, x = at[0] + 16, y = at[1] + 14;
    if (x + tw + 14 > this.cssW) x = at[0] - tw - 28;
    if (y + 22 > this.cssH) y = at[1] - 36;
    ctx.shadowColor = 'rgba(0,0,0,0.14)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(32,36,44,0.9)';
    roundRect(ctx, x, y, tw + 14, 21, 6); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x + 7, y + 11);
    ctx.restore();
  };
  P._pickMarker = function (ctx, s, label) {
    ctx.save();
    ctx.fillStyle = '#7c5cff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (label) {
      ctx.font = '700 10px ' + FONT; ctx.fillStyle = '#7c5cff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(label, s[0] + 7, s[1] + 5);
    }
    ctx.restore();
  };
  P._drawOverlay = function (ctx, map) {
    var op = this.op, hv = this.hover, self = this, lines = this.doc.lines;
    // angle labels at hovered vertex
    if (this.showAngles && !op && !this.picks.length && hv.vertex && this.tool !== 'pan') this._drawAngles(ctx, map, hv.vertex);
    else if (hv.vertex && this.tool === 'select' && !op) {
      var vs = map(hv.vertex.p);
      ctx.save(); ctx.strokeStyle = '#3e7bfa'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(vs[0], vs[1], 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    if (op && op.kind === 'draw') {
      var e = op.end || op.start;
      this._previewSeg(ctx, map, op.start, e, this.lineType);
      this._pickMarker(ctx, map(op.start));
      if (this.keys.shift) this._angleGuide(ctx, map, op.start);
      if (OG.dist(op.start, e) > 1e-9) this._readout(ctx, map(e), op.start, e);
    }
    if (op && op.kind === 'vertex' && op.moved) {
      var vlines = [];
      lines.forEach(function (l, i) {
        if (!op.att[i]) return;
        var a = OG.dist(l.a, op.p0) < 1e-9 ? op.cur : l.a, b = OG.dist(l.b, op.p0) < 1e-9 ? op.cur : l.b;
        vlines.push({ a: a, b: b, type: l.type });
      });
      ctx.save(); ctx.globalAlpha = 0.9; strokeLines(ctx, vlines, map, 1); ctx.restore();
      var c0 = map(op.p0);
      ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(c0[0], c0[1], 5, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      this._pickMarker(ctx, map(op.cur));
    }
    if (op && op.kind === 'move' && op.moved) {
      var ml = [];
      this._selLines().forEach(function (l) { ml.push({ a: OG.add(l.a, op.delta), b: OG.add(l.b, op.delta), type: l.type }); });
      ctx.save();
      ctx.strokeStyle = 'rgba(255,176,32,0.45)'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath();
      ml.forEach(function (l) { var a = map(l.a), b = map(l.b); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke(); ctx.restore();
      strokeLines(ctx, ml, map, 1);
      this._readout(ctx, map(OG.add(op.grab, op.delta)), op.grab, OG.add(op.grab, op.delta));
    }
    if (op && op.kind === 'box') {
      var x = Math.min(op.s0[0], op.s1[0]), y = Math.min(op.s0[1], op.s1[1]), w = Math.abs(op.s1[0] - op.s0[0]), h = Math.abs(op.s1[1] - op.s0[1]);
      var crossing = op.s1[0] < op.s0[0];
      ctx.save();
      ctx.fillStyle = crossing ? 'rgba(47,179,109,0.08)' : 'rgba(62,123,250,0.08)';
      ctx.strokeStyle = crossing ? '#2fb36d' : '#3e7bfa'; ctx.lineWidth = 1;
      if (crossing) ctx.setLineDash([5, 3]);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.restore();
    }
    if (op && op.kind === 'brush' && op.path.length > 1) {
      ctx.save();
      ctx.strokeStyle = op.mode === 'erase' ? 'rgba(229,72,77,0.6)' : this._tint(COLORS[this.lineType], 0.6);
      ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(op.path[0][0], op.path[0][1]);
      op.path.forEach(function (s) { ctx.lineTo(s[0], s[1]); });
      ctx.stroke(); ctx.restore();
    }
    // construction tools
    if (this._needs()) {
      this.picks.forEach(function (pk, i) {
        if (pk.kind === 'point') self._pickMarker(ctx, map(pk.p), String(i + 1));
        else {
          var a = map(pk.a), b = map(pk.b);
          ctx.save(); ctx.strokeStyle = 'rgba(124,92,255,0.45)'; ctx.lineWidth = 9; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.restore();
          self._pickMarker(ctx, map(pk.at), String(i + 1));
        }
      });
      if (hv.pick && this.mouse) {
        var res = this._construct(this.picks.concat([hv.pick]));
        if (res) {
          res.forEach(function (sg) { self._previewSeg(ctx, map, sg[0], sg[1], sg[2] || self.lineType, 0.75); });
          if (res.length === 1 && this.tool !== 'mirror') {
            this._pickMarker(ctx, map(res[0][1]));
            this._readout(ctx, this.mouse, res[0][0], res[0][1]);
          }
        }
        if (this.tool === 'ray' && this.picks.length && this.keys.shift) this._angleGuide(ctx, map, this.picks[0].p);
      }
    }
    // snap indicator
    if (this.mouse && hv.snap && !this.panning && this.tool !== 'pan' && !this.keys.space) this._snapGlyph(ctx, map(hv.snap.p), hv.snap.kind);
    // transient message
    if (this._flash && Date.now() < this._flash.until) {
      ctx.save();
      ctx.font = '600 12px ' + FONT;
      var tw = ctx.measureText(this._flash.text).width, fx = (this.cssW - tw) / 2 - 12;
      ctx.fillStyle = 'rgba(32,36,44,0.82)'; roundRect(ctx, fx, 12, tw + 24, 26, 13); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(this._flash.text, fx + 12, 25);
      ctx.restore();
      var me = this;
      clearTimeout(this._flashT);
      this._flashT = setTimeout(function () { me._draw(); }, this._flash.until - Date.now() + 20);
    }
  };
  P._angleGuide = function (ctx, map, o) {
    var s = map(o), R = 46;
    ctx.save();
    ctx.strokeStyle = 'rgba(240,109,31,0.28)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s[0], s[1], R, 0, Math.PI * 2); ctx.stroke();
    for (var i = 0; i < 16; i++) {
      var a = i * Math.PI / 8, r0 = i % 2 ? R - 4 : R - 8;
      ctx.moveTo(s[0] + Math.cos(a) * r0, s[1] + Math.sin(a) * r0); ctx.lineTo(s[0] + Math.cos(a) * R, s[1] + Math.sin(a) * R);
    }
    ctx.stroke();
    ctx.restore();
  };
  P._drawAngles = function (ctx, map, v) {
    var lines = this.doc.lines, p = v.p, s = map(p), dirs = [];
    v.lines.forEach(function (k) {
      var l = lines[k], q = OG.dist(l.a, p) < 1e-9 ? l.b : l.a;
      dirs.push({ ang: Math.atan2(q[1] - p[1], q[0] - p[0]), type: l.type });
    });
    if (!dirs.length) return;
    dirs.sort(function (a, b) { return a.ang - b.ang; });
    ctx.save();
    ctx.strokeStyle = '#3e7bfa'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s[0], s[1], 5.5, 0, Math.PI * 2); ctx.stroke();
    if (dirs.length >= 2) {
      var n = dirs.length, R = 26;
      ctx.font = '600 10px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (var i = 0; i < n; i++) {
        var a0 = dirs[i].ang, a1 = dirs[(i + 1) % n].ang, sec = a1 - a0;
        if (sec <= 1e-9) sec += Math.PI * 2;
        if (sec > Math.PI * 2 - 1e-6) continue;
        // skip outside-of-paper sector at boundary vertices
        var mid = a0 + sec / 2, probe = [p[0] + Math.cos(mid) * 1e-4, p[1] + Math.sin(mid) * 1e-4];
        if (probe[0] < 0 || probe[1] < 0 || probe[0] > this.doc.width || probe[1] > this.doc.height) continue;
        ctx.strokeStyle = i % 2 ? 'rgba(62,123,250,0.55)' : 'rgba(229,72,77,0.55)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s[0], s[1], R - 6 + (i % 2) * 3, a0, a0 + sec); ctx.stroke();
        var deg = sec * 180 / Math.PI, txt = fmtNum(deg, 1) + '°';
        var rr = R + 14 + (sec < 0.5 ? 10 : 0), tx = s[0] + Math.cos(mid) * rr, ty = s[1] + Math.sin(mid) * rr;
        var tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(255,255,255,0.9)'; roundRect(ctx, tx - tw / 2 - 4, ty - 8, tw + 8, 16, 4); ctx.fill();
        ctx.fillStyle = '#3a3f47'; ctx.fillText(txt, tx, ty);
      }
    }
    ctx.restore();
  };

  /* ------------------------------ export ------------------------------ */
  P.exportPNG = function (o) {
    o = o || {};
    var size = o.size || 1200, pad = o.padding === undefined ? Math.round(size * 0.04) : o.padding;
    var w = this.doc.width, h = this.doc.height, k = (size - 2 * pad) / Math.max(w, h);
    var cw = Math.round(w * k + 2 * pad), ch = Math.round(h * k + 2 * pad);
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var ctx = c.getContext('2d'), lw = Math.max(1, size / 600);
    ctx.fillStyle = o.background || '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#fffdf8'; ctx.fillRect(pad, pad, w * k, h * k);
    var map = function (p) { return [pad + p[0] * k, pad + p[1] * k]; };
    ctx.lineJoin = 'round';
    strokeLines(ctx, this.doc.lines, map, lw);
    return c.toDataURL('image/png');
  };

  global.CPEditor = CPEditor;
})(typeof window !== 'undefined' ? window : globalThis);
