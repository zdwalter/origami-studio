/*
 * stepfold.js — flat-folding engine for the "分步折叠" mode (pure logic, no DOM; loads in Node).
 *
 * A folded state is a stack of flat facets. Each facet:
 *   { id, poly: [[x,y]..] polygon in ORIGINAL paper coords (y down),
 *     T: {m:[a,b,c,d], t:[e,f]}  isometry paper → folded plane (x' = a x + c y + e, y' = b x + d y + f),
 *     layer: number (higher = closer to the viewer) }
 * det(T) < 0 means the facet shows its BACK side to the viewer.
 * Creases are recorded in paper coordinates with M/V as seen on the paper FRONT.
 */
(function (global) {
  'use strict';
  var OG = global.OG;
  var EPS = 1e-9;

  // ---------------------------------------------------------------- affine helpers
  var I = function () { return { m: [1, 0, 0, 1], t: [0, 0] }; };
  function apply(T, p) { var m = T.m; return [m[0] * p[0] + m[2] * p[1] + T.t[0], m[1] * p[0] + m[3] * p[1] + T.t[1]]; }
  function compose(A, B) { // A ∘ B
    var a = A.m, b = B.m;
    return { m: [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]], t: apply(A, B.t) };
  }
  function invert(T) {
    var m = T.m, det = m[0] * m[3] - m[1] * m[2];
    var im = [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
    var it = [-(im[0] * T.t[0] + im[2] * T.t[1]), -(im[1] * T.t[0] + im[3] * T.t[1])];
    return { m: im, t: it };
  }
  function det(T) { return T.m[0] * T.m[3] - T.m[1] * T.m[2]; }
  function reflection(a, b) {
    var u = OG.norm(OG.sub(b, a)), ux = u[0], uy = u[1];
    var m = [2 * ux * ux - 1, 2 * ux * uy, 2 * ux * uy, 2 * uy * uy - 1];
    var R = { m: m, t: [0, 0] };
    var ra = apply(R, a);
    R.t = [a[0] - ra[0], a[1] - ra[1]];
    return R;
  }
  function rotation(deg, c) {
    var r = deg * Math.PI / 180, co = Math.cos(r), s = Math.sin(r);
    var R = { m: [co, s, -s, co], t: [0, 0] };
    var rc = apply(R, c); R.t = [c[0] - rc[0], c[1] - rc[1]];
    return R;
  }
  function mirrorX(cx) { return { m: [-1, 0, 0, 1], t: [2 * cx, 0] }; }
  function cloneT(T) { return { m: T.m.slice(), t: T.t.slice() }; }

  // ---------------------------------------------------------------- polygon helpers
  function clipHalf(poly, a, b, keepSign) {
    // keep part where sign(orient(a,b,p)) == keepSign (or on the line)
    var out = [], n = poly.length, L = OG.dist(a, b);
    for (var i = 0; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      var dp = OG.orient(a, b, p) / L * keepSign, dq = OG.orient(a, b, q) / L * keepSign;
      if (dp >= -EPS) out.push(p);
      if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
        var t = dp / (dp - dq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    return cleanPoly(out);
  }
  function cleanPoly(poly) {
    var out = [];
    poly.forEach(function (p) { if (!out.length || OG.dist(out[out.length - 1], p) > 1e-9) out.push(p); });
    if (out.length > 1 && OG.dist(out[0], out[out.length - 1]) < 1e-9) out.pop();
    // drop collinear points
    var changed = true;
    while (changed && out.length > 3) {
      changed = false;
      for (var i = 0; i < out.length; i++) {
        var a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
        if (Math.abs(OG.orient(a, c, b)) / Math.max(OG.dist(a, c), 1e-12) < 1e-10) { out.splice(i, 1); changed = true; break; }
      }
    }
    return out.length >= 3 && Math.abs(OG.polyArea(out)) > 1e-12 ? out : null;
  }
  function sideOf(poly, a, b) { // -1 / 0 (straddles) / +1
    var L = OG.dist(a, b), pos = false, neg = false;
    poly.forEach(function (p) { var d = OG.orient(a, b, p) / L; if (d > 1e-7) pos = true; else if (d < -1e-7) neg = true; });
    return pos && neg ? 0 : pos ? 1 : neg ? -1 : 0;
  }
  function insidePoly(p, poly) {
    return OG.pointInPoly(p, poly) || OG.pointOnPolyBoundary(p, poly, 1e-6);
  }
  /** 折叠平面里两个多边形是否接触/重叠（用来把“抓起来的那摞纸”聚成一团） */
  function polysTouch(A, B) {
    var i, j, a0, a1, b0, b1;
    for (i = 0; i < A.length; i++) if (insidePoly(A[i], B)) return true;
    for (j = 0; j < B.length; j++) if (insidePoly(B[j], A)) return true;
    function segX(p1, p2, p3, p4) {
      var d1 = OG.orient(p3, p4, p1), d2 = OG.orient(p3, p4, p2), d3 = OG.orient(p1, p2, p3), d4 = OG.orient(p1, p2, p4);
      return d1 * d2 < 1e-14 && d3 * d4 < 1e-14;
    }
    for (i = 0; i < A.length; i++) {
      a0 = A[i]; a1 = A[(i + 1) % A.length];
      for (j = 0; j < B.length; j++) {
        b0 = B[j]; b1 = B[(j + 1) % B.length];
        if (segX(a0, a1, b0, b1)) return true;
        if (OG.pointSegDist(a0, b0, b1) < 1e-6 || OG.pointSegDist(b0, a0, a1) < 1e-6) return true;
      }
    }
    return false;
  }

  /** 在折叠平面里判断每片纸是否“露在最上面”（没有更高层的纸盖住它） */
  function exposedFlags(facets) {
    var polys = facets.map(function (f) { return folded(f); });
    return facets.map(function (f, i) {
      var c = [0, 0];
      polys[i].forEach(function (q) { c[0] += q[0]; c[1] += q[1]; });
      c[0] /= polys[i].length; c[1] /= polys[i].length;
      for (var j = 0; j < facets.length; j++) {
        if (j === i || facets[j].layer <= f.layer) continue;
        if (insidePoly(c, polys[j])) return false;
      }
      return true;
    });
  }

  // do two polygons (paper coords) share a boundary segment of positive length?
  function shareEdge(A, B) {
    for (var i = 0; i < A.length; i++) {
      var a0 = A[i], a1 = A[(i + 1) % A.length], la = OG.dist(a0, a1);
      for (var j = 0; j < B.length; j++) {
        var b0 = B[j], b1 = B[(j + 1) % B.length];
        if (Math.abs(OG.orient(a0, a1, b0)) / la > 1e-7 || Math.abs(OG.orient(a0, a1, b1)) / la > 1e-7) continue;
        var d = OG.sub(a1, a0);
        var t0 = OG.dot(OG.sub(b0, a0), d) / (la * la), t1 = OG.dot(OG.sub(b1, a0), d) / (la * la);
        var lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
        if ((hi - lo) * la > 1e-6) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- state
  function create(opts) {
    opts = opts || {};
    var w = opts.width || 1, h = opts.height || 1;
    return { width: w, height: h, nextId: 1, facets: [{ id: 0, poly: [[0, 0], [w, 0], [w, h], [0, h]], T: I(), layer: 0 }], creases: [] };
  }
  function clone(s) {
    return { width: s.width, height: s.height, nextId: s.nextId, foldCount: s.foldCount || 0,
      facets: s.facets.map(function (f) { return { id: f.id, poly: f.poly.map(function (p) { return p.slice(); }), T: cloneT(f.T), layer: f.layer }; }),
      creases: s.creases.map(function (c) {
        return { a: c.a.slice(), b: c.b.slice(), type: c.type, angle: c.angle == null ? 180 : c.angle,
          stage: c.stage, foldAngle: c.foldAngle };
      }),
      snaps: (s.snaps || []).map(function (snap) {
        return snap.map(function (f) { return { id: f.id, poly: f.poly.map(function (p) { return p.slice(); }), T: cloneT(f.T), layer: f.layer }; });
      }) };
  }
  function compactLayers(s) {
    var order = s.facets.slice().sort(function (a, b) { return a.layer - b.layer; });
    var rank = 0, prev = null;
    order.forEach(function (f) { if (prev !== null && f.layer !== prev) rank++; prev = f.layer; f.layer = rank; });
  }
  function folded(f) { return f.poly.map(function (p) { return apply(f.T, p); }); }
  function isFlipped(f) { return det(f.T) < 0; }

  function bounds(s) {
    var mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
    s.facets.forEach(function (f) { folded(f).forEach(function (p) { mn[0] = Math.min(mn[0], p[0]); mn[1] = Math.min(mn[1], p[1]); mx[0] = Math.max(mx[0], p[0]); mx[1] = Math.max(mx[1], p[1]); }); });
    return { min: mn, max: mx, center: [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2], width: mx[0] - mn[0], height: mx[1] - mn[1] };
  }

  /** Topmost facet id at folded-plane point p (or -1). */
  function hitFacet(s, p) {
    var best = -1, bl = -Infinity;
    s.facets.forEach(function (f) { if (f.layer > bl && insidePoly(p, folded(f))) { bl = f.layer; best = f.id; } });
    return best;
  }

  /**
   * Fold. op = { a, b (fold line, folded-plane coords), side: [x,y] point on the moving side,
   *              kind: 'valley'|'mountain', scope: 'all'|'top'|'bottom' }
   * Returns { state, moved:[ids], creases:[...] } or { error }.
   */
  function fold(state, op) {
    var a = op.a, b = op.b;
    if (!a || !b || OG.dist(a, b) < 1e-6) return { error: '折线太短' };
    var sidePt = op.side;
    var sgn = Math.sign(OG.orient(a, b, sidePt));
    if (!sgn) return { error: '请选择折线的一侧' };
    var kind = op.kind === 'mountain' ? 'mountain' : 'valley';
    var s = clone(state);
    // 这一折的折角（默认 180° = 折平）与折叠序号：写进折痕里，3D 仿真可以按顺序折
    s.pendingAngle = (op.angle !== undefined && op.angle !== null) ? op.angle : 180;
    s.foldCount = (s.foldCount || 0) + 1;
    // 记住折叠前的几何，供“折一下再打开（留折痕）”和“打开”使用
    s.snaps = (state.snaps || []).concat([state.facets.map(function (f) {
      return { id: f.id, poly: f.poly.map(function (q) { return q.slice(); }), T: cloneT(f.T), layer: f.layer };
    })]);
    // 1. split every facet into stationary / moving pieces (virtually)
    var pieces = []; // {parent, poly(paper), moving:bool}
    s.facets.forEach(function (f) {
      var P = folded(f), sd = sideOf(P, a, b);
      if (sd === sgn) pieces.push({ parent: f, poly: f.poly, moving: true, whole: true });
      else if (sd === -sgn || sd === 0 && false) pieces.push({ parent: f, poly: f.poly, moving: false, whole: true });
      else if (sd === 0) {
        var inv = invert(f.T), pa = apply(inv, a), pb = apply(inv, b);
        // orientation of the line flips in paper coords when the facet is mirrored
        var keepMove = sgn * (isFlipped(f) ? -1 : 1);
        var mv = clipHalf(f.poly, pa, pb, keepMove), st = clipHalf(f.poly, pa, pb, -keepMove);
        if (mv && st) {
          pieces.push({ parent: f, poly: mv, moving: true, whole: false });
          pieces.push({ parent: f, poly: st, moving: false, whole: false });
        } else pieces.push({ parent: f, poly: f.poly, moving: !!mv, whole: true });
      }
    });
    // 2. choose the moving set
    var movingPieces = pieces.filter(function (p) { return p.moving; });
    if (!movingPieces.length) return { error: '折线这一侧没有纸' };
    if (op.scope === 'topSheet') {
      // 「仅最上层」：模拟真手只捏起最上面那一层往下折——
      //  1) 起点 = 点击处最上面的那片纸（按点到多边形的距离找，点在边上也算）；
      //  2) 把与它沿真实折痕（纸面共享边）连着、且在折线这一侧的纸片一起带上；
      //  3) 物理闭包：被带上的纸片如果上面（谷折）/下面（山折）还压着别的层，
      //     那些层挡在翻转路径上，也必须一起翻，否则就得穿过去——反复 2)3) 直到不再变化。
      var planePoly = {}, planeArea = {};
      s.facets.forEach(function (f) { planePoly[f.id] = folded(f); planeArea[f.id] = Math.abs(OG.polyArea(planePoly[f.id])); });
      function polyDist(p, P) {
        if (OG.pointInPoly(p, P)) return 0;
        var d = Infinity;
        for (var i = 0; i < P.length; i++) d = Math.min(d, OG.pointSegDist(p, P[i], P[(i + 1) % P.length]));
        return d;
      }
      function strictlyInside(p, P) { return OG.pointInPoly(p, P) && !OG.pointOnPolyBoundary(p, P, 1e-7); }
      function overlap(A, B) {
        // 两片纸在平面里有正面积重叠（只是边挨着不算）
        function samples(P) {
          var c = OG.polyCentroid ? OG.polyCentroid(P) : P.reduce(function (s2, q) { return [s2[0] + q[0] / P.length, s2[1] + q[1] / P.length]; }, [0, 0]);
          var out = [c];
          P.forEach(function (q) { out.push(OG.lerp(c, q, 0.9)); });
          for (var i = 0; i < P.length; i++) out.push(OG.lerp(c, OG.lerp(P[i], P[(i + 1) % P.length], 0.5), 0.9));
          return out;
        }
        var sa = samples(A), sb = samples(B), i;
        for (i = 0; i < sa.length; i++) if (strictlyInside(sa[i], B)) return true;
        for (i = 0; i < sb.length; i++) if (strictlyInside(sb[i], A)) return true;
        return false;
      }
      // 1) 起点
      var minD = Infinity;
      movingPieces.forEach(function (p) { minD = Math.min(minD, polyDist(sidePt, planePoly[p.parent.id])); });
      var seed = null;
      movingPieces.forEach(function (p) {
        if (polyDist(sidePt, planePoly[p.parent.id]) > minD + 1e-3) return;
        if (!seed || p.parent.layer > seed.parent.layer) seed = p;
      });
      if (!seed) return { error: '点击位置没有可翻折的纸层' };
      var sel = [seed];
      var blocksAbove = kind === 'valley';           // 谷折：翻片往上翻，压在它上面的层会挡路
      var changed = true;
      while (changed) {
        changed = false;
        // 2) 沿真实折痕连通
        var queue = sel.slice();
        while (queue.length) {
          var cur = queue.shift();
          movingPieces.forEach(function (p) {
            if (sel.indexOf(p) >= 0) return;
            if (!shareEdge(cur.poly, p.poly)) return;
            sel.push(p); queue.push(p); changed = true;
          });
        }
        // 3) 挡路的层一起翻
        movingPieces.forEach(function (p) {
          if (sel.indexOf(p) >= 0) return;
          var P = planePoly[p.parent.id];
          for (var k = 0; k < sel.length; k++) {
            var q = sel[k];
            var inWay = blocksAbove ? p.parent.layer > q.parent.layer : p.parent.layer < q.parent.layer;
            if (inWay && overlap(P, planePoly[q.parent.id])) { sel.push(p); changed = true; return; }
          }
        });
      }
      movingPieces.forEach(function (p) { p.selected = sel.indexOf(p) >= 0; });
    } else if (op.scope === 'top' || op.scope === 'bottom') {
      // start from the topmost (or bottom-most) moving piece under the pick point, then grow through attached paper
      var start = null, top = op.scope === 'top', bl = top ? -Infinity : Infinity;
      movingPieces.forEach(function (p) {
        var P = p.poly.map(function (q) { return apply(p.parent.T, q); });
        if ((top ? p.parent.layer > bl : p.parent.layer < bl) && insidePoly(sidePt, P)) { bl = p.parent.layer; start = p; }
      });
      if (!start) return { error: '点击位置没有可翻折的纸层' };
      // flood fill through shared paper edges among moving pieces
      var set = [start], queue = [start];
      while (queue.length) {
        var cur = queue.shift();
        movingPieces.forEach(function (p) {
          if (set.indexOf(p) >= 0) return;
          if (shareEdge(cur.poly, p.poly)) { set.push(p); queue.push(p); }
        });
      }
      movingPieces.forEach(function (p) { p.selected = set.indexOf(p) >= 0; });
    } else movingPieces.forEach(function (p) { p.selected = true; });
    // stationary pieces connected to selected moving pieces via paper edges NOT on the fold line would tear the paper;
    // for scope 'all' this cannot happen. For 'top' the flood fill already includes everything attached on the moving side.

    // 3. rebuild the facet list
    var R = reflection(a, b);
    var out = [], moved = [], creases = [];
    var maxL = -Infinity, minL = Infinity, mvMax = -Infinity, mvMin = Infinity;
    s.facets.forEach(function (f) { maxL = Math.max(maxL, f.layer); minL = Math.min(minL, f.layer); });
    s.facets.forEach(function (f) {
      var mine = pieces.filter(function (p) { return p.parent === f; });
      var mvp = mine.filter(function (p) { return p.moving && p.selected; })[0];
      if (!mvp) { out.push(f); return; }                         // untouched (whole, or not selected)
      mvMax = Math.max(mvMax, f.layer); mvMin = Math.min(mvMin, f.layer);
      if (mvp.whole) { f.moving = true; out.push(f); moved.push(f.id); return; }
      var stp = mine.filter(function (p) { return !p.moving; })[0];
      var nf = { id: s.nextId++, parent: f.id, poly: mvp.poly, T: cloneT(f.T), layer: f.layer, moving: true };
      out.push({ id: f.id, poly: stp.poly, T: f.T, layer: f.layer });
      out.push(nf); moved.push(nf.id);
    });
    if (!moved.length) return { error: '没有可翻折的纸层' };
    // 记录折痕（纸面坐标）：所有被折动的纸片，只要某条边正好落在折线上，就是一条新折痕。
    // 这样连“沿已有折痕再折一次”的情况也能记到（那种情况纸片没有被切开，只会整片移动）。
    pieces.forEach(function (p) {
      if (!p.moving || !p.selected) return;
      var f = p.parent, inv = invert(f.T), pa = apply(inv, a), pb = apply(inv, b);
      var L = OG.dist(pa, pb);
      if (L < 1e-9) return;
      var seg = p.poly.filter(function (q) { return Math.abs(OG.orient(pa, pb, q)) / L < 1e-7; });
      if (seg.length < 2) return;
      var d = OG.sub(pb, pa);
      seg.sort(function (u, v) { return OG.dot(OG.sub(u, pa), d) - OG.dot(OG.sub(v, pa), d); });
      var A2 = seg[0].slice(), B2 = seg[seg.length - 1].slice();
      // 同一条折痕只记一次（可能被相邻两片各报一次）
      var dup = creases.some(function (c) {
        return (Math.abs(c.a[0] - A2[0]) < 1e-7 && Math.abs(c.a[1] - A2[1]) < 1e-7 && Math.abs(c.b[0] - B2[0]) < 1e-7 && Math.abs(c.b[1] - B2[1]) < 1e-7) ||
               (Math.abs(c.a[0] - B2[0]) < 1e-7 && Math.abs(c.a[1] - B2[1]) < 1e-7 && Math.abs(c.b[0] - A2[0]) < 1e-7 && Math.abs(c.b[1] - A2[1]) < 1e-7);
      });
      var valleyOnFront = (kind === 'valley') !== isFlipped(f);
      if (!dup) creases.push({
        a: A2, b: B2, type: valleyOnFront ? 'V' : 'M', angle: 180,
        stage: s.foldCount || 1,                            // 第几次折（1 基），用于按顺序折
        foldAngle: (s.pendingAngle !== undefined && s.pendingAngle !== null) ? s.pendingAngle : 180  // 这一折折了多少度
      });
    });
    // 4. reflect & re-layer moving facets
    out.forEach(function (f) {
      if (!f.moving) return;
      f.T = compose(R, f.T);
      if (kind === 'valley') f.layer = maxL + 1 + (mvMax - f.layer);
      else f.layer = minL - 1 - (f.layer - mvMin);
      delete f.moving;
    });
    s.facets = out;
    s.creases = s.creases.concat(creases);
    compactLayers(s);
    return { state: s, moved: moved, creases: creases };
  }

  /** 折一下再打开：留下折痕，纸回到原样（对应图纸里的「折出折痕后展开」） */
  function crease(state, op) {
    var r = fold(state, op);
    if (r.error) return r;
    var s = r.state;
    // 折完马上打开：这条折痕在成品里是 0°（只是压了痕，没有折起来）
    s.creases = s.creases.map(function (c) {
      if (c.angle === 180 && r.creases.some(function (rc) {
        return (Math.abs(rc.a[0] - c.a[0]) < 1e-9 && Math.abs(rc.a[1] - c.a[1]) < 1e-9 && Math.abs(rc.b[0] - c.b[0]) < 1e-9 && Math.abs(rc.b[1] - c.b[1]) < 1e-9) ||
               (Math.abs(rc.a[0] - c.b[0]) < 1e-9 && Math.abs(rc.a[1] - c.b[1]) < 1e-9 && Math.abs(rc.b[0] - c.a[0]) < 1e-9 && Math.abs(rc.b[1] - c.a[1]) < 1e-9);
      })) return { a: c.a, b: c.b, type: c.type, angle: 0, stage: c.stage, foldAngle: c.foldAngle };
      return c;
    });
    var snap = s.snaps.pop();
    s.facets = snap;                 // 几何复原，折痕保留
    return { state: s, creases: r.creases, moved: [] };
  }

  /** 打开：把最近一次折叠的几何还原（折痕保留），对应图纸里的「ひらく / 展开」 */
  function unfold(state) {
    if (!state.snaps || !state.snaps.length) return { error: '已经没有可以打开的折了' };
    var s = clone(state);
    s.facets = s.snaps.pop();
    s.creases = s.creases.map(function (c) { return { a: c.a, b: c.b, type: c.type, angle: c.angle == null ? 0 : c.angle, stage: c.stage, foldAngle: c.foldAngle }; });
    return { state: s };
  }

  /** 完全复原（展开）：几何回到整张平纸，折痕全部保留下来（对应「展开看折痕图」） */
  function unfoldAll(state) {
    var s = clone(state);
    var w = s.width, h = s.height;
    s.facets = [{ id: 0, poly: [[0, 0], [w, 0], [w, h], [0, h]], T: I(), layer: 0 }];
    s.snaps = [];
    s.creases = s.creases.map(function (c) { return { a: c.a, b: c.b, type: c.type, angle: 0, stage: c.stage, foldAngle: c.foldAngle }; });
    return { state: s };
  }

  function flip(state) {
    var s = clone(state), c = bounds(s).center, M = mirrorX(c[0]);
    s.snaps = [];                    // 折叠平面一变，快照就失效
    s.facets.forEach(function (f) { f.T = compose(M, f.T); f.layer = -f.layer; });
    compactLayers(s);
    return s;
  }
  function rotate(state, deg) {
    var s = clone(state), R = rotation(deg, bounds(s).center);
    s.snaps = [];
    s.facets.forEach(function (f) { f.T = compose(R, f.T); });
    return s;
  }
  function applyOp(state, op) {
    if (!op) return { error: '无效操作' };
    if (op.type === 'flip') return { state: flip(state) };
    if (op.type === 'rotate') return { state: rotate(state, op.deg || 0) };
    if (op.type === 'crease') return crease(state, op);
    if (op.type === 'unfold') return unfold(state);
    if (op.type === 'unfoldAll') return unfoldAll(state);
    return fold(state, op);
  }

  // ---------------------------------------------------------------- fold-line constructions
  function lineFromPoints(p, q) { return { a: p.slice(), b: q.slice() }; }
  function pointToPoint(p, q) {
    var m = OG.lerp(p, q, 0.5), d = OG.perp(OG.sub(q, p));
    return { a: OG.sub(m, d), b: OG.add(m, d) };
  }
  function edgeToEdge(e1, e2) {
    var d1 = OG.norm(OG.sub(e1[1], e1[0])), d2 = OG.norm(OG.sub(e2[1], e2[0]));
    var X = OG.lineIntersect(e1[0], d1, e2[0], d2);
    if (!X) { // parallel: midline
      var off = OG.sub(e2[0], e1[0]), n = OG.perp(d1), dd = OG.dot(off, n);
      var p = OG.add(e1[0], OG.scale(n, dd / 2));
      return { a: p, b: OG.add(p, d1) };
    }
    // orient each direction from X towards the edge's midpoint so we bisect the angle "between" the edges
    var m1 = OG.lerp(e1[0], e1[1], 0.5), m2 = OG.lerp(e2[0], e2[1], 0.5);
    if (OG.dot(OG.sub(m1, X), d1) < 0) d1 = OG.scale(d1, -1);
    if (OG.dot(OG.sub(m2, X), d2) < 0) d2 = OG.scale(d2, -1);
    var bis = OG.add(d1, d2);
    if (OG.len(bis) < 1e-9) bis = OG.perp(d1);
    return { a: X, b: OG.add(X, OG.norm(bis)) };
  }

  // ---------------------------------------------------------------- queries
  function visibleFaces(s) {
    return s.facets.slice().sort(function (a, b) { return a.layer - b.layer; }).map(function (f) {
      return { id: f.id, poly: folded(f), paper: f.poly, flipped: isFlipped(f), layer: f.layer, T: f.T };
    });
  }
  function outlineEdges(s) {
    var edges = [];
    s.facets.forEach(function (f) { var P = folded(f); for (var i = 0; i < P.length; i++) edges.push([P[i], P[(i + 1) % P.length]]); });
    return edges;
  }
  function snapPoints(s) {
    var pts = [];
    function add(p, kind) { for (var i = 0; i < pts.length; i++) if (OG.dist(pts[i].p, p) < 1e-6) return; pts.push({ p: p, kind: kind }); }
    outlineEdges(s).forEach(function (e) { add(e[0], 'vertex'); });
    outlineEdges(s).forEach(function (e) { if (OG.dist(e[0], e[1]) > 0.02) add(OG.lerp(e[0], e[1], 0.5), 'midpoint'); });
    var b = bounds(s); add(b.center, 'center');
    return pts;
  }
  function totalArea(s) { var A = 0; s.facets.forEach(function (f) { A += Math.abs(OG.polyArea(f.poly)); }); return A; }
  function creasePattern(s, name) {
    var w = s.width, h = s.height;
    var lines = [{ a: [0, 0], b: [w, 0], type: 'B' }, { a: [w, 0], b: [w, h], type: 'B' }, { a: [w, h], b: [0, h], type: 'B' }, { a: [0, h], b: [0, 0], type: 'B' }];
    s.creases.forEach(function (c) {
      lines.push({
        a: c.a.slice(), b: c.b.slice(), type: c.type,
        angle: c.angle == null ? 180 : c.angle,
        stage: c.stage || 1,                                  // 第几步折出来的（按顺序折要用）
        foldAngle: c.foldAngle === undefined ? 180 : c.foldAngle  // 折这一下时用的折角
      });
    });
    return { name: name || '分步折叠折痕', description: '由分步折叠生成的折痕图', width: w, height: h, lines: lines };
  }
  function serialize(s) { return JSON.stringify(s); }
  function deserialize(str) { var s = typeof str === 'string' ? JSON.parse(str) : str; return clone(s); }


  // ---------------------------------------------------------------- 3D display pose
  // 把分步折叠的“成品”按指定折角在三维里重新摆一遍，用来“展开展示”：
  // 例如纸飞机折完后把两侧机翼的折痕从 180° 打开到 150°，就得到能看的三维飞机。
  // M3 = { R:[9] (row-major 3x3), t:[3] }  paper(x,y,0) → 3D
  function m3ident() { return { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] }; }
  function m3apply(M, p) {
    var R = M.R, t = M.t, x = p[0], y = p[1], z = p[2] || 0;
    return [R[0] * x + R[1] * y + R[2] * z + t[0], R[3] * x + R[4] * y + R[5] * z + t[1], R[6] * x + R[7] * y + R[8] * z + t[2]];
  }
  function m3mul(A, B) { // A ∘ B
    var a = A.R, b = B.R, R = new Array(9), t = [0, 0, 0], i, j;
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) R[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    var bt = m3apply(A, B.t);
    for (i = 0; i < 3; i++) t[i] = bt[i];
    return { R: R, t: t };
  }
  function m3rotAxis(axisPoint, axisDir, deg) {
    var u = OG3.norm(axisDir), c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180), v = 1 - c;
    var x = u[0], y = u[1], z = u[2];
    var R = [c + x * x * v, x * y * v - z * s, x * z * v + y * s,
      y * x * v + z * s, c + y * y * v, y * z * v - x * s,
      z * x * v - y * s, z * y * v + x * s, c + z * z * v];
    // rotation about line through axisPoint: t = p - R p
    var rp = [R[0] * axisPoint[0] + R[1] * axisPoint[1] + R[2] * axisPoint[2],
      R[3] * axisPoint[0] + R[4] * axisPoint[1] + R[5] * axisPoint[2],
      R[6] * axisPoint[0] + R[7] * axisPoint[1] + R[8] * axisPoint[2]];
    return { R: R, t: [axisPoint[0] - rp[0], axisPoint[1] - rp[1], axisPoint[2] - rp[2]] };
  }
  var OG3 = {
    norm: function (a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    cross: function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  };

  /** 按 steps 重放，返回三维显示姿态：{ polys:[{pts:[[x,y,z]..], front:[nx,ny,nz]}], bounds } */
  function threeDPose(steps, opts) {
    opts = opts || {};
    var angles = opts.angles || {};                 // { 步序号(0基): 角度 } 默认 180
    var flipDeg = opts.flipAngle === undefined ? 180 : opts.flipAngle;
    var st = create({ width: opts.width || 1, height: opts.height || 1 });
    var M = {};                                     // facet id → M3
    st.facets.forEach(function (f) { M[f.id] = m3ident(); });
    var undoStack = [], hinge = null, mirrorGroup = null;
    (steps || []).forEach(function (step, i) {
      var op = step.op || step;
      var before = st, r = applyOp(st, op);
      if (r.error) return;
      var after = r.state;
      // 新产生的纸片继承父片的三维变换（沿 parent 链找）
      after.facets.forEach(function (f) {
        if (M[f.id]) return;
        var cur = f, seen = 0;
        while (cur && !M[cur.id] && cur.parent !== undefined && seen++ < 64) cur = before.facets.filter(function (x) { return x.id === cur.parent; })[0];
        M[f.id] = (cur && M[cur.id]) ? M[cur.id] : m3ident();
      });
      if (op.type === 'fold') {
        // 折角优先级：调用参数 → 这一步自己记录的 fold 角度 → 180°（完全折平）
        var ang = angles[i] !== undefined ? angles[i]
          : (op.angle !== undefined ? op.angle : (op.foldAngle !== undefined ? op.foldAngle : 180));
        // 折线是“当前折叠平面”里的坐标：先换算回纸面坐标，再用该纸片的 M3 映射到三维
        var mv = (r.moved || [])[0];
        var parentFacet = null;
        if (mv !== undefined) {
          var afterFacet = null;
          for (var ai = 0; ai < after.facets.length; ai++) if (after.facets[ai].id === mv) { afterFacet = after.facets[ai]; break; }
          var wantId = afterFacet && afterFacet.parent !== undefined ? afterFacet.parent : mv;
          for (var bi = 0; bi < before.facets.length; bi++) if (before.facets[bi].id === wantId) { parentFacet = before.facets[bi]; break; }
        }
        if (mv !== undefined && parentFacet && M[parentFacet.id]) {
          var Tinv = invert(parentFacet.T);
          var pa = apply(Tinv, op.a), pb = apply(Tinv, op.b);
          var p1 = m3apply(M[parentFacet.id], [pa[0], pa[1], 0]), p2 = m3apply(M[parentFacet.id], [pb[0], pb[1], 0]);
          var dir = OG3.sub(p2, p1);
          if (Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) > 1e-9) {
            // 旋转方向要看“纸的正面朝哪边”：谷折让翻片正面向着被折过去的那面合拢，
            // 山折相反。用一个小角度试探法向的走向来决定符号（翻过面后仍然正确）。
            var sign = 1;
            try {
              var nFlap = (function (fid) {
                var Mf = M[fid] || m3ident();
                return OG3.norm([Mf.R[2], Mf.R[5], Mf.R[8]]);      // 纸面正面法向在三维中的方向
              })(mv);
              var nBase = null;
              for (var q2i = 0; q2i < before.facets.length; q2i++) {
                var bf = before.facets[q2i];
                if ((r.moved || []).indexOf(bf.id) >= 0) continue;  // 找一片不动的（被折过去的基准面）
                var Mb = M[bf.id];
                if (Mb) { nBase = OG3.norm([Mb.R[2], Mb.R[5], Mb.R[8]]); break; }
              }
              if (nBase) {
                var eps = 3, u2 = OG3.norm(dir);
                var Rt = m3rotAxis([0, 0, 0], u2, eps);
                var nTry = [Rt.R[0] * nFlap[0] + Rt.R[1] * nFlap[1] + Rt.R[2] * nFlap[2],
                  Rt.R[3] * nFlap[0] + Rt.R[4] * nFlap[1] + Rt.R[5] * nFlap[2],
                  Rt.R[6] * nFlap[0] + Rt.R[7] * nFlap[1] + Rt.R[8] * nFlap[2]];
                var dDot = OG3.dot(nTry, nBase) - OG3.dot(nFlap, nBase);
                // 谷折：正面法向要远离基准面正面；山折：靠近
                if (op.kind === 'mountain' ? dDot < 0 : dDot > 0) sign = -1;
              } else {
                sign = op.kind === 'mountain' ? -1 : 1;
              }
            } catch (e) { sign = op.kind === 'mountain' ? -1 : 1; }
            if (op.openSign === -1) sign = -sign;      // 模型可以逐折指定打开方向
            var Rm = m3rotAxis(p1, dir, sign * ang);
            if ((opts.open && opts.open.step === i) || (opts.openByLine && opts.openByLine.step === i)) {
              hinge = { p: p1, d: dir, ids: (r.moved || []).slice() };
            }
            if (opts.mirrorStep === i) { mirrorGroup = (r.moved || []).slice(); }
      if (opts.mirrorHalf === i) { mirrorGroup = (r.moved || []).slice(); }
            (r.moved || []).forEach(function (id) { M[id] = m3mul(Rm, M[id] || m3ident()); });
            undoStack.push({ ids: r.moved || [], R: m3rotAxis(p1, dir, -sign * ang) });
          }
        }
      } else if (op.type === 'flip') {
        var b = bounds(before), c = b.center;
        // 二维的 flip 是“沿竖直中轴翻面”，三维里等于绕竖直轴(y)转 180°
        var Rf = m3rotAxis([c[0], c[1], 0], [0, 1, 0], flipDeg);
        after.facets.forEach(function (f) { M[f.id] = m3mul(Rf, M[f.id] || m3ident()); });
      } else if (op.type === 'rotate') {
        var b2 = bounds(before), c2 = b2.center;
        var Rr = m3rotAxis([c2[0], c2[1], 0], [0, 0, 1], (op.deg || 0));
        after.facets.forEach(function (f) { M[f.id] = m3mul(Rr, M[f.id] || m3ident()); });
      } else if (op.type === 'unfold') {
        var u = undoStack.pop();
        if (u) u.ids.forEach(function (id) { if (M[id]) M[id] = m3mul(u.R, M[id]); });
      }
      st = after;
    });
    // 「沿机身线对称对开」：按纸片在机身线两侧的侧别，分别转 ±angle/2，
    // 得到左右对称的两翼（两翼之间夹角 = angle）
    if (opts.openByLine && hinge) {
      var ang2 = (opts.openByLine.angle === undefined ? 90 : opts.openByLine.angle);
      var hf = ang2 / 2, dh = OG3.norm(hinge.d);
      // 机体法向：取面积加权平均的正面向上的法向
      var nAvg = [0, 0, 0];
      Object.keys(M).forEach(function (k) {
        var idq = +k; if (!M[idq]) return;
        var fq = st.facets.filter(function (f) { return f.id === idq; })[0]; if (!fq) return;
        var Mq = M[idq];
        nAvg[0] += Mq.R[2]; nAvg[1] += Mq.R[5]; nAvg[2] += Mq.R[8];
      });
      nAvg = OG3.norm(nAvg);
      var nSide = OG3.norm(OG3.cross(dh, nAvg));      // 垂直于机身线、躺在机体平面里
      var Rp = m3rotAxis(hinge.p, dh, hf), Rn = m3rotAxis(hinge.p, dh, -hf);
      Object.keys(M).forEach(function (k) {
        var idz = +k; if (!M[idz]) return;
        var fz = st.facets.filter(function (f) { return f.id === idz; })[0]; if (!fz) return;
        var c3 = [0, 0, 0];
        fz.poly.forEach(function (q) { var pt = m3apply(M[idz], [q[0], q[1], 0]); for (var i = 0; i < 3; i++) c3[i] += pt[i] / fz.poly.length; });
        var sideSign = (c3[0] - hinge.p[0]) * nSide[0] + (c3[1] - hinge.p[1]) * nSide[1] + (c3[2] - hinge.p[2]) * nSide[2];
        M[idz] = m3mul(sideSign >= 0 ? Rp : Rn, M[idz]);
      });
    }
    // 「像翻书一样对开」：把对折那一步的翻片与其余纸片分别转 ±angle/2，
    // 得到左右对称的两翼（两翼之间夹角 = angle）
    if (opts.open && hinge && hinge.ids.length) {
      var half = (opts.open.angle === undefined ? 90 : opts.open.angle) / 2;
      var dnorm = OG3.norm(hinge.d);
      var Rh = m3rotAxis(hinge.p, dnorm, half), Rl = m3rotAxis(hinge.p, dnorm, -half);
      var idSet = {};
      hinge.ids.forEach(function (id) { idSet[id] = 1; });
      Object.keys(M).forEach(function (k) {
        var id2 = +k;
        if (!M[id2]) return;
        M[id2] = m3mul(idSet[id2] ? Rh : Rl, M[id2]);
      });
    }
    // 两翼对称：把「另一侧机翼」那一步折动的纸片按机体中面镜像到对侧，
    // 这样两翼才会一边一片，而不是折到同一侧去。
    if (mirrorGroup && mirrorGroup.length) {
      var idm = {}, sumX = 0, cnt2 = 0;
      mirrorGroup.forEach(function (id) { idm[id] = 1; });
      // 中面位置 = 除这一组之外所有纸片的 x 均值
      Object.keys(M).forEach(function (k) {
        var id3 = +k;
        if (idm[id3] || !M[id3]) return;
        var f3 = st.facets.filter(function (f) { return f.id === id3; })[0];
        if (!f3) return;
        f3.poly.forEach(function (q) { sumX += m3apply(M[id3], [q[0], q[1], 0])[0]; cnt2++; });
      });
      var x0 = cnt2 ? sumX / cnt2 : 0;
      var Mrefl = { R: [-1, 0, 0, 0, 1, 0, 0, 0, 1], t: [2 * x0, 0, 0] };
      mirrorGroup.forEach(function (id) { if (M[id]) M[id] = m3mul(Mrefl, M[id]); });
    }
    var polys = [], mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    st.facets.forEach(function (f) {
      var Mf = M[f.id] || m3ident();
      var pts = f.poly.map(function (q) { return m3apply(Mf, [q[0], q[1], 0]); });
      // 纸面正面法向：纸面坐标里正面是 +z，映射到三维
      var front = OG3.norm(m3apply(Mf, [0, 0, 1]).map(function (v, k) { return v - Mf.t[k]; }));
      polys.push({ pts: pts, front: front, layer: f.layer, area: Math.abs(OG.polyArea(f.poly)) });
      pts.forEach(function (p) { for (var k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; } });
    });
    return { polys: polys, min: mn, max: mx, state: st };
  }


  /**
   * 直接从分步折叠的折叠树生成 3D 模型（网格 + 假求解器接口），
   * 绕开"折痕图 → 求解器"那条路：多层折痕图对求解器是矛盾的，会算歪。
   * 返回的对象可以直接塞给 renderer 和 app：positions / step / setFoldPercent / bounds ...
   */
  function buildPoseModel(steps, opts) {
    opts = opts || {};
    var width = opts.width || 1, height = opts.height || 1;
    // 1) 先跑一遍，记下每一步是第几次折（用于分阶段 ramp）
    var stages = [], foldCount = 0, stepAngles = [];
    steps.forEach(function (st) {
      var op = st.op || st;
      if (op.type === 'fold') {
        foldCount++;
        stages.push(foldCount);
        stepAngles.push(op.angle !== undefined && op.angle !== null ? op.angle : 180);
      } else { stages.push(0); stepAngles.push(180); }
    });
    var nStage = foldCount;

    // 2) 建拓扑：每个纸片单独一套顶点（多层叠在一起时不能共用顶点）
    //    为了正/反面着色正确，所有纸片的多边形绕向都要和整张纸一致（否则会出现一块块反色）
    var nodes2d = [], tris = [], owner = [], lineIdxData = [], reversed = [];
    function signedArea(poly) {
      var a = 0;
      for (var i = 0; i < poly.length; i++) { var q = poly[i], r = poly[(i + 1) % poly.length]; a += q[0] * r[1] - r[0] * q[1]; }
      return a / 2;
    }
    // 三维里 Y 轴取反（Y = -(y-cy)），所以绕向要反过来：这样平放时正面朝向观察者
    var SHEET_SIGN = -(Math.sign(signedArea([[0, 0], [width, 0], [width, height], [0, height]])) || 1);
    function buildTopology() {
      nodes2d = []; tris = []; owner = []; lineIdxData = [];
      var flat = create({ width: width, height: height });
      steps.forEach(function (st) { var r = applyOp(flat, st.op); if (!r.error) flat = r.state; });
      flat.facets.forEach(function (f, fi) {
        var base = nodes2d.length;
        var rev = Math.sign(signedArea(f.poly)) !== SHEET_SIGN;
        reversed[fi] = rev;
        var poly = rev ? f.poly.slice().reverse() : f.poly;
        poly.forEach(function (q) { nodes2d.push([q[0], q[1]]); owner.push(fi); });
        for (var i = 1; i + 1 < poly.length; i++) tris.push([base, base + i, base + i + 1]);
        // 折痕线（纸片边落在折痕上的）
        for (var e = 0; e < poly.length; e++) {
          var A = poly[e], B = poly[(e + 1) % poly.length];
          var mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
          for (var ci = 0; ci < flat.creases.length; ci++) {
            var c = flat.creases[ci], L = OG.dist(c.a, c.b);
            if (L < 1e-9) continue;
            if (Math.abs(OG.orient(c.a, c.b, mid)) / L < 1e-7 && OG.pointSegDist(A, c.a, c.b) < 1e-7 && OG.pointSegDist(B, c.a, c.b) < 1e-7) {
              lineIdxData.push([base + e, base + (e + 1) % poly.length, c.type]);
              break;
            }
          }
        }
      });
      return flat;
    }
    var flatState = buildTopology();
    var n = nodes2d.length, positions = new Float32Array(n * 3);

    // 3) 给定折叠程度，算每个顶点的三维位置
    function poseAt(fp) {
      var ramp = function (stage) {
        if (!stage) return 0;
        var v0 = Math.abs(fp) * nStage - (stage - 1);
        return v0 <= 0 ? 0 : v0 >= 1 ? 1 : v0;
      };
      var angles = {};
      for (var i = 0; i < steps.length; i++) angles[i] = stepAngles[i] * ramp(stages[i]);
      return threeDPose(steps, { width: width, height: height, angles: angles });
    }
    var lastPose = null;
    function applyPose(fp) {
      var pose = poseAt(fp); lastPose = pose;
      var k = 0, fi = 0;
      // threeDPose 的 polys 顺序与 flat.facets 一致（都是 applyOp 重放的结果）
      for (fi = 0; fi < pose.polys.length; fi++) {
        var pts = pose.polys[fi].pts;
        if (reversed[fi]) pts = pts.slice().reverse();
        for (var i = 0; i < pts.length && k < n; i++) {
          positions[k * 3] = pts[i][0]; positions[k * 3 + 1] = pts[i][1]; positions[k * 3 + 2] = pts[i][2];
          k++;
        }
      }
      return positions;
    }
    applyPose(1);

    // 深度偏置：叠在一起的层几何完全贴合，靠顶点深度偏置决定谁盖住谁（层号越大越靠前）
    var bias = new Float32Array(n);
    (function () {
      var flatF = create({ width: width, height: height });
      steps.forEach(function (st) { var rr = applyOp(flatF, st.op); if (!rr.error) flatF = rr.state; });
      var maxLayer = 1;
      flatF.facets.forEach(function (f) { maxLayer = Math.max(maxLayer, f.layer); });
      var base = 0, fi2 = 0;
      flatF.facets.forEach(function (f) {
        var cnt = f.poly.length;
        var b2 = -(f.layer / maxLayer) * 3e-4;      // 上层的 z 更小 → 深度测试时优先
        for (var i2 = 0; i2 < cnt && base + i2 < n; i2++) bias[base + i2] = b2;
        base += cnt;
      });
    })();
    var mesh = {
      width: width, height: height, nodes2d: nodes2d, tris: tris, edges: [], hinges: [], warnings: [], bias: bias,
      lineIdx: lineIdxData.map(function (l) { return [l[0], l[1], l[2]]; })
    };
    var model = {
      isPose: true, mesh: mesh, n: n, positions: positions, x: positions,
      params: { collision: false, thickness: 0.001, axialStiffness: 1, damping: 0.1, globalDamping: 0.05 },
      v: new Float32Array(n * 3), grab: null, foldPercent: 1, _flatness: 0,
      maxStage: nStage,
      setFoldPercent: function (fp) { this.foldPercent = fp; applyPose(fp); return this; },
      step: function () { return this; },
      kinetic: function () { return 0; },
      creaseError: function () { return 0; },
      strainMax: function () { return 0; },
      maxSpeed: function () { return 0; },
      orient: function (alpha) {
        // 让模型的整体朝向转正（面积加权平均法向朝向观察者），避免折完后侧对着光、一片黑
        alpha = alpha === undefined ? 0.12 : alpha;
        var i, k, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
        for (i = 0; i < n; i++) for (k = 0; k < 3; k++) { var t0 = positions[i * 3 + k]; if (t0 < mn[k]) mn[k] = t0; if (t0 > mx[k]) mx[k] = t0; }
        var ctr = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
        var nrm = [0, 0, 0];
        for (var t = 0; t < tris.length; t++) {
          var A = tris[t][0] * 3, B = tris[t][1] * 3, C = tris[t][2] * 3;
          var ux = positions[B] - positions[A], uy = positions[B + 1] - positions[A + 1], uz = positions[B + 2] - positions[A + 2];
          var vx = positions[C] - positions[A], vy = positions[C + 1] - positions[A + 1], vz = positions[C + 2] - positions[A + 2];
          nrm[0] += uy * vz - uz * vy; nrm[1] += uz * vx - ux * vz; nrm[2] += ux * vy - uy * vx;
        }
        var L = Math.sqrt(nrm[0] * nrm[0] + nrm[1] * nrm[1] + nrm[2] * nrm[2]);
        if (L < 1e-9) return this;
        nrm = [nrm[0] / L, nrm[1] / L, nrm[2] / L];
        var up = [0, 0, 1];
        var dot = Math.max(-1, Math.min(1, nrm[0] * up[0] + nrm[1] * up[1] + nrm[2] * up[2]));
        var ang = Math.acos(dot) * alpha;
        if (ang < 1e-5) return this;
        var axis = [nrm[1] * up[2] - nrm[2] * up[1], nrm[2] * up[0] - nrm[0] * up[2], nrm[0] * up[1] - nrm[1] * up[0]];
        var axL = Math.sqrt(axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]);
        if (axL < 1e-9) return this;
        axis = [axis[0] / axL, axis[1] / axL, axis[2] / axL];
        var ca = Math.cos(ang), sa = Math.sin(ang), vv = 1 - ca;
        var R = [ca + axis[0] * axis[0] * vv, axis[0] * axis[1] * vv - axis[2] * sa, axis[0] * axis[2] * vv + axis[1] * sa,
          axis[1] * axis[0] * vv + axis[2] * sa, ca + axis[1] * axis[1] * vv, axis[1] * axis[2] * vv - axis[0] * sa,
          axis[2] * axis[0] * vv - axis[1] * sa, axis[2] * axis[1] * vv + axis[0] * sa, ca + axis[2] * axis[2] * vv];
        for (i = 0; i < n; i++) {
          var x = positions[i * 3] - ctr[0], y = positions[i * 3 + 1] - ctr[1], z = positions[i * 3 + 2] - ctr[2];
          positions[i * 3] = R[0] * x + R[1] * y + R[2] * z + ctr[0];
          positions[i * 3 + 1] = R[3] * x + R[4] * y + R[5] * z + ctr[1];
          positions[i * 3 + 2] = R[6] * x + R[7] * y + R[8] * z + ctr[2];
        }
        return this;
      },
      reset: function () { this.setFoldPercent(1); return this; },
      strain: function () { return { max: 0, node: new Float32Array(n) }; },
      bounds: function () {
        var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
        for (var i = 0; i < n; i++) for (var q = 0; q < 3; q++) { var t = positions[i * 3 + q]; if (t < mn[q]) mn[q] = t; if (t > mx[q]) mx[q] = t; }
        return { min: mn, max: mx };
      },
      syncPositions: function () { return this; },
      toOBJ: function (name) {
        var out = ['o ' + (name || 'origami')], i, k;
        for (i = 0; i < n; i++) out.push('v ' + positions[i * 3].toFixed(6) + ' ' + positions[i * 3 + 1].toFixed(6) + ' ' + positions[i * 3 + 2].toFixed(6));
        for (k = 0; k < tris.length; k++) out.push('f ' + (tris[k][0] + 1) + ' ' + (tris[k][1] + 1) + ' ' + (tris[k][2] + 1));
        return out.join('\n');
      },
      toSTL: function () {
        var out = ['solid origami'];
        for (var k = 0; k < tris.length; k++) {
          var A = tris[k][0] * 3, B = tris[k][1] * 3, C = tris[k][2] * 3;
          out.push('  facet normal 0 0 0\n    outer loop');
          [A, B, C].forEach(function (o) { out.push('      vertex ' + positions[o].toFixed(6) + ' ' + positions[o + 1].toFixed(6) + ' ' + positions[o + 2].toFixed(6)); });
          out.push('    endloop\n  endfacet');
        }
        out.push('endsolid origami');
        return out.join('\n');
      }
    };
    return model;
  }

  global.StepFold = {
    create: create, clone: clone, fold: fold, crease: crease, unfold: unfold, unfoldAll: unfoldAll, flip: flip, rotate: rotate, applyOp: applyOp, bounds: bounds, hitFacet: hitFacet,
    lineFromPoints: lineFromPoints, pointToPoint: pointToPoint, edgeToEdge: edgeToEdge,
    visibleFaces: visibleFaces, outlineEdges: outlineEdges, snapPoints: snapPoints, totalArea: totalArea,
    creasePattern: creasePattern, threeDPose: threeDPose, buildPoseModel: buildPoseModel, serialize: serialize, deserialize: deserialize,
    affine: { apply: apply, compose: compose, invert: invert, det: det, reflection: reflection }
  };
})(typeof window !== 'undefined' ? window : globalThis);
