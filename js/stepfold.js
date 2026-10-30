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

  /** 两片纸（纸面坐标）共享的那段边，返回 [p, q] 或 null */
  function sharedSeg(A, B) {
    for (var i = 0; i < A.length; i++) {
      var a0 = A[i], a1 = A[(i + 1) % A.length], la = OG.dist(a0, a1);
      if (la < 1e-12) continue;
      for (var j = 0; j < B.length; j++) {
        var b0 = B[j], b1 = B[(j + 1) % B.length];
        if (Math.abs(OG.orient(a0, a1, b0)) / la > 1e-7 || Math.abs(OG.orient(a0, a1, b1)) / la > 1e-7) continue;
        var d = OG.sub(a1, a0);
        var t0 = OG.dot(OG.sub(b0, a0), d) / (la * la), t1 = OG.dot(OG.sub(b1, a0), d) / (la * la);
        var lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
        if ((hi - lo) * la > 1e-6) return [OG.lerp(a0, a1, lo), OG.lerp(a0, a1, hi)];
      }
    }
    return null;
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
    return { width: w, height: h, nextId: 1, facets: [{ id: 0, poly: [[0, 0], [w, 0], [w, h], [0, h]], T: I(), layer: 0 }], creases: [], ops: [] };
  }
  function clone(s) {
    return { width: s.width, height: s.height, nextId: s.nextId, foldCount: s.foldCount || 0,
      ops: (s.ops || []).map(function (o) { return JSON.parse(JSON.stringify(o)); }),
      undoneCreases: (s.undoneCreases || []).map(function (c) { return JSON.parse(JSON.stringify(c)); }),
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
  /** 点选：返回点处最上面的那片纸（对象） */
  function facetAt(s, p) {
    var best = null;
    s.facets.forEach(function (f) { if (insidePoly(p, folded(f)) && (!best || f.layer > best.layer)) best = f; });
    return best;
  }
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
    /** 两片要动的纸是否连着、且连接边不在折线上（在折线上 = 这一折的铰链，不往对面传） */
    function connectedOffHinge(p, q) {
      var seg = sharedSeg(p.poly, q.poly);
      if (!seg) return false;
      var L = OG.dist(a, b);
      var P0 = apply(p.parent.T, seg[0]), P1 = apply(p.parent.T, seg[1]);
      var onLine = Math.abs(OG.orient(a, b, P0)) / L < 1e-6 && Math.abs(OG.orient(a, b, P1)) / L < 1e-6;
      return !onLine;
    }
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
            if (!connectedOffHinge(cur, p)) return;
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
          if (connectedOffHinge(cur, p)) { set.push(p); queue.push(p); }
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
    // 折线正好贴着纸片的边时，裁切会留下面积为 0 的碎片，去掉
    out = out.filter(function (f) { return Math.abs(OG.polyArea(f.poly)) > 1e-10; });
    moved = moved.filter(function (id) { return out.some(function (f) { return f.id === id; }); });
    s.facets = out;
    s.creases = s.creases.concat(creases);
    compactLayers(s);
    // 记下这一折“动了哪些纸面区域”（纸面坐标，翻面/旋转都不影响），供「打开某层」判断
    var movedPolys = [], movedCens = [];
    moved.forEach(function (id) {
      for (var i = 0; i < s.facets.length; i++) {
        if (s.facets[i].id !== id) continue;
        movedPolys.push(s.facets[i].poly.map(function (q) { return q.slice(); }));
        movedCens.push(OG.polyCentroid(s.facets[i].poly));
        return;
      }
    });
    // 折线的纸面坐标（翻面/旋转/删除别的折之后依然成立），供“打开某层”按纸面重放
    var paperLine = null, paperSide = null;
    state.facets.forEach(function (f) {
      if (paperLine) return;
      var inv = invert(f.T);
      var pa = apply(inv, a), pb = apply(inv, b), ps = apply(inv, sidePt);
      if (movedPolys.length && movedPolys.every(function (poly) { return true; }) &&
          (insidePoly(pa, f.poly) || insidePoly(pb, f.poly) || OG.pointSegDist(pa, f.poly[0], f.poly[1]) < 1e-6)) {
        paperLine = [pa, pb]; paperSide = ps;
      }
    });
    if (!paperLine) {
      var f0 = state.facets[0], inv0 = invert(f0.T);
      paperLine = [apply(inv0, a), apply(inv0, b)]; paperSide = apply(inv0, sidePt);
    }
    s.ops = (state.ops || []).concat([{ type: 'fold', a: op.a, b: op.b, side: op.side, kind: op.kind, scope: op.scope,
      movedCens: movedCens, movedPolys: movedPolys, paperLine: paperLine, paperSide: paperSide,
      paperSideSign: Math.sign(OG.orient(paperLine[0], paperLine[1], paperSide)) || 1 }]);
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
    var ops = state.ops || [];
    // 找到最后一次「折」（翻面/旋转不影响），把它去掉后重放，几何就回到折之前
    var idx = -1;
    for (var i = ops.length - 1; i >= 0; i--) if (ops[i].type === 'fold') { idx = i; break; }
    if (idx < 0) {
      if (state.snaps && state.snaps.length) {           // 兼容没有 ops 历史的老数据
        var s0 = clone(state);
        s0.facets = s0.snaps.pop();
        s0.creases = s0.creases.map(function (c) { return { a: c.a, b: c.b, type: c.type, angle: c.angle == null ? 0 : c.angle, stage: c.stage, foldAngle: c.foldAngle }; });
        return { state: s0 };
      }
      return { error: '已经没有可以打开的折了' };
    }
    var kept = ops.slice(0, idx).concat(ops.slice(idx + 1));
    var full = replayOps(state.width, state.height, ops);      // 全部折痕（含被打开的这一折）
    var geo = replayOps(state.width, state.height, kept);      // 几何：不含这一折
    if (full.error || geo.error) return { error: (full.error || geo.error) };
    var st = geo.state;
    // 「折了再展开」要留下折痕：把被打开那一折产生的折痕记下来，之后一直带着
    var keptKeys = {};
    geo.state.creases.forEach(function (c) { keptKeys[lineKey(c)] = 1; });
    var reopened = full.state.creases.filter(function (c) { return !keptKeys[lineKey(c)]; })
      .map(function (c) { return { a: c.a.slice(), b: c.b.slice(), type: c.type, angle: 0, stage: c.stage, foldAngle: c.foldAngle }; });
    var old = (state.undoneCreases || []).map(function (c) {
      var ok = !geo.state.creases.some(function (k) { return lineKey(k) === lineKey(c); });
      return ok ? JSON.parse(JSON.stringify(c)) : null;
    }).filter(Boolean);
    st.creases = st.creases.concat(reopened, old);
    st.undoneCreases = old.concat(reopened);
    st.ops = kept;
    return { state: st };
  }

  /** 去掉 ops 里第 idx 个折，几何回到折之前，折痕保留（内部用） */
  function removeFold(state, idx) {
    var ops = state.ops || [];
    if (idx < 0 || idx >= ops.length) return { error: '找不到这一折' };
    var kept = ops.slice(0, idx).concat(ops.slice(idx + 1));
    var full = replayOps(state.width, state.height, ops);
    var geo = replayOps(state.width, state.height, kept);
    if (full.error || geo.error) return { error: (full.error || geo.error) };
    var st = geo.state;
    var keptKeys = {};
    st.creases.forEach(function (c) { keptKeys[lineKey(c)] = 1; });
    var reopened = full.state.creases.filter(function (c) { return !keptKeys[lineKey(c)]; })
      .map(function (c) { return { a: c.a.slice(), b: c.b.slice(), type: c.type, angle: 0, stage: c.stage, foldAngle: c.foldAngle }; });
    var old = (state.undoneCreases || []).map(function (c) {
      var ok = !st.creases.some(function (k) { return lineKey(k) === lineKey(c); });
      return ok ? JSON.parse(JSON.stringify(c)) : null;
    }).filter(Boolean);
    st.creases = st.creases.concat(reopened, old);
    st.undoneCreases = old.concat(reopened);
    st.ops = kept;
    st.unfoldedIdx = idx;
    return { state: st, foldNo: idx + 1 };
  }


  /**
   * 打开某层（把这一层掀开折回去）：在平面点 planePoint 处取最上面那一层，
   * 找它的折线（与该纸片边界重合的折痕），沿这条折线把它反向折一次。
   * 折叠引擎里连续两次关于同一条线折叠 = 恒等，所以它就是“打开”。
   */
  function peelLayer(state, planePoint) {
    var f = facetAt(state, planePoint);
    if (!f) return { error: '这里没有纸' };
    // 该纸片在平面里的多边形
    var P = f.poly.map(function (q) { return apply(f.T, q); });
    // 找与该纸片某条边重合的折痕（平面里比）
    var best = null;
    state.creases.forEach(function (c) {
      var pa = apply(f.T, c.a), pb = apply(f.T, c.b);
      for (var i = 0; i < P.length; i++) {
        var A = P[i], B = P[(i + 1) % P.length], L = OG.dist(A, B);
        if (L < 1e-9) continue;
        if (OG.pointSegDist(pa, A, B) < 1e-6 && OG.pointSegDist(pb, A, B) < 1e-6) {
          if (!best || L > best.len) best = { a: A, b: B, len: L, type: c.type, stage: c.stage };
          break;
        }
      }
    });
    if (!best) return { error: '这一层找不到可以掀开的折线' };
    var cen = OG.polyCentroid(P);
    // 反向折：类型取反，折完这一层就回到原来的位置（打开）
    var kind = best.type === 'V' ? 'mountain' : 'valley';
    var op = { type: 'fold', a: best.a, b: best.b, side: cen, kind: kind, scope: 'top' };
    var r = fold(state, op);
    if (r.error) return r;
    r.peeled = true;
    r.foldLine = best;
    r.op = op;                            // 供上层记成一步（本质上就是一次折）
    return r;
  }

  /**
   * 打开「某层」：在纸面点 point 处，从最上层往下数第 nth 层（1 基），
   * 把它所在的这一折打开（只打开影响这一层的最后一折）。翻面/旋转之后同样适用。
   */
  /**
   * 「翻层」：把点到的这一层沿它自己的折痕边翻到另一侧，塞进夹层（变到最底下）。
   * 相当于纸上把一层掀起来、翻过折痕压到别的层后面。返回 { state, op }。
   */
  function tuckLayer(state, point) {
    var s = clone(state);
    var F = facetAt(s, point);
    if (!F) return { error: '这里没有纸' };
    var P = folded(F);
    // 找这一层的折痕边：与其它纸片共享、且离点的位置最近的那条（点在哪条边附近就翻哪条边）
    var best = null, bestScore = Infinity;
    for (var i = 0; i < P.length; i++) {
      var A = P[i], B = P[(i + 1) % P.length];
      var len = OG.dist(A, B);
      if (len < 1e-6) continue;
      var score = OG.pointSegDist(point, A, B);
      var shared = false;
      for (var j = 0; j < s.facets.length && !shared; j++) {
        var G = s.facets[j];
        if (G.id === F.id) continue;
        var Q = folded(G);
        for (var k = 0; k < Q.length; k++) {
          var C = Q[k], D = Q[(k + 1) % Q.length];
          if (OG.dist(A, C) < 1e-6 && OG.dist(B, D) < 1e-6) { shared = true; break; }
          if (OG.dist(A, D) < 1e-6 && OG.dist(B, C) < 1e-6) { shared = true; break; }
        }
      }
      if (shared && score < bestScore - 1e-12) { best = [A, B]; bestScore = score; }
    }
    if (!best) return { error: '这一层找不到可以翻的折痕边（它是一只整片）' };
    // 沿这条边翻 180°：平面变换 = 反射
    var Rm = reflection(best[0], best[1]);
    F.T = compose(Rm, F.T);
    var newPoly = folded(F);
    // 塞到最底下：比所有与它重叠的纸片都低
    var minLayer = F.layer;
    s.facets.forEach(function (G) {
      if (G.id === F.id) return;
      if (!overlapPoly(folded(G), newPoly)) return;
      if (G.layer < minLayer) minLayer = G.layer;
    });
    F.layer = minLayer - 1;
    compactLayers(s);
    return {
      state: s,
      op: { type: 'tuckLayer', point: point.slice(), edge: [best[0].slice(), best[1].slice()] }
    };
  }
  function overlapPoly(A, B) {
    function samples(P) {
      var c = OG.polyCentroid ? OG.polyCentroid(P) : [0, 0];
      var out = [c];
      P.forEach(function (q) { out.push(OG.lerp(c, q, 0.9)); });
      for (var i = 0; i < P.length; i++) out.push(OG.lerp(c, OG.lerp(P[i], P[(i + 1) % P.length], 0.5), 0.9));
      return out;
    }
    var sa = samples(A), sb = samples(B), i;
    for (i = 0; i < sa.length; i++) if (OG.pointInPoly(sa[i], B)) return true;
    for (i = 0; i < sb.length; i++) if (OG.pointInPoly(sb[i], A)) return true;
    return false;
  }

  function unfoldLayer(state, point, nth) {
    nth = Math.max(1, nth || 1);
    var stack = [];
    state.facets.forEach(function (f) { if (insidePoly(point, f.poly)) stack.push(f); });
    if (!stack.length) return { error: '这里没有纸' };
    stack.sort(function (a, b) { return b.layer - a.layer; });
    var ops = state.ops || [];
    // 找出「动过这个纸面点」的所有折（从最近往前）：第 n 层 = 倒数第 n 个
    var hits = [];
    for (var i = ops.length - 1; i >= 0; i--) {
      var o = ops[i];
      if (o.type !== 'fold') continue;
      var moved = false;
      if (o.movedPolys && o.movedPolys.length) moved = o.movedPolys.some(function (poly) { return OG.pointInPoly(point, poly); });
      else if (o.movedCens) moved = o.movedCens.some(function (c) { return OG.pointInPoly(c, stack[0].poly); });
      if (moved) hits.push(i);
    }
    if (!hits.length) {
      return { error: '这一处没有折起来的层可以打开（可能本来就是一整张）' };
    }
    var idx = hits[Math.min(nth, hits.length) - 1];
    // 要打开的就是最近这一折：直接用折之前存下的快照，几何 100% 还原（“回到折之前的样子”）
    var lastFold = -1;
    for (var q = ops.length - 1; q >= 0; q--) if (ops[q].type === 'fold') { lastFold = q; break; }
    if (idx === lastFold && state.snaps && state.snaps.length) {
      var snap = state.snaps[state.snaps.length - 1];
      var s2 = clone(state);
      s2.facets = snap.map(function (f) {
        return { id: f.id, poly: f.poly.map(function (q2) { return q2.slice(); }), T: cloneT(f.T), layer: f.layer };
      });
      s2.snaps = state.snaps.slice(0, -1);
      s2.ops = ops.slice(0, idx).concat(ops.slice(idx + 1));
      // 这一折的折痕留在纸上（angle 归 0）
      var keepKeys = {};
      s2.creases.forEach(function (c) { keepKeys[lineKey(c)] = 1; });
      var reopenedC = state.creases.filter(function (c) { return !keepKeys[lineKey(c)]; }).map(function (c) {
        return { a: c.a.slice(), b: c.b.slice(), type: c.type, angle: 0, stage: c.stage, foldAngle: c.foldAngle };
      });
      s2.creases = s2.creases.concat(reopenedC);
      s2.undoneCreases = (state.undoneCreases || []).concat(reopenedC);
      return { state: s2, foldNo: idx + 1, layerFromTop: Math.min(nth, stack.length), layerCount: stack.length, exact: true };
    }
    var r = removeFold(state, idx);
    if (r.error) return r;
    r.layerFromTop = Math.min(nth, stack.length);
    r.layerCount = stack.length;
    r.foldCountHere = hits.length;
    return r;
  }

  function lineKey(c) {
    var A = c.a, B = c.b;
    var ang = ((Math.atan2(B[1] - A[1], B[0] - A[0]) * 180 / Math.PI) % 180 + 180) % 180;
    var L = Math.sqrt((B[0] - A[0]) * (B[0] - A[0]) + (B[1] - A[1]) * (B[1] - A[1])) || 1;
    var nx = -(B[1] - A[1]) / L, ny = (B[0] - A[0]) / L;
    return ang.toFixed(1) + '|' + (nx * A[0] + ny * A[1]).toFixed(4);
  }
  /** 按 op 列表从头重放（内部用） */
  function replayOps(width, height, ops) {
    var st = create({ width: width, height: height });
    for (var i = 0; i < ops.length; i++) {
      var op = ops[i];
      if (op.type === 'fold' && op.paperLine) {
        // 用纸面坐标重新定位折线（删掉/跳过别的折之后仍然正确）
        var mid = OG.lerp(op.paperLine[0], op.paperLine[1], 0.5);
        var f = null;
        for (var k = 0; k < st.facets.length; k++) {
          if (!insidePoly(mid, st.facets[k].poly)) continue;
          if (!f || st.facets[k].layer > f.layer) f = st.facets[k];   // 取最上面那层（和当初折的时候一致）
        }
        if (f) {
          var pa2 = apply(f.T, op.paperLine[0]), pb2 = apply(f.T, op.paperLine[1]);
          // 侧向：纸面符号 × 该纸片是否被镜像；再在图线上取一个很小的偏移点作为侧点
          var want = (op.paperSideSign || 1) * (det(f.T) < 0 ? -1 : 1);
          var mx = (pa2[0] + pb2[0]) / 2, my = (pa2[1] + pb2[1]) / 2;
          var dx = pb2[0] - pa2[0], dy = pb2[1] - pa2[1], L = Math.hypot(dx, dy) || 1;
          var nx = -dy / L, ny = dx / L;
          var s1 = Math.sign(OG.orient(pa2, pb2, [mx + nx * 1e-3, my + ny * 1e-3])) || 1;
          var sgnN = (s1 === want) ? 1 : -1;
          var side = [mx + nx * 1e-3 * sgnN * L + dx / L * 1e-4, my + ny * 1e-3 * sgnN * L + dy / L * 1e-4];
          op = { type: 'fold', a: pa2, b: pb2, side: side, kind: op.kind, scope: op.scope };
        }
      }
      var r = applyOp(st, op);
      if (r.error) return { error: r.error };
      st = r.state;
    }
    return { state: st };
  }

  /** 完全复原（展开）：几何回到整张平纸，折痕全部保留下来（对应「展开看折痕图」） */
  function unfoldAll(state) {
    var s = clone(state);
    var w = s.width, h = s.height;
    s.facets = [{ id: 0, poly: [[0, 0], [w, 0], [w, h], [0, h]], T: I(), layer: 0 }];
    s.snaps = []; s.ops = [];
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
    if (op.type === 'tuckLayer') return tuckLayer(state, op.point);
    if (op.type === 'unfold') return unfold(state);
    if (op.type === 'unfoldLayer') return unfoldLayer(state, op.point, op.nth || 1);
    if (op.type === 'peelLayer') return peelLayer(state, op.point);
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
  /** 把二维变换 T 抬成三维变换（z=0 平放）：用来把姿态重新锚定到平面状态 */
  function m3fromT(T) {
    var m = T.m, t = T.t;
    return { R: [m[0], m[2], 0, m[1], m[3], 0, 0, 0, 1], t: [t[0], t[1], 0] };
  }
  function threeDPose(steps, opts) {
    opts = opts || {};
    // 全部按 180°（且没有逐帧进度）时，三维姿态就等于平面状态：
    // 直接由平面结果给出姿态，避免“折了又展开/翻面”这类步骤在累计旋转里差一个镜像。
    (function () {
      var allFlat = true;
      (steps || []).forEach(function (step, i) {
        var op = step.op || step;
        var aIn = opts.angles || {};
        var ang = aIn[i] !== undefined ? aIn[i] : (op.angle !== undefined ? op.angle : (op.foldAngle !== undefined ? op.foldAngle : 180));
        if (op.type === 'fold') {
          var m360 = ((ang % 360) + 360) % 360;
          if (Math.abs(m360 - 180) > 1e-9 && Math.abs(m360) > 1e-9) allFlat = false;
        }
        if (opts.ramp && opts.ramp[i] !== undefined && opts.ramp[i] !== 1) allFlat = false;
      });
      if (opts.flipAngle !== undefined && Math.abs(opts.flipAngle % 360 - 180) > 1e-9) allFlat = false;
      if (opts.open || opts.openByLine || opts.track) allFlat = false;   // 逐帧跟踪的模式不走这条捷径
      if (!allFlat) return;
      var flatSt = create({ width: opts.width || 1, height: opts.height || 1 });
      (steps || []).forEach(function (step) {
        var r = applyOp(flatSt, step.op || step);
        if (!r.error) flatSt = r.state;
      });
      var mn = [1e9, 1e9, 0], mx = [-1e9, -1e9, 0];
      var out = flatSt.facets.map(function (f) {
        var pts = f.poly.map(function (q) { var p2 = apply(f.T, q); return [p2[0], p2[1], 0]; });
        pts.forEach(function (p2) { for (var k = 0; k < 3; k++) { if (p2[k] < mn[k]) mn[k] = p2[k]; if (p2[k] > mx[k]) mx[k] = p2[k]; } });
        return { pts: pts, front: [0, 0, isFlipped(f) ? -1 : 1], layer: f.layer, area: Math.abs(OG.polyArea(f.poly)) };
      });
      threeDPose._flat = { polys: out, min: mn, max: mx, state: flatSt };
      return;
    })();
    if (threeDPose._flat) { var f0 = threeDPose._flat; threeDPose._flat = null; return f0; }
    var angles = opts.angles || {};                 // { 步序号(0基): 角度 } 默认 180
    var ramp = opts.ramp || null;                   // { 步序号: 0..1 } 动画进度（折叠/翻面/旋转都按比例做）
    var flipDeg = opts.flipAngle === undefined ? 180 : opts.flipAngle;
    var st = create({ width: opts.width || 1, height: opts.height || 1 });
    var M = {};                                     // facet id → M3
    st.facets.forEach(function (f) { M[f.id] = m3ident(); });
    var undoStack = [], hinge = null, mirrorGroup = null;
    // track：用最细分的那一步当拓扑，逐帧跟着折/展开走（教程里有「折了再展开」时需要）
    var TK = null;
    if (opts.track && opts.track.facets && opts.track.facets.length) {
      TK = opts.track.facets.map(function (tf) {
        return { poly: tf.poly, cen: OG.polyCentroid(tf.poly), layer: tf.layer, M: m3ident(), parent: tf.parent };
      });
    }
    /** 按纸面位置找出此刻包含这片纸的纸片（返回它的平面变换 T） */
    function planeTOf(state, cen) {
      for (var i = 0; i < state.facets.length; i++) {
        if (insidePoly(cen, state.facets[i].poly)) return state.facets[i].T;
      }
      return null;
    }
    function trackApply(fn) {
      if (!TK) return;
      TK.forEach(function (t) { t.M = m3mul(fn(t), t.M); });
    }
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
        if (ramp) ang *= (ramp[i] === undefined ? 1 : ramp[i]);
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
            // 旋转方向：和二维视图的定义一致——谷折 = 翻片朝观察者翻起（落在最上层），山折相反。
            // 三维里观察者恒在 +z 一侧（翻面时是整个模型绕 y 轴转）。基准面的“朝观察者”法向
            // = 它在二维里露出正面时取正面法向，露出反面时取反向。用 30° 试探角判断 ± 号
            // （180° 时正反两个方向结果相同，没法判断）。
            var sign = 1;
            try {
              var mvAfter = null;
              for (var ai3 = 0; ai3 < after.facets.length; ai3++) if (after.facets[ai3].id === mv) { mvAfter = after.facets[ai3]; break; }
              var movedIds = r.moved || [];
              var baseF = null;
              if (mvAfter && mvAfter.parent !== undefined) {           // 被折线切开时，静止的那半保留父片 id
                for (var bi3 = 0; bi3 < after.facets.length; bi3++) {
                  var cand = after.facets[bi3];
                  if (cand.id === mvAfter.parent && movedIds.indexOf(cand.id) < 0) { baseF = cand; break; }
                }
              }
              if (!baseF && mvAfter) {                                   // 沿已有折痕整片翻：取平面里最近的静止纸片
                var cm = OG.polyCentroid(folded(mvAfter)), bestD = Infinity;
                after.facets.forEach(function (cand2) {
                  if (movedIds.indexOf(cand2.id) >= 0) return;
                  var d0 = OG.dist(OG.polyCentroid(folded(cand2)), cm);
                  if (d0 < bestD) { bestD = d0; baseF = cand2; }
                });
              }
              if (baseF && mvAfter && M[baseF.id]) {
                var Mb = M[baseF.id];
                var nB = OG3.norm([Mb.R[2], Mb.R[5], Mb.R[8]]);
                var nView = det(baseF.T) > 0 ? nB : [-nB[0], -nB[1], -nB[2]];
                var cpq = OG.polyCentroid(mvAfter.poly);
                var c0 = m3apply(M[mv] || m3ident(), [cpq[0], cpq[1], 0]);
                var probe = Math.min(30, Math.abs(ang) || 30);
                var cP = m3apply(m3rotAxis(p1, dir, probe), c0), cN = m3apply(m3rotAxis(p1, dir, -probe), c0);
                var sideP = OG3.dot(OG3.sub(cP, p1), nView), sideN = OG3.dot(OG3.sub(cN, p1), nView);
                var want = op.kind === 'mountain' ? -1 : 1;
                sign = want * (sideP - sideN) >= 0 ? 1 : -1;
              }
            } catch (e) { sign = op.kind === 'mountain' ? -1 : 1; }
            var movedIds = r.moved || [];
            // 方向最终以“平面视图里的上下层顺序”为准：谷折把被折的纸抬到静止纸之上，
            // 山折反之。当翻面/展开之后基准片找偏了（法向取反）时，这里能纠正过来。
            try {
              var mvId0 = (r.moved || [])[0];
              var mvF = null, stF = null;
              for (var q1 = 0; q1 < after.facets.length && !mvF; q1++) if (after.facets[q1].id === mvId0) mvF = after.facets[q1];
              if (mvF) {
                var PA0 = folded(mvF), cM0 = OG.polyCentroid(PA0), bestO = null, bestA = 0;
                after.facets.forEach(function (cand3) {
                  if (movedIds.indexOf(cand3.id) >= 0) return;
                  var PB0 = folded(cand3), ar = Math.abs(OG.polyArea(PB0));
                  if (!(ar > bestA)) return;
                  // 两片在平面上要真的有重叠，才谈得上谁压谁
                  var hit = OG.pointInPoly(cM0, PB0) || OG.pointInPoly(OG.polyCentroid(PB0), PA0);
                  if (!hit) {
                    for (var t3 = 0; t3 < 5 && !hit; t3++) hit = OG.pointInPoly(OG.lerp(cM0, OG.polyCentroid(PB0), t3 / 4), PB0);
                  }
                  if (hit) { bestO = cand3; bestA = ar; }
                });
                stF = bestO;
              }
              if (mvF && stF && M[mvF.id] && M[stF.id]) {
                var probe2 = Math.min(20, Math.abs(ang) || 20);
                var cenM = OG.polyCentroid(mvF.poly), cenS = OG.polyCentroid(stF.poly);
                var cM3 = m3apply(M[mvF.id], [cenM[0], cenM[1], 0]);
                var cS3 = m3apply(M[stF.id], [cenS[0], cenS[1], 0]);
                var up = m3apply(m3rotAxis(p1, dir, probe2), cM3)[2] - cS3[2];
                var dn = m3apply(m3rotAxis(p1, dir, -probe2), cM3)[2] - cS3[2];
                var above = mvF.layer >= stF.layer;
                sign = (above ? up >= dn : up <= dn) ? 1 : -1;
              }
            } catch (e2) { void e2; }
            var Rm = m3rotAxis(p1, dir, sign * ang);
            if ((opts.open && opts.open.step === i) || (opts.openByLine && opts.openByLine.step === i)) {
              hinge = { p: p1, d: dir, ids: (r.moved || []).slice() };
            }
            if (opts.mirrorStep === i) { mirrorGroup = (r.moved || []).slice(); }
      if (opts.mirrorHalf === i) { mirrorGroup = (r.moved || []).slice(); }
            (r.moved || []).forEach(function (id) { M[id] = m3mul(Rm, M[id] || m3ident()); });
            if (TK) {
              var movedTk = [];
              TK.forEach(function (t) {
                var T = planeTOf(before, t.cen);
                if (!T) return;
                var pcen = apply(T, t.cen);
                var sd = OG.orient(op.a, op.b, pcen);
                if (Math.abs(sd) > 1e-9 && Math.sign(sd) === Math.sign(OG.orient(op.a, op.b, op.side))) {
                  t.M = m3mul(Rm, t.M); movedTk.push(t);
                }
              });
              undoStack.push({ ids: r.moved || [], p: p1, d: dir, sign: sign, ang: ang, tk: movedTk });
            } else {
              undoStack.push({ ids: r.moved || [], p: p1, d: dir, sign: sign, ang: ang });
            }
          }
        }
      } else if (op.type === 'flip') {
        var b = bounds(before), c = b.center;
        // 二维的 flip 是“沿竖直中轴翻面”，三维里等于绕竖直轴(y)转 180°
        var Rf = m3rotAxis([c[0], c[1], 0], [0, 1, 0], flipDeg * (ramp && ramp[i] !== undefined ? ramp[i] : 1));
        after.facets.forEach(function (f) { M[f.id] = m3mul(Rf, M[f.id] || m3ident()); });
        if (TK) TK.forEach(function (t) { t.M = m3mul(Rf, t.M); });
      } else if (op.type === 'rotate') {
        var b2 = bounds(before), c2 = b2.center;
        var Rr = m3rotAxis([c2[0], c2[1], 0], [0, 0, 1], (op.deg || 0) * (ramp && ramp[i] !== undefined ? ramp[i] : 1));
        after.facets.forEach(function (f) { M[f.id] = m3mul(Rr, M[f.id] || m3ident()); });
        if (TK) TK.forEach(function (t) { t.M = m3mul(Rr, t.M); });
      } else if (op.type === 'unfold' || op.type === 'unfoldLayer') {
        // 打开上一折：把那一折反向转回去。带 ramp 时按进度反着做，所以 3D 里能看到“折起来又展开”。
        var u = undoStack.pop();
        var ru2 = ramp ? (ramp[i] === undefined ? 1 : ramp[i]) : 1;
        if (u && ru2 < 1) {
          // 动画中途：按进度反着转回去，这样“折起来又展开”的过程能看到
          var Ru = m3rotAxis(u.p, u.d, -u.sign * u.ang * ru2);
          u.ids.forEach(function (id) { if (M[id]) M[id] = m3mul(Ru, M[id]); });
          if (u.tk) u.tk.forEach(function (t) { t.M = m3mul(Ru, t.M); });
        } else {
          // 完全展开：直接以二维状态为准重新锚定。之前按“折”累计的旋转在
          // 翻面/多层折叠之后会对不上（差一个镜像），而二维结果本身就是正确答案。
          after.facets.forEach(function (f) { M[f.id] = m3fromT(f.T); });
          if (TK) TK.forEach(function (t) { var Tq = planeTOf(after, t.cen); if (Tq) t.M = m3fromT(Tq); });
        }
      } else if (op.type === 'unfoldAll') {
        // 展开复原：所有折起来的都按进度打开（后折的先开）
        var ra = ramp ? (ramp[i] === undefined ? 1 : ramp[i]) : 1;
        if (ra < 1) {
          while (undoStack.length) {
            var ua = undoStack.pop();
            var Ra = m3rotAxis(ua.p, ua.d, -ua.sign * ua.ang * ra);
            ua.ids.forEach(function (id) { if (M[id]) M[id] = m3mul(Ra, M[id]); });
            if (ua.tk) ua.tk.forEach(function (t) { t.M = m3mul(Ra, t.M); });
          }
        } else {
          while (undoStack.length) undoStack.pop();
          after.facets.forEach(function (f) { M[f.id] = m3fromT(f.T); });
          if (TK) TK.forEach(function (t) { var Tq = planeTOf(after, t.cen); if (Tq) t.M = m3fromT(Tq); });
        }
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
    // 教程里有「折了再展开」时，最终状态会比中途“少片”。这时用最细分那一步的纸片当拓扑，
    // 再按 parent 链找回它此刻的三维变换（展开后回落到祖先/整体，纸就是平的）。
    if (TK) {
      var pmn = [1e9, 1e9, 1e9], pmx = [-1e9, -1e9, -1e9];
      TK.forEach(function (t) {
        var pts = t.poly.map(function (q) { return m3apply(t.M, [q[0], q[1], 0]); });
        var front = OG3.norm(m3apply(t.M, [0, 0, 1]).map(function (v, k) { return v - t.M.t[k]; }));
        polys.push({ pts: pts, front: front, layer: t.layer, area: Math.abs(OG.polyArea(t.poly)) });
        pts.forEach(function (q) { for (var k = 0; k < 3; k++) { if (q[k] < pmn[k]) pmn[k] = q[k]; if (q[k] > pmx[k]) pmx[k] = q[k]; } });
      });
      return { polys: polys, min: pmn, max: pmx, state: st };
    }
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
   * 直接从分步折叠的折叠树生成 3D 模型（网格 + 求解器接口），不走“折痕图 → 求解器”。
   *  · 每片纸单独一套顶点（多层叠在一起时同一个纸面点在各层是不同的三维点，不能共用）；
   *  · 三角形绕向统一按“纸面正面”定义 → 渲染器用 gl_FrontFacing 就能得到真实的正/反面色，
   *    和平面视图完全同一套规则（翻过来的纸露出背面色）；
   *  · 折叠程度 0→1 按时间线依次做每一步：折叠（含折角）、翻面、旋转都按比例动画，
   *    所以 3D 在每个时刻和平面视图同一步的样子一致；
   *  · 叠在一起的层几何完全贴合，只给渲染器一个按层号的深度偏置，避免共面闪烁。
   */
  function buildPoseModel(steps, opts) {
    opts = opts || {};
    var width = opts.width || 1, height = opts.height || 1;
    steps = (steps || []).map(function (st) { return { op: st.op || st }; });
    // 时间线：只有改变几何的步骤（折叠 / 翻面 / 旋转）占时间段
    var timed = [];
    steps.forEach(function (st, i) {
      var t = st.op.type;
      if (t === 'fold' || t === 'peelLayer' || t === 'flip' || t === 'unfold' || t === 'unfoldLayer' || t === 'unfoldAll' || (t === 'rotate' && st.op.deg)) timed.push(i);
    });
    var nT = Math.max(1, timed.length);
    var slot = {}; timed.forEach(function (i, k) { slot[i] = k; });
    function rampAt(fp) {
      var r = {}, x = Math.max(0, Math.min(1, Math.abs(fp))) * nT;
      steps.forEach(function (_, i) {
        if (slot[i] === undefined) { r[i] = 1; return; }
        var v = x - slot[i];
        r[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
      });
      return r;
    }

    // 拓扑：取纸片最多的那一步（教程里可能有「折了再展开」，最终状态反而更少片）
    var flat = create({ width: width, height: height });
    var prefixStates = [flat];
    steps.forEach(function (st) {
      var r = applyOp(flat, st.op);
      if (!r.error) flat = r.state;
      prefixStates.push(flat);
    });
    // Map final subdivisions to the current coarser material facets at each boundary.
    var currentLayers = prefixStates.map(function (state) {
      return flat.facets.map(function (f) {
        var p = OG.polyCentroid(f.poly);
        var parent = state.facets.filter(function (g) { return insidePoly(p, g.poly); })[0];
        if (!parent) throw new Error('无法定位当前纸层');
        return { layer: parent.layer, side: det(parent.T) < 0 ? -1 : 1 };
      });
    });
    // 只有出现「展开」步骤时，最终状态才比中途“少片”，这时才需要用最细分那一步当拓扑
    var hasUnfold = steps.some(function (st) {
      var t = st.op && st.op.type; return t === 'unfold' || t === 'unfoldAll' || t === 'unfoldLayer';
    });
    var topoState = prefixStates[prefixStates.length - 1], topoIdx = prefixStates.length - 1;
    if (hasUnfold) {
      prefixStates.forEach(function (ps, i) {
        if (ps.facets.length > topoState.facets.length) { topoState = ps; topoIdx = i; }
      });
    }
    // parent 链（跨状态用：facet id → parent id）
    var parentMap = {};
    prefixStates.forEach(function (ps) { ps.facets.forEach(function (f) { if (f.parent !== undefined) parentMap[f.id] = f.parent; }); });
    // 纸面正面的绕向：三维里 Y = -(y - cy)，纸面坐标里 signedArea < 0 的多边形在三维里是逆时针（正面朝 +z）
    function sArea(poly) { var a = 0; for (var i = 0; i < poly.length; i++) { var q = poly[i], w = poly[(i + 1) % poly.length]; a += q[0] * w[1] - w[0] * q[1]; } return a / 2; }
    var nodes2d = [], tris = [], lineIdx = [], order = [];
    var topoFacets = topoState.facets;
    topoFacets.forEach(function (f, fi) {
      var idx = f.poly.map(function (_, k) { return k; });
      if (sArea(f.poly) > 0) idx.reverse();
      order.push(idx);
      var base = nodes2d.length;
      idx.forEach(function (k) { nodes2d.push([f.poly[k][0], f.poly[k][1]]); });
      for (var i = 1; i + 1 < idx.length; i++) tris.push([base, base + i, base + i + 1]);
      for (var e = 0; e < idx.length; e++) {
        var A = f.poly[idx[e]], B = f.poly[idx[(e + 1) % idx.length]];
        for (var ci = 0; ci < flat.creases.length; ci++) {
          var c = flat.creases[ci];
          if (OG.pointSegDist(A, c.a, c.b) < 1e-7 && OG.pointSegDist(B, c.a, c.b) < 1e-7) { lineIdx.push([base + e, base + (e + 1) % idx.length, c.type]); break; }
        }
      }
    });
    var n = nodes2d.length, positions = new Float32Array(n * 3);
    var stack = new Float32Array(n * 3);
    // 三维坐标和求解器一致：X = x - cx, Y = -(y - cy), Z = z
    var cx = width / 2, cy = height / 2;

    var trackInfo = hasUnfold && topoIdx < prefixStates.length - 1
      ? { facets: topoFacets.map(function (f) { return { id: f.id, poly: f.poly, layer: f.layer, parent: f.parent }; }), parentMap: parentMap }
      : null;
    function applyPose(fp) {
      var ramps = rampAt(fp);
      var pose = threeDPose(steps, { width: width, height: height, ramp: ramps, track: trackInfo });
      var completed = 0;
      for (var si = 0; si < steps.length; si++) {
        if (ramps[si] < 1 - 1e-9) break;
        completed = si + 1;
      }
      var layers = panelsFor(completed);
      var maxRank = Math.max(1, prefixStates[completed].facets.length - 1);
      var k = 0;
      for (var fi = 0; fi < topoFacets.length; fi++) {
        var P = pose.polys[fi], idx = order[fi];
        // Direction toward higher layers in this material facet's current frame.
        // This rotates with the flap; observing the back reverses the depth priority.
        var rank = layers[fi].layer / maxRank * layers[fi].side;
        for (var j = 0; j < idx.length; j++) {
          var q = P.pts[idx[j]];
          positions[k * 3] = q[0] - cx; positions[k * 3 + 1] = -(q[1] - cy); positions[k * 3 + 2] = q[2];
          stack[k * 3] = P.front[0] * rank;
          stack[k * 3 + 1] = -P.front[1] * rank;
          stack[k * 3 + 2] = P.front[2] * rank;
          k++;
        }
      }
    }
    // 每片「拓扑纸片」在某个中间状态里对应哪片纸（按纸面位置找），用于取层号与正反面
    var topoCens = topoFacets.map(function (f) { return OG.polyCentroid(f.poly); });
    var panelCache = prefixStates.map(function (ps) {
      return topoCens.map(function (c) {
        var f = ps.facets.filter(function (g) { return insidePoly(c, g.poly); })[0] || ps.facets[ps.facets.length - 1];
        return { layer: f.layer, side: det(f.T) < 0 ? -1 : 1 };
      });
    });
    function panelsFor(current) {
      return panelCache[Math.max(0, Math.min(panelCache.length - 1, current))];
    }
    applyPose(1);

    var mesh = {
      width: width, height: height, nodes2d: nodes2d, tris: tris, edges: [], hinges: [], warnings: [],
      lineIdx: lineIdx, stack: stack,
      ambient: 1.0          // 纯纸色（不被光照压暗），正/反面由几何朝向决定
    };
    return {
      isPose: true, mesh: mesh, n: n, positions: positions, x: positions,
      params: { collision: false, thickness: 0.001 },
      v: new Float32Array(n * 3), grab: null, foldPercent: 1, maxStage: nT,
      setFoldPercent: function (fp) { if (fp !== this.foldPercent) { this.foldPercent = fp; applyPose(fp); } return this; },
      step: function () { return this; }, kinetic: function () { return 0; }, maxSpeed: function () { return 0; },
      creaseError: function () { return 0; }, orient: function () { return this; }, syncPositions: function () { return this; },
      reset: function () { this.foldPercent = -1; return this.setFoldPercent(0); },
      strain: function () { return { max: 0, node: new Float32Array(n) }; },
      bounds: function () {
        var mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
        for (var i = 0; i < n; i++) for (var q = 0; q < 3; q++) { var t = positions[i * 3 + q]; if (t < mn[q]) mn[q] = t; if (t > mx[q]) mx[q] = t; }
        return { min: mn, max: mx };
      },
      toOBJ: function (name) {
        var out = ['o ' + (name || 'origami')], i;
        for (i = 0; i < n; i++) out.push('v ' + positions[i * 3].toFixed(6) + ' ' + positions[i * 3 + 1].toFixed(6) + ' ' + positions[i * 3 + 2].toFixed(6));
        tris.forEach(function (t) { out.push('f ' + (t[0] + 1) + ' ' + (t[1] + 1) + ' ' + (t[2] + 1)); });
        return out.join('\n');
      },
      toSTL: function () {
        var out = ['solid origami'];
        tris.forEach(function (t) {
          out.push('  facet normal 0 0 0', '    outer loop');
          t.forEach(function (o) { out.push('      vertex ' + positions[o * 3].toFixed(6) + ' ' + positions[o * 3 + 1].toFixed(6) + ' ' + positions[o * 3 + 2].toFixed(6)); });
          out.push('    endloop', '  endfacet');
        });
        out.push('endsolid origami');
        return out.join('\n');
      }
    };
  }

  global.StepFold = {
    create: create, clone: clone, fold: fold, crease: crease, unfold: unfold, unfoldAll: unfoldAll, flip: flip, rotate: rotate, applyOp: applyOp, bounds: bounds, hitFacet: hitFacet,
    lineFromPoints: lineFromPoints, pointToPoint: pointToPoint, edgeToEdge: edgeToEdge,
    visibleFaces: visibleFaces, outlineEdges: outlineEdges, snapPoints: snapPoints, totalArea: totalArea,
    creasePattern: creasePattern, threeDPose: threeDPose, buildPoseModel: buildPoseModel, serialize: serialize, deserialize: deserialize,
    unfoldLayer: unfoldLayer, removeFold: removeFold, facetAt: facetAt, peelLayer: peelLayer, tuckLayer: tuckLayer,
    affine: { apply: apply, compose: compose, invert: invert, det: det, reflection: reflection }
  };
})(typeof window !== 'undefined' ? window : globalThis);
