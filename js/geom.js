/*
 * geom.js — 2D/3D geometry helpers shared by every module.
 * Exposes window.OG (Origami Geometry). Points are plain arrays [x, y] or [x, y, z].
 */
(function (global) {
  'use strict';

  var EPS = 1e-9;

  // ---------- 2D ----------
  function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function cross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
  function len(a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1]); }
  function dist(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
  function norm(a) { var l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function perp(a) { return [-a[1], a[0]]; }
  function rotate(p, ang, c) {
    c = c || [0, 0];
    var s = Math.sin(ang), co = Math.cos(ang), x = p[0] - c[0], y = p[1] - c[1];
    return [c[0] + x * co - y * s, c[1] + x * s + y * co];
  }
  function orient(a, b, p) { return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); }

  // Closest point parameter t of p onto segment ab, clamped to [0,1].
  function projectT(p, a, b) {
    var ab = sub(b, a), l2 = dot(ab, ab);
    if (l2 < EPS * EPS) return 0;
    return Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  }
  function pointSegDist(p, a, b) { return dist(p, lerp(a, b, projectT(p, a, b))); }

  // Segment-segment proper intersection. Returns {t,u,p} or null. Parallel → null.
  function segIntersect(a, b, c, d, eps) {
    eps = eps === undefined ? 1e-10 : eps;
    var r = sub(b, a), s = sub(d, c), rs = cross(r, s);
    if (Math.abs(rs) < 1e-14) return null;
    var qp = sub(c, a);
    var t = cross(qp, s) / rs, u = cross(qp, r) / rs;
    if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
    return { t: t, u: u, p: [a[0] + r[0] * t, a[1] + r[1] * t] };
  }
  // Infinite line intersection (point + direction)
  function lineIntersect(p, dp, q, dq) {
    var rs = cross(dp, dq);
    if (Math.abs(rs) < 1e-14) return null;
    var t = cross(sub(q, p), dq) / rs;
    return [p[0] + dp[0] * t, p[1] + dp[1] * t];
  }
  function collinear(a, b, c, d, tol) {
    tol = tol || 1e-9;
    var L = Math.max(dist(a, b), 1e-12);
    return Math.abs(orient(a, b, c)) / L < tol && Math.abs(orient(a, b, d)) / L < tol;
  }

  // Signed area (CCW positive, y-up math convention).
  function polyArea(poly) {
    var s = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  }
  function polyCentroid(poly) {
    var cx = 0, cy = 0, A = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n], f = a[0] * b[1] - b[0] * a[1];
      cx += (a[0] + b[0]) * f; cy += (a[1] + b[1]) * f; A += f;
    }
    if (Math.abs(A) < EPS) {
      var sx = 0, sy = 0; poly.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return [sx / poly.length, sy / poly.length];
    }
    return [cx / (3 * A), cy / (3 * A)];
  }
  function pointInPoly(p, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if (((a[1] > p[1]) !== (b[1] > p[1])) && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0])) inside = !inside;
    }
    return inside;
  }
  function pointOnPolyBoundary(p, poly, tol) {
    for (var i = 0; i < poly.length; i++) if (pointSegDist(p, poly[i], poly[(i + 1) % poly.length]) < tol) return true;
    return false;
  }

  // Clip a line (or segment) against a convex CCW polygon (Cyrus–Beck).
  // When infinite=true the line through a,b is clipped; otherwise the segment.
  function clipSegmentConvex(a, b, poly, infinite) {
    var d = sub(b, a), t0 = infinite ? -1e9 : 0, t1 = infinite ? 1e9 : 1;
    var ccw = polyArea(poly) > 0 ? 1 : -1;
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i], q = poly[(i + 1) % poly.length];
      var e = sub(q, p);
      var n = ccw > 0 ? [e[1], -e[0]] : [-e[1], e[0]]; // outward normal
      var num = dot(n, sub(a, p)), den = dot(n, d);
      if (Math.abs(den) < 1e-15) { if (num > 1e-12) return null; continue; }
      var t = -num / den;
      if (den < 0) { if (t > t0) t0 = t; } else { if (t < t1) t1 = t; }
      if (t0 > t1 + 1e-12) return null;
    }
    if (t1 - t0 < 1e-9) return null;
    return [lerp(a, b, t0), lerp(a, b, t1)];
  }

  // Ear clipping triangulation of a simple polygon (array of indices into pts).
  // Robust to collinear vertices. Returns array of [i,j,k] (indices into idx list values).
  function triangulate(idx, pts) {
    var poly = idx.slice();
    var tris = [];
    var area = 0;
    for (var i = 0; i < poly.length; i++) {
      var a = pts[poly[i]], b = pts[poly[(i + 1) % poly.length]];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (area < 0) poly.reverse();
    function isConvex(a, b, c) { return orient(a, b, c) > 1e-12; }
    function inTri(p, a, b, c) {
      var d1 = orient(a, b, p), d2 = orient(b, c, p), d3 = orient(c, a, p);
      return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
    }
    // Prefer ears producing well-shaped triangles: pick the best-quality ear each round.
    var guard = 0;
    while (poly.length > 3 && guard++ < 10000) {
      var best = -1, bestQ = -Infinity, n = poly.length;
      for (var k = 0; k < n; k++) {
        var ia = poly[(k + n - 1) % n], ib = poly[k], ic = poly[(k + 1) % n];
        var A = pts[ia], B = pts[ib], C = pts[ic];
        if (!isConvex(A, B, C)) continue;
        var ok = true;
        for (var m = 0; m < n; m++) {
          var im = poly[m];
          if (im === ia || im === ib || im === ic) continue;
          var P = pts[im];
          if ((P[0] === A[0] && P[1] === A[1]) || (P[0] === C[0] && P[1] === C[1])) continue;
          if (inTri(P, A, B, C)) { ok = false; break; }
        }
        if (!ok) continue;
        // quality: min angle proxy = area / (sum of squared edge lengths)
        var ar = orient(A, B, C) / 2;
        var q = ar / (dot(sub(A, B), sub(A, B)) + dot(sub(B, C), sub(B, C)) + dot(sub(C, A), sub(C, A)));
        if (q > bestQ) { bestQ = q; best = k; }
      }
      if (best < 0) {
        // Degenerate: remove a collinear vertex if any, otherwise fan.
        var removed = false;
        for (var r = 0; r < poly.length; r++) {
          var pa = pts[poly[(r + poly.length - 1) % poly.length]], pb = pts[poly[r]], pc = pts[poly[(r + 1) % poly.length]];
          if (Math.abs(orient(pa, pb, pc)) < 1e-12) {
            // keep vertex to stay conforming: split as a zero-area ear is invalid, so connect it later via fan
            break;
          }
        }
        if (!removed) {
          for (var f = 1; f < poly.length - 1; f++) tris.push([poly[0], poly[f], poly[f + 1]]);
          return tris;
        }
      }
      var nn = poly.length;
      tris.push([poly[(best + nn - 1) % nn], poly[best], poly[(best + 1) % nn]]);
      poly.splice(best, 1);
    }
    if (poly.length === 3) tris.push([poly[0], poly[1], poly[2]]);
    return tris;
  }

  // ---------- 3D ----------
  var V3 = {
    add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    scale: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    cross: function (a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; },
    len: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    norm: function (a) { var l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); return l < 1e-15 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]; }
  };

  // Column-major 4x4 matrices (WebGL convention)
  var M4 = {
    identity: function () { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
    multiply: function (a, b) {
      var o = new Array(16);
      for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    },
    perspective: function (fovy, aspect, near, far) {
      var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
    },
    ortho: function (l, r, b, t, n, f) {
      return [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1];
    },
    lookAt: function (eye, target, up) {
      var z = V3.norm(V3.sub(eye, target));
      var x = V3.norm(V3.cross(up, z));
      var y = V3.cross(z, x);
      return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
        -V3.dot(x, eye), -V3.dot(y, eye), -V3.dot(z, eye), 1];
    },
    transformPoint: function (m, p) {
      var x = p[0], y = p[1], z = p[2];
      var w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w, w];
    }
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function deg(r) { return r * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }
  function fmt(n, d) { return (Math.round(n * Math.pow(10, d === undefined ? 3 : d)) / Math.pow(10, d === undefined ? 3 : d)).toString(); }

  global.OG = {
    EPS: EPS, add: add, sub: sub, scale: scale, dot: dot, cross: cross, len: len, dist: dist, norm: norm,
    lerp: lerp, perp: perp, rotate: rotate, orient: orient, projectT: projectT, pointSegDist: pointSegDist,
    segIntersect: segIntersect, lineIntersect: lineIntersect, collinear: collinear, polyArea: polyArea,
    polyCentroid: polyCentroid, pointInPoly: pointInPoly, pointOnPolyBoundary: pointOnPolyBoundary,
    clipSegmentConvex: clipSegmentConvex, triangulate: triangulate, V3: V3, M4: M4, clamp: clamp,
    wrapAngle: wrapAngle, deg: deg, rad: rad, fmt: fmt
  };
})(typeof window !== 'undefined' ? window : globalThis);
