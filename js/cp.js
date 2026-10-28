/*
 * cp.js — crease-pattern model.
 *   CP.normalize(lines, {width,height})  -> planar line set (split at intersections, merged, deduped)
 *   CP.buildGraph(doc)                   -> { vertices, edges, faces, warnings }
 *   CP.buildMesh(doc)                    -> triangulated mesh + hinge/bar topology for the solver
 *   CP.validate(doc)                     -> Maekawa / Kawasaki check per interior vertex
 *   CP.toFOLD / fromFOLD / toSVG / fromSVG / stats / clone
 * Paper coordinates: y down, sheet [0,w]x[0,h]. See SPEC.md.
 */
(function (global) {
  'use strict';
  var OG = global.OG;
  var TYPES = ['B', 'M', 'V', 'F', 'U', 'C'];
  var COLORS = { B: '#1f2328', M: '#e5484d', V: '#3e7bfa', F: '#b6b6b6', U: '#e0a526', C: '#2fb36d' };
  var NAMES = { B: '边界', M: '山折', V: '谷折', F: '平面线', U: '未指定', C: '剪切' };

  function clone(doc) { return JSON.parse(JSON.stringify(doc)); }
  function defaultAngle(type) { return (type === 'M' || type === 'V') ? 180 : 0; }

  // Clip segment to the axis-aligned sheet rectangle (Liang–Barsky).
  function clipToRect(a, b, w, h) {
    var t0 = 0, t1 = 1, dx = b[0] - a[0], dy = b[1] - a[1];
    var p = [-dx, dx, -dy, dy], q = [a[0], w - a[0], a[1], h - a[1]];
    for (var i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-15) { if (q[i] < -1e-12) return null; continue; }
      var r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
  }

  function onBoundary(p, w, h, tol) {
    return Math.abs(p[0]) < tol || Math.abs(p[1]) < tol || Math.abs(p[0] - w) < tol || Math.abs(p[1] - h) < tol;
  }
  function sameBoundarySide(a, b, w, h, tol) {
    return (Math.abs(a[0]) < tol && Math.abs(b[0]) < tol) || (Math.abs(a[1]) < tol && Math.abs(b[1]) < tol) ||
      (Math.abs(a[0] - w) < tol && Math.abs(b[0] - w) < tol) || (Math.abs(a[1] - h) < tol && Math.abs(b[1] - h) < tol);
  }

  /**
   * Planarize: returns new line array where lines only meet at endpoints.
   * Later lines override earlier ones on overlapping portions. Boundary edges of the sheet are always present.
   */
  /** 把靠得极近的端点合并成一个点（分步折纸导出的折痕图常常带 1e-4 级的毛刺）。
   *  用「邻格搜索」而不是单纯量化：两个点就算分属两格，只要距离够近也会合并。 */
  function snapEndpoints(pts, snapTol) {
    var clips = [], grids = {};
    function cellOf(p) { return [Math.floor(p[0] / snapTol), Math.floor(p[1] / snapTol)]; }
    function gk(cx, cy) { return cx + ',' + cy; }
    pts.forEach(function (p) {
      var c = cellOf(p), hit = null, bd = snapTol;
      for (var dx = -1; dx <= 1 && !hit; dx++) for (var dy = -1; dy <= 1 && !hit; dy++) {
        var arr = grids[gk(c[0] + dx, c[1] + dy)];
        if (!arr) continue;
        for (var k = 0; k < arr.length; k++) {
          var q = arr[k].p, d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < bd) { bd = d; hit = arr[k]; }
        }
      }
      if (hit) { hit.sum[0] += p[0]; hit.sum[1] += p[1]; hit.n++; hit.p = [hit.sum[0] / hit.n, hit.sum[1] / hit.n]; }
      else {
        var rec = { p: [p[0], p[1]], sum: [p[0], p[1]], n: 1 };
        clips.push(rec);
        var key = gk(c[0], c[1]);
        (grids[key] || (grids[key] = [])).push(rec);
      }
    });
    // 合并后的点可能移动了，再吸附一次到最近的合并点，保证端点完全重合
    return function (p) {
      var best = p, bd = snapTol;
      clips.forEach(function (r) { var d = Math.hypot(p[0] - r.p[0], p[1] - r.p[1]); if (d <= bd) { bd = d; best = r.p; } });
      return best;
    };
  }

  function normalize(lines, opts) {
    opts = opts || {};
    var w = opts.width || 1, h = opts.height || 1;
    var scale = Math.max(w, h), tol = (opts.tolerance || 1e-7) * scale;
    var snapTol = (opts.snap === undefined ? 1.5e-3 : opts.snap) * scale;
    // 先把所有端点吸附到网格：避免“差一点点”的重复顶点在 3D 网格里变成细长条三角形
    var rawPts = [];
    (lines || []).forEach(function (l) { if (l && l.a && l.b) { rawPts.push([+l.a[0], +l.a[1]], [+l.b[0], +l.b[1]]); } });
    var snap = rawPts.length ? snapEndpoints(rawPts, snapTol) : function (p) { return p; };
    var segs = [];
    // boundary first so user lines override (e.g. cut lines on boundary are meaningless but harmless)
    var corners = [[0, 0], [w, 0], [w, h], [0, h]];
    for (var c = 0; c < 4; c++) segs.push({ a: corners[c], b: corners[(c + 1) % 4], type: 'B', angle: 0 });
    (lines || []).forEach(function (l) {
      if (!l || !l.a || !l.b) return;
      var a = [+l.a[0], +l.a[1]], b = [+l.b[0], +l.b[1]];
      if (!isFinite(a[0] + a[1] + b[0] + b[1])) return;
      var cl = clipToRect(a, b, w, h);
      if (!cl) return;
      cl = [snap(cl[0]), snap(cl[1])];
      if (OG.dist(cl[0], cl[1]) < snapTol) return;          // 吸附后变成零长度的毛刺：丢掉
      var type = TYPES.indexOf(l.type) >= 0 ? l.type : 'U';
      // creases lying on the sheet edge are just boundary
      if (type !== 'B' && sameBoundarySide(cl[0], cl[1], w, h, tol)) type = 'B';
      if (type === 'B' && !sameBoundarySide(cl[0], cl[1], w, h, tol)) type = 'F'; // interior "boundary" = flat line
      var ang = (l.angle === undefined || l.angle === null || !isFinite(+l.angle)) ? defaultAngle(type) : Math.abs(+l.angle);
      segs.push({ a: cl[0], b: cl[1], type: type, angle: Math.min(180, ang), stage: Math.max(0, Math.round(+l.stage || 0)), curve: l.curve || null });
    });
    // collect split parameters
    var n = segs.length, params = segs.map(function () { return [0, 1]; });
    for (var i = 0; i < n; i++) {
      var A = segs[i];
      var minx = Math.min(A.a[0], A.b[0]) - tol, maxx = Math.max(A.a[0], A.b[0]) + tol;
      var miny = Math.min(A.a[1], A.b[1]) - tol, maxy = Math.max(A.a[1], A.b[1]) + tol;
      var La = OG.dist(A.a, A.b);
      for (var j = i + 1; j < n; j++) {
        var B = segs[j];
        if (Math.max(B.a[0], B.b[0]) < minx || Math.min(B.a[0], B.b[0]) > maxx || Math.max(B.a[1], B.b[1]) < miny || Math.min(B.a[1], B.b[1]) > maxy) continue;
        var Lb = OG.dist(B.a, B.b);
        var r = OG.sub(A.b, A.a), s = OG.sub(B.b, B.a), rs = OG.cross(r, s);
        if (Math.abs(rs) / (La * Lb) > 1e-9) {
          var qp = OG.sub(B.a, A.a), t = OG.cross(qp, s) / rs, u = OG.cross(qp, r) / rs;
          var et = tol / La, eu = tol / Lb;
          if (t > -et && t < 1 + et && u > -eu && u < 1 + eu) {
            params[i].push(Math.max(0, Math.min(1, t)));
            params[j].push(Math.max(0, Math.min(1, u)));
          }
        } else {
          // parallel: check collinearity and register endpoint projections
          if (Math.abs(OG.cross(r, OG.sub(B.a, A.a))) / La > tol) continue;
          [B.a, B.b].forEach(function (p) {
            var tt = OG.dot(OG.sub(p, A.a), r) / (La * La);
            if (tt > 0 && tt < 1) params[i].push(tt);
          });
          [A.a, A.b].forEach(function (p) {
            var uu = OG.dot(OG.sub(p, B.a), s) / (Lb * Lb);
            if (uu > 0 && uu < 1) params[j].push(uu);
          });
        }
      }
    }
    // 顶点池：把相距小于 snapTol 的点当作同一个点（否则会留下 1e-4 级细长三角形）
    var verts = [], hash = {}, vtol = Math.max(tol * 4, snapTol), cell = vtol;
    function vid(p) {
      var gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var list = hash[(gx + dx) + ',' + (gy + dy)];
        if (!list) continue;
        for (var k = 0; k < list.length; k++) if (OG.dist(verts[list[k]], p) <= vtol) return list[k];
      }
      // snap near-boundary coords exactly onto the boundary
      var q = [p[0], p[1]];
      if (Math.abs(q[0]) < tol) q[0] = 0; if (Math.abs(q[0] - w) < tol) q[0] = w;
      if (Math.abs(q[1]) < tol) q[1] = 0; if (Math.abs(q[1] - h) < tol) q[1] = h;
      verts.push(q);
      var key = gx + ',' + gy;
      (hash[key] = hash[key] || []).push(verts.length - 1);
      return verts.length - 1;
    }
    var edgeMap = {}, order = 0;
    for (i = 0; i < n; i++) {
      var ps = params[i].sort(function (x, y) { return x - y; });
      var S = segs[i], prev = null;
      for (var k = 0; k < ps.length; k++) {
        var id = vid(OG.lerp(S.a, S.b, ps[k]));
        if (prev !== null && prev !== id) {
          var key2 = prev < id ? prev + '_' + id : id + '_' + prev;
          var old = edgeMap[key2];
          // later wins, except a boundary edge can never be replaced by a crease
          if (!old || old.type !== 'B' || S.type === 'C') edgeMap[key2] = { v: [prev, id], type: S.type, angle: S.angle, stage: S.stage || 0, curve: S.curve || null, order: order++ };
        }
        prev = id;
      }
    }
    var out = [];
    Object.keys(edgeMap).forEach(function (key) {
      var e = edgeMap[key];
      var a = verts[e.v[0]], b = verts[e.v[1]];
      var type = e.type;
      if (type === 'C' && sameBoundarySide(a, b, w, h, tol)) type = 'B';
      out.push({ a: [a[0], a[1]], b: [b[0], b[1]], type: type, angle: e.angle, stage: e.stage, curve: e.curve, _o: e.order });
    });
    out.sort(function (x, y) { return x._o - y._o; });
    out.forEach(function (l) { delete l._o; });
    return out;
  }

  /** Planar graph with vertex/edge/face lists. Faces are CCW (math orientation on y-down data means CW on screen). */
  // Islands of creases not touching anything else (e.g. concentric rings) would create faces with holes.
  // Bridge each island to the rest with an invisible flat line running left to the sheet edge.
  function bridgeIslands(lines, w, h, tol) {
    var verts = [], map = {};
    function vid(p) { var k = Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol); if (map[k] === undefined) { map[k] = verts.length; verts.push(p); } return map[k]; }
    var parent = [];
    function find(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
    var es = lines.map(function (l) { var a = vid(l.a), b = vid(l.b); return [a, b]; });
    for (var i = 0; i < verts.length; i++) parent[i] = i;
    es.forEach(function (e) { parent[find(e[0])] = find(e[1]); });
    var bRoot = null;
    lines.forEach(function (l, i) { if (l.type === 'B') bRoot = find(es[i][0]); });
    var groups = {};
    verts.forEach(function (p, i) {
      var r = find(i); if (r === bRoot) return;
      if (!groups[r] || p[0] < groups[r][0]) groups[r] = p;
    });
    var extra = [];
    Object.keys(groups).forEach(function (r) { var p = groups[r]; extra.push({ a: [0, p[1]], b: [p[0], p[1]], type: 'F', angle: 0, bridge: true }); });
    return extra;
  }

  function buildGraph(doc) {
    var w = doc.width || 1, h = doc.height || 1, tol = 1e-7 * Math.max(w, h);
    var lines = normalize(doc.lines, { width: w, height: h });
    var bridges = bridgeIslands(lines, w, h, tol);
    if (bridges.length) lines = normalize(lines.concat(bridges.map(function (b) { b.type = 'F'; return b; })).sort(function (a, b) { return (a.bridge ? 0 : 1) - (b.bridge ? 0 : 1); }), { width: w, height: h });
    var verts = [], map = {};
    function key(p) { return Math.round(p[0] / tol) + ',' + Math.round(p[1] / tol); }
    function vid(p) {
      var k = key(p);
      if (map[k] !== undefined) return map[k];
      for (var i = 0; i < verts.length; i++) if (OG.dist(verts[i], p) < tol * 3) { map[k] = i; return i; }
      verts.push([p[0], p[1]]); map[k] = verts.length - 1; return verts.length - 1;
    }
    var edges = [];
    lines.forEach(function (l) { edges.push({ v: [vid(l.a), vid(l.b)], type: l.type, angle: l.angle, stage: l.stage || 0, curve: l.curve || null }); });
    var warnings = [];
    // prune dangling creases (interior vertex of degree 1) — they cannot fold and break face extraction
    var removed = 0, changed = true;
    while (changed) {
      changed = false;
      var deg = verts.map(function () { return 0; });
      edges.forEach(function (e) { if (!e.dead) { deg[e.v[0]]++; deg[e.v[1]]++; } });
      edges.forEach(function (e) {
        if (e.dead) return;
        for (var s = 0; s < 2; s++) {
          if (deg[e.v[s]] === 1 && !onBoundary(verts[e.v[s]], w, h, tol * 10) && e.type !== 'C') { e.dead = true; removed++; changed = true; return; }
        }
      });
    }
    if (removed) warnings.push('忽略了 ' + removed + ' 条悬空折痕（末端未连接其他折痕或边界）');
    edges = edges.filter(function (e) { return !e.dead; });
    // remap vertices that are still used
    var used = verts.map(function () { return false; });
    edges.forEach(function (e) { used[e.v[0]] = used[e.v[1]] = true; });
    var remap = [], nv = [];
    verts.forEach(function (p, i) { if (used[i]) { remap[i] = nv.length; nv.push(p); } });
    edges.forEach(function (e) { e.v = [remap[e.v[0]], remap[e.v[1]]]; });
    verts = nv;
    var faces = extractFaces(verts, edges);
    return { width: w, height: h, vertices: verts, edges: edges, faces: faces.faces, faceEdges: faces.faceEdges, warnings: warnings };
  }

  // Half-edge face traversal. Returns interior faces (positive signed area) as vertex index loops.
  function extractFaces(verts, edges) {
    var adj = verts.map(function () { return []; });
    edges.forEach(function (e, i) {
      var a = e.v[0], b = e.v[1];
      adj[a].push({ to: b, e: i, ang: Math.atan2(verts[b][1] - verts[a][1], verts[b][0] - verts[a][0]) });
      adj[b].push({ to: a, e: i, ang: Math.atan2(verts[a][1] - verts[b][1], verts[a][0] - verts[b][0]) });
    });
    adj.forEach(function (list) { list.sort(function (x, y) { return x.ang - y.ang; }); });
    var visited = {}, faces = [], faceEdges = [];
    for (var u = 0; u < verts.length; u++) {
      for (var k = 0; k < adj[u].length; k++) {
        var start = u + '>' + adj[u][k].to;
        if (visited[start]) continue;
        var loop = [], fe = [], cu = u, ck = k, guard = 0;
        while (guard++ < 100000) {
          var he = adj[cu][ck], hk = cu + '>' + he.to;
          if (visited[hk]) break;
          visited[hk] = true;
          loop.push(cu); fe.push(he.e);
          var v = he.to, list = adj[v];
          // find reverse half-edge index at v, then take the previous one (turn right-most → face on the left)
          var idx = -1;
          for (var m = 0; m < list.length; m++) if (list[m].to === cu && list[m].e === he.e) { idx = m; break; }
          var nk = (idx - 1 + list.length) % list.length;
          cu = v; ck = nk;
        }
        if (loop.length >= 3) {
          var poly = loop.map(function (i) { return verts[i]; });
          var A = OG.polyArea(poly);
          if (A > 1e-14) { faces.push(loop); faceEdges.push(fe); }
        }
      }
    }
    return { faces: faces, faceEdges: faceEdges };
  }

  /**
   * Triangulated simulation mesh.
   * Returns {
   *   nodes2d:[[x,y]], origin:[vertexIndex] (graph vertex each node came from; cuts duplicate nodes),
   *   tris:[[i,j,k]] (front-facing winding in 3D), triFace:[faceIndex],
   *   edges:[{n:[i,j], type, angle, crease:bool, line:bool}] unique mesh edges,
   *   hinges:[{a,b,c,d, type, angle(signed deg target), edge}] (a,b hinge nodes, c wing of tri1, d wing of tri2)
   * }
   */
  function buildMesh(doc, opts) {
    opts = opts || {};
    var g = buildGraph(doc);
    if (opts.removeIslands || doc.removeCutIslands) keepLargestComponent(g);
    var verts = g.vertices, w = g.width, h = g.height;
    var edgeKey = {};
    g.edges.forEach(function (e, i) { edgeKey[Math.min(e.v[0], e.v[1]) + '_' + Math.max(e.v[0], e.v[1])] = i; });
    // --- node duplication along cuts: group face corners at each vertex separated by cut edges
    // corner (face f, vertex v) -> node id
    var cornerNode = {};
    var nodes2d = [], origin = [];
    // Build, for each vertex, the cyclic list of (edge, face-on-left) around it.
    var vf = verts.map(function () { return []; });
    g.faces.forEach(function (loop, f) {
      for (var i = 0; i < loop.length; i++) {
        var v = loop[i], prev = loop[(i - 1 + loop.length) % loop.length], next = loop[(i + 1) % loop.length];
        vf[v].push({ f: f, i: i, prev: prev, next: next });
      }
    });
    function eType(a, b) { var id = edgeKey[Math.min(a, b) + '_' + Math.max(a, b)]; return id === undefined ? null : g.edges[id].type; }
    verts.forEach(function (p, v) {
      var corners = vf[v];
      if (!corners.length) return;
      // union corners that share a non-cut edge
      var parent = corners.map(function (_, i) { return i; });
      function find(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
      for (var i = 0; i < corners.length; i++) for (var j = i + 1; j < corners.length; j++) {
        var ci = corners[i], cj = corners[j];
        // corner i uses edges (prev,v) and (v,next); shared edge with corner j?
        var shared = null;
        if (ci.next === cj.prev) shared = ci.next; else if (ci.prev === cj.next) shared = ci.prev;
        if (shared !== null && eType(v, shared) !== 'C') parent[find(i)] = find(j);
      }
      var groupNode = {};
      corners.forEach(function (c, i) {
        var r = find(i);
        if (groupNode[r] === undefined) { groupNode[r] = nodes2d.length; nodes2d.push([p[0], p[1]]); origin.push(v); }
        cornerNode[c.f + ':' + c.i] = groupNode[r];
      });
    });
    // --- triangulate each face
    var tris = [], triFace = [];
    g.faces.forEach(function (loop, f) {
      var nodeLoop = loop.map(function (v, i) { return cornerNode[f + ':' + i]; });
      var t = OG.triangulate(nodeLoop, nodes2d);
      t.forEach(function (tri) {
        // faces are positive-area in y-down coords; 3D maps Y=-y which flips orientation, so reverse
        var A = nodes2d[tri[0]], B = nodes2d[tri[1]], C = nodes2d[tri[2]];
        if (Math.abs(OG.orient(A, B, C)) < 1e-16) return;
        if (OG.orient(A, B, C) > 0) tris.push([tri[0], tri[2], tri[1]]); else tris.push([tri[0], tri[1], tri[2]]);
        triFace.push(f);
      });
    });
    // --- mesh edges and hinges
    var medges = [], mekey = {}, edgeTris = [];
    function addEdge(i, j, tri, wing) {
      var k = Math.min(i, j) + '_' + Math.max(i, j);
      if (mekey[k] === undefined) {
        var oi = origin[i], oj = origin[j];
        var gid = edgeKey[Math.min(oi, oj) + '_' + Math.max(oi, oj)];
        var ge = gid === undefined ? null : g.edges[gid];
        mekey[k] = medges.length;
        medges.push({ n: [i, j], type: ge ? ge.type : 'F', angle: ge ? ge.angle : 0, line: !!ge, graphEdge: gid === undefined ? -1 : gid, stage: ge ? (ge.stage || 0) : 0, curve: ge ? (ge.curve || null) : null });
        edgeTris.push([]);
      }
      edgeTris[mekey[k]].push({ tri: tri, from: i, to: j, wing: wing });
    }
    tris.forEach(function (t, ti) {
      addEdge(t[0], t[1], ti, t[2]); addEdge(t[1], t[2], ti, t[0]); addEdge(t[2], t[0], ti, t[1]);
    });
    var hinges = [];
    medges.forEach(function (e, ei) {
      var et = edgeTris[ei];
      if (et.length !== 2) return; // boundary or cut
      // tri1 has directed edge a->b (front winding), wing c; tri2 has b->a, wing d
      var t1 = et[0], t2 = et[1];
      var a = t1.from, b = t1.to;
      var type = e.type;
      var sign = type === 'V' ? 1 : type === 'M' ? -1 : 0;
      var isCrease = type === 'M' || type === 'V' || type === 'U';
      hinges.push({ a: a, b: b, c: t1.wing, d: t2.wing, type: isCrease ? type : 'F', target: sign * (e.angle || 0), edge: ei, stage: e.stage || 0, curve: e.curve || null });
    });
    return { width: w, height: h, graph: g, nodes2d: nodes2d, origin: origin, tris: tris, triFace: triFace, edges: medges, hinges: hinges,
      curves: doc.curves || null, warnings: g.warnings };
  }

  // Remove faces that are separated from the main piece by cut lines (e.g. scrap areas of a net).
  function keepLargestComponent(g) {
    var nf = g.faces.length, parent = [];
    for (var i = 0; i < nf; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
    var owner = {};
    g.faceEdges.forEach(function (fe, f) {
      fe.forEach(function (e) {
        if (g.edges[e].type === 'C') return;
        if (owner[e] === undefined) owner[e] = f; else parent[find(owner[e])] = find(f);
      });
    });
    var area = {};
    g.faces.forEach(function (loop, f) { var r = find(f); area[r] = (area[r] || 0) + OG.polyArea(loop.map(function (v) { return g.vertices[v]; })); });
    var best = null;
    Object.keys(area).forEach(function (r) { if (best === null || area[r] > area[best]) best = r; });
    var faces = [], faceEdges = [];
    g.faces.forEach(function (loop, f) { if (String(find(f)) === String(best)) { faces.push(loop); faceEdges.push(g.faceEdges[f]); } });
    if (faces.length < nf) g.warnings.push('已移除 ' + (nf - faces.length) + ' 块被剪下的废料');
    g.faces = faces; g.faceEdges = faceEdges;
  }

  /** Maekawa / Kawasaki check at interior vertices. */
  function validate(doc) {
    var g = buildGraph(doc), w = g.width, h = g.height, tol = 1e-6 * Math.max(w, h);
    var inc = g.vertices.map(function () { return []; });
    g.edges.forEach(function (e) {
      if (e.type === 'B' || e.type === 'F' || e.type === 'C') return;
      inc[e.v[0]].push({ to: e.v[1], type: e.type });
      inc[e.v[1]].push({ to: e.v[0], type: e.type });
    });
    var cutAt = g.vertices.map(function () { return false; });
    g.edges.forEach(function (e) { if (e.type === 'C') cutAt[e.v[0]] = cutAt[e.v[1]] = true; });
    var res = [], bad = 0, checked = 0, curved = 0, tJunction = 0;
    g.vertices.forEach(function (p, i) {
      if (onBoundary(p, w, h, tol) || cutAt[i] || !inc[i].length) return;
      var list = inc[i].map(function (e) {
        var q = g.vertices[e.to];
        return { ang: Math.atan2(q[1] - p[1], q[0] - p[0]), type: e.type };
      }).sort(function (a, b) { return a.ang - b.ang; });
      var m = 0, v = 0, u = 0;
      list.forEach(function (e) { if (e.type === 'M') m++; else if (e.type === 'V') v++; else u++; });
      // degree-2 joint of a polyline crease (curved-crease approximation): not a flat-fold vertex, skip
      if (list.length === 2 && list[0].type === list[1].type) {
        var turn = Math.abs(Math.abs(OG.wrapAngle(list[1].ang - list[0].ang)) - Math.PI);
        if (turn < Math.PI / 6) { curved++; return; }
      }
      // collinear degree-2 vertex: a single crease just bends here (vertices created by splitting), skip
      if (list.length === 2) {
        var sep = Math.abs(OG.wrapAngle(list[1].ang - list[0].ang));
        if (sep > Math.PI - 1e-4 && list[0].type === list[1].type) { curved++; return; }
      }
      var n = list.length, kaw = 0;
      // T 形接头：一条折痕终结在另一条折痕上（奇数度顶点）——这在真实折痕图里合法，不是平折顶点
      if (n % 2 === 1) {
        for (var i2 = 0; i2 < n && n % 2 === 1; i2++) for (var j2 = i2 + 1; j2 < n; j2++) {
          var d2 = Math.abs(OG.wrapAngle(list[j2].ang - list[i2].ang));
          if (Math.abs(d2 - Math.PI) < 1e-3) { tJunction++; return; }
        }
      }
      if (n % 2 === 0) {
        var alt = 0;
        for (var k = 0; k < n; k++) {
          var a0 = list[k].ang, a1 = list[(k + 1) % n].ang;
          var sec = a1 - a0; if (sec <= 0) sec += 2 * Math.PI;
          alt += (k % 2 === 0 ? sec : -sec);
        }
        kaw = Math.abs(alt) / 2; // |sum(odd) - pi|
      } else kaw = Math.PI;
      var maekawa = u > 0 ? (Math.abs(m - v) <= 2 + u && (m + v + u) % 2 === 0) : Math.abs(m - v) === 2;
      var kawasaki = kaw < 1e-5;
      var ok = maekawa && kawasaki;
      checked++; if (!ok) bad++;
      res.push({ p: p, ok: ok, maekawa: maekawa, kawasaki: kawasaki, kawasakiError: kaw, mv: [m, v], degree: n });
    });
    var summary = checked === 0 ? (curved || tJunction ? '无平折顶点（' + (curved ? curved + ' 个折线节点' : '') + (tJunction ? (curved ? '、' : '') + tJunction + ' 个 T 形接头' : '') + '，不适用平折定理）' : '无内部顶点') : (bad === 0 ? '全部 ' + checked + ' 个内部顶点满足 Maekawa 与 Kawasaki 定理（局部可平折）'
      : bad + ' / ' + checked + ' 个内部顶点不满足平折条件');
    if (checked && curved) summary += '；另有 ' + curved + ' 个曲线折痕节点';
    return { vertices: res, ok: bad === 0, checked: checked, bad: bad, curved: curved, summary: summary, warnings: g.warnings };
  }

  function stats(doc) {
    var g = buildGraph(doc), c = { B: 0, M: 0, V: 0, F: 0, U: 0, C: 0 };
    g.edges.forEach(function (e) { c[e.type]++; });
    return { vertices: g.vertices.length, edges: g.edges.length, faces: g.faces.length, counts: c };
  }

  // ---------------- FOLD format ----------------
  var F2T = { B: 'B', M: 'M', V: 'V', F: 'F', U: 'U', C: 'C', b: 'B', m: 'M', v: 'V', f: 'F', u: 'U', c: 'C' };
  function toFOLD(doc) {
    var g = buildGraph(doc), w = g.width, h = g.height;
    return {
      file_spec: 1.1, file_creator: '折纸仿真平台 Origami Studio', file_classes: ['singleModel'],
      frame_title: doc.name || 'crease pattern', frame_classes: ['creasePattern'], frame_attributes: ['2D'],
      frame_unit: 'unit',
      vertices_coords: g.vertices.map(function (p) { return [p[0], p[1]]; }),
      edges_vertices: g.edges.map(function (e) { return e.v.slice(); }),
      edges_assignment: g.edges.map(function (e) { return e.type; }),
      edges_foldAngle: g.edges.map(function (e) { return e.type === 'V' ? e.angle : e.type === 'M' ? -e.angle : 0; }),
      faces_vertices: g.faces.map(function (f) { return f.slice(); }),
      'origamistudio:size': [w, h], 'origamistudio:description': doc.description || ''
    };
  }
  function fromFOLD(obj, name) {
    if (typeof obj === 'string') obj = JSON.parse(obj);
    var fr = obj;
    if ((!fr.vertices_coords || !fr.edges_vertices) && obj.file_frames && obj.file_frames.length) fr = obj.file_frames[0];
    if (!fr.vertices_coords || !fr.edges_vertices) throw new Error('FOLD 文件缺少 vertices_coords / edges_vertices');
    var vc = fr.vertices_coords;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    vc.forEach(function (p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); });
    var s = Math.max(maxx - minx, maxy - miny) || 1;
    var w = (maxx - minx) / s, h = (maxy - miny) / s;
    var lines = [];
    fr.edges_vertices.forEach(function (ev, i) {
      var a = vc[ev[0]], b = vc[ev[1]];
      var t = F2T[(fr.edges_assignment && fr.edges_assignment[i]) || 'U'] || 'U';
      var ang = fr.edges_foldAngle && fr.edges_foldAngle[i] !== undefined && fr.edges_foldAngle[i] !== null ? Math.abs(fr.edges_foldAngle[i]) : defaultAngle(t);
      if ((t === 'M' || t === 'V') && ang === 0 && !(fr.edges_foldAngle)) ang = 180;
      lines.push({ a: [(a[0] - minx) / s, (a[1] - miny) / s], b: [(b[0] - minx) / s, (b[1] - miny) / s], type: t, angle: ang });
    });
    return { name: name || fr.frame_title || obj.file_title || '导入的 FOLD', description: obj['origamistudio:description'] || fr.frame_description || '', width: w || 1, height: h || 1, lines: lines };
  }

  // ---------------- SVG ----------------
  function toSVG(doc, opts) {
    opts = opts || {};
    var size = opts.size || 1000, w = doc.width || 1, h = doc.height || 1, pad = opts.pad === undefined ? 20 : opts.pad;
    var lines = normalize(doc.lines, { width: w, height: h });
    var W = w * size + pad * 2, H = h * size + pad * 2;
    var dash = { M: '12 4 2 4', V: '10 6', F: '', U: '4 4', C: '', B: '' };
    var out = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">',
      '<title>' + esc(doc.name || 'crease pattern') + '</title>',
      '<rect x="' + pad + '" y="' + pad + '" width="' + w * size + '" height="' + h * size + '" fill="#ffffff" stroke="none"/>'];
    var order = { F: 0, U: 1, M: 2, V: 2, C: 3, B: 4 };
    lines.slice().sort(function (a, b) { return order[a.type] - order[b.type]; }).forEach(function (l) {
      var op = (l.type === 'M' || l.type === 'V') ? Math.max(0.15, (l.angle || 180) / 180) : 1;
      var sw = l.type === 'B' ? 3 : l.type === 'F' ? 1 : 2;
      out.push('<line x1="' + r4(pad + l.a[0] * size) + '" y1="' + r4(pad + l.a[1] * size) + '" x2="' + r4(pad + l.b[0] * size) + '" y2="' + r4(pad + l.b[1] * size) +
        '" stroke="' + COLORS[l.type] + '" stroke-width="' + sw + '"' + (opts.dashed !== false && dash[l.type] ? ' stroke-dasharray="' + dash[l.type] + '"' : '') +
        (op < 1 ? ' stroke-opacity="' + r4(op) + '"' : '') + ' stroke-linecap="round" data-type="' + l.type + '" data-angle="' + r4(l.angle || 0) + '"/>');
    });
    out.push('</svg>');
    return out.join('\n');
  }
  function r4(x) { return Math.round(x * 1e4) / 1e4; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // colour → line type (Origami Simulator conventions: red M, blue V, black B, green C, yellow/grey F, magenta U)
  function parseColor(str) {
    if (!str) return null;
    str = String(str).trim().toLowerCase();
    var named = { red: [255, 0, 0], blue: [0, 0, 255], black: [0, 0, 0], green: [0, 128, 0], lime: [0, 255, 0], yellow: [255, 255, 0], magenta: [255, 0, 255], fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], cyan: [0, 255, 255], white: [255, 255, 255], orange: [255, 165, 0], purple: [128, 0, 128] };
    if (named[str]) return named[str];
    var m = str.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
      var hx = m[1];
      if (hx.length === 3 || hx.length === 4) return [parseInt(hx[0] + hx[0], 16), parseInt(hx[1] + hx[1], 16), parseInt(hx[2] + hx[2], 16)];
      return [parseInt(hx.slice(0, 2), 16), parseInt(hx.slice(2, 4), 16), parseInt(hx.slice(4, 6), 16)];
    }
    m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var parts = m[1].split(/[ ,/]+/).filter(Boolean).map(function (x) { return x.indexOf('%') > 0 ? parseFloat(x) * 2.55 : parseFloat(x); });
      return parts.slice(0, 3);
    }
    return null;
  }
  function colorToType(rgb) {
    if (!rgb) return 'B';
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.15) return mx < 0.35 ? 'B' : 'F';
    var hue;
    if (mx === r) hue = ((g - b) / d) % 6; else if (mx === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
    hue *= 60; if (hue < 0) hue += 360;
    if (hue < 25 || hue >= 335) return 'M';
    if (hue < 70) return 'F';       // orange/yellow → facet
    if (hue < 165) return 'C';      // green → cut
    if (hue < 260) return 'V';      // cyan/blue → valley
    return 'U';                      // magenta/purple → unassigned
  }

  function parseTransform(str) {
    var m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, mt;
    function mul(a, b) { return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]]; }
    while ((mt = re.exec(str))) {
      var v = mt[2].split(/[\s,]+/).filter(Boolean).map(parseFloat), t;
      switch (mt[1]) {
        case 'matrix': t = v; break;
        case 'translate': t = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
        case 'scale': t = [v[0], 0, 0, v[1] === undefined ? v[0] : v[1], 0, 0]; break;
        case 'rotate':
          var a = (v[0] || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
          t = [c, s, -s, c, 0, 0];
          if (v.length >= 3) t = mul(mul([1, 0, 0, 1, v[1], v[2]], t), [1, 0, 0, 1, -v[1], -v[2]]);
          break;
        case 'skewX': t = [1, 0, Math.tan(v[0] * Math.PI / 180), 1, 0, 0]; break;
        case 'skewY': t = [1, Math.tan(v[0] * Math.PI / 180), 0, 1, 0, 0]; break;
      }
      m = mul(m, t);
    }
    return m;
  }

  /** Parse an SVG crease pattern (browser only — needs DOMParser). */
  function fromSVG(text, name) {
    if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 SVG 解析');
    var dom = new DOMParser().parseFromString(text, 'image/svg+xml');
    var svg = dom.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || dom.getElementsByTagName('parsererror').length) throw new Error('无法解析 SVG 文件');
    var segs = [];
    function style(el, prop) {
      for (var e = el; e && e.getAttribute; e = e.parentNode) {
        var st = e.getAttribute('style');
        if (st) {
          var re = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'), mm = st.match(re);
          if (mm) return mm[1].trim();
        }
        var at = e.getAttribute(prop);
        if (at) return at;
      }
      return null;
    }
    function ctm(el) {
      var chain = [];
      for (var e = el; e && e.getAttribute; e = e.parentNode) chain.unshift(parseTransform(e.getAttribute('transform')));
      var m = [1, 0, 0, 1, 0, 0];
      chain.forEach(function (t) { m = [m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1], m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3], m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5]]; });
      return m;
    }
    function ap(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
    function push(el, pts, closed) {
      var dt = el.getAttribute('data-type');
      var stroke = style(el, 'stroke');
      var type = dt && TYPES.indexOf(dt) >= 0 ? dt : colorToType(parseColor(stroke));
      if (stroke === 'none' && !dt) return;
      var op = parseFloat(style(el, 'stroke-opacity') || style(el, 'opacity') || '1');
      var da = el.getAttribute('data-angle');
      var ang = da !== null ? parseFloat(da) : (type === 'M' || type === 'V') ? 180 * (isFinite(op) ? op : 1) : 0;
      var m = ctm(el);
      for (var i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) {
        segs.push({ a: ap(m, pts[i]), b: ap(m, pts[(i + 1) % pts.length]), type: type, angle: ang });
      }
    }
    var all = svg.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i], tag = el.nodeName.toLowerCase().replace(/^svg:/, '');
      var num = function (n) { return parseFloat(el.getAttribute(n)) || 0; };
      if (tag === 'line') push(el, [[num('x1'), num('y1')], [num('x2'), num('y2')]], false);
      else if (tag === 'polyline' || tag === 'polygon') {
        var arr = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat), pts = [];
        for (var k = 0; k + 1 < arr.length; k += 2) pts.push([arr[k], arr[k + 1]]);
        push(el, pts, tag === 'polygon');
      } else if (tag === 'rect') {
        var x = num('x'), y = num('y'), rw = num('width'), rh = num('height');
        var fill = style(el, 'fill'), str = style(el, 'stroke');
        if (str && str !== 'none') push(el, [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]], true);
        else if (!segs.length && fill && fill !== 'none') { /* sheet background: boundary only */
          var m2 = ctm(el); var c = [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]].map(function (p) { return ap(m2, p); });
          for (var q = 0; q < 4; q++) segs.push({ a: c[q], b: c[(q + 1) % 4], type: 'B', angle: 0 });
        }
      } else if (tag === 'path') {
        parsePath(el.getAttribute('d') || '').forEach(function (sub) { push(el, sub.pts, sub.closed); });
      }
    }
    if (!segs.length) throw new Error('SVG 中没有找到线段');
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    segs.forEach(function (s) { [s.a, s.b].forEach(function (p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }); });
    var sc = Math.max(maxx - minx, maxy - miny) || 1;
    segs.forEach(function (s) { s.a = [(s.a[0] - minx) / sc, (s.a[1] - miny) / sc]; s.b = [(s.b[0] - minx) / sc, (s.b[1] - miny) / sc]; });
    return { name: name || '导入的 SVG', description: '', width: (maxx - minx) / sc || 1, height: (maxy - miny) / sc || 1, lines: segs };
  }
  // Path parser supporting M/L/H/V/Z (absolute & relative); curves are approximated by their chord.
  function parsePath(d) {
    var toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [], i = 0, cmd = null;
    var cur = [0, 0], start = [0, 0], subs = [], pts = null;
    function n() { return parseFloat(toks[i++]); }
    function flush(closed) { if (pts && pts.length > 1) subs.push({ pts: pts, closed: closed }); pts = null; }
    var argc = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      if (!cmd) break;
      var C = cmd.toUpperCase(), rel = cmd !== C;
      if (C === 'Z') { if (pts) { flush(true); } cur = start.slice(); cmd = null; continue; }
      if (i >= toks.length || /[a-zA-Z]/.test(toks[i])) { if (argc[C] === 0) continue; else { i++; continue; } }
      var p;
      if (C === 'M') { flush(false); p = [n(), n()]; if (rel) p = [cur[0] + p[0], cur[1] + p[1]]; start = p; pts = [p]; cur = p; cmd = rel ? 'l' : 'L'; continue; }
      if (C === 'L' || C === 'T') { p = [n(), n()]; if (rel) p = [cur[0] + p[0], cur[1] + p[1]]; }
      else if (C === 'H') { var x = n(); p = [rel ? cur[0] + x : x, cur[1]]; }
      else if (C === 'V') { var y = n(); p = [cur[0], rel ? cur[1] + y : y]; }
      else { var k = argc[C]; var vals = []; for (var j = 0; j < k; j++) vals.push(n()); p = [vals[k - 2], vals[k - 1]]; if (rel) p = [cur[0] + p[0], cur[1] + p[1]]; }
      if (!pts) pts = [cur];
      pts.push(p); cur = p;
    }
    flush(false);
    return subs;
  }

  global.CP = {
    TYPES: TYPES, COLORS: COLORS, NAMES: NAMES, clone: clone, normalize: normalize, buildGraph: buildGraph, buildMesh: buildMesh,
    validate: validate, stats: stats, toFOLD: toFOLD, fromFOLD: fromFOLD, toSVG: toSVG, fromSVG: fromSVG,
    parseColor: parseColor, colorToType: colorToType, clipToRect: clipToRect, onBoundary: onBoundary
  };
})(typeof window !== 'undefined' ? window : globalThis);
