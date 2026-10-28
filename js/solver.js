/*
 * solver.js — bar-and-hinge origami dynamics (after Ghassaei et al. 2018, "Fast, Interactive Origami Simulation
 * using GPU Computation"; dihedral gradients from Liu & Paulino 2017). CPU implementation using typed arrays.
 *
 *   var s = new OrigamiSolver(mesh)   // mesh from CP.buildMesh(doc)
 *   s.setFoldPercent(0.8); s.step(n); s.positions (Float32Array n*3)
 *
 * Every mesh edge is an axial bar (EA/L0). Every interior mesh edge is a rotational hinge driven towards
 * target = foldPercent * assignedAngle (creases) or 0 (facet / triangulation edges). Explicit integration with
 * viscous damping between neighbours, adaptive dt from the stiffest bar.
 * Dihedral angle sign: valley folds (front faces approach) are positive. 3D: X = x-cx, Y = -(y-cy), front = +Z.
 */
(function (global) {
  'use strict';

  function OrigamiSolver(mesh, opts) {
    opts = opts || {};
    this.params = {
      axialStiffness: 20,     // EA
      creaseStiffness: 0.7,   // per unit crease length
      facetStiffness: 0.7,    // flat facet hinges (triangulation diagonals, F lines)
      unassignedStiffness: 0.02,
      damping: 0.45,          // fraction of critical
      globalDamping: 0.002,
      gravity: 0,
      collision: true,        // self-collision (paper cannot pass through itself)
      thickness: 0.005,       // effective paper thickness for collisions (sheet units)
      collisionIter: 1,       // position-correction iterations per collision pass
      collisionEvery: 2       // run the collision pass every N solver steps
    };
    for (var k in opts) if (k in this.params) this.params[k] = opts[k];
    this.foldPercent = 0;
    this.load(mesh);
  }

  OrigamiSolver.prototype.load = function (mesh) {
    this.mesh = mesh;
    var n = mesh.nodes2d.length, w = mesh.width, h = mesh.height;
    var cx = w / 2, cy = h / 2;
    this.n = n;
    this.rest2d = mesh.nodes2d;
    this.positions = new Float32Array(n * 3);
    this.x = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.f = new Float64Array(n * 3);
    this.mass = new Float64Array(n);
    this.fixed = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      this.x[i * 3] = mesh.nodes2d[i][0] - cx;
      this.x[i * 3 + 1] = -(mesh.nodes2d[i][1] - cy);
      this.x[i * 3 + 2] = 0;
      this.mass[i] = 1;
    }
    // bars
    var E = mesh.edges, ne = E.length;
    this.barA = new Uint32Array(ne); this.barB = new Uint32Array(ne); this.barL0 = new Float64Array(ne);
    for (i = 0; i < ne; i++) {
      var a = E[i].n[0], b = E[i].n[1];
      this.barA[i] = a; this.barB[i] = b;
      var dx = mesh.nodes2d[a][0] - mesh.nodes2d[b][0], dy = mesh.nodes2d[a][1] - mesh.nodes2d[b][1];
      this.barL0[i] = Math.sqrt(dx * dx + dy * dy);
    }
    // hinges
    var H = mesh.hinges, nh = H.length;
    this.maxStage = 0;
    this.hA = new Uint32Array(nh); this.hB = new Uint32Array(nh); this.hC = new Uint32Array(nh); this.hD = new Uint32Array(nh);
    this.hTarget = new Float64Array(nh); this.hKind = new Uint8Array(nh); // 0 facet, 1 crease, 2 unassigned
    this.hTheta = new Float64Array(nh); this.hLen = new Float64Array(nh); this.hStage = new Uint8Array(nh);
    this.hCurve = new Array(nh);
    this.curves = mesh.curves || null;
    for (i = 0; i < nh; i++) {
      var hg = H[i];
      this.hA[i] = hg.a; this.hB[i] = hg.b; this.hC[i] = hg.c; this.hD[i] = hg.d;
      this.hTarget[i] = hg.target * Math.PI / 180;
      this.hKind[i] = hg.type === 'M' || hg.type === 'V' ? 1 : hg.type === 'U' ? 2 : 0;
      this.hLen[i] = this.barL0[hg.edge];
      this.hStage[i] = hg.stage | 0;
      this.hCurve[i] = hg.curve || null;
      if (this.hStage[i] > this.maxStage) this.maxStage = this.hStage[i];
    }
    this.px = new Float64Array(this.n * 3);
    this.buildCollisionData();
    this.computeDt();
    this.time = 0;
    this.grab = null;
    this.syncPositions();
  };

  /** Piecewise-linear lookup on a [[progress, angle], ...] table. */
  function curveLookup(table, t) {
    if (!table || !table.length) return 0;
    if (t <= table[0][0]) return table[0][1];
    for (var i = 1; i < table.length; i++) {
      if (t <= table[i][0]) {
        var a = table[i - 1], b = table[i];
        var f = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * f;
      }
    }
    return table[table.length - 1][1];
  }

  OrigamiSolver.prototype.computeDt = function () {
    var kmax = 0, p = this.params;
    for (var i = 0; i < this.barL0.length; i++) kmax = Math.max(kmax, p.axialStiffness / Math.max(this.barL0[i], 1e-6));
    // ω = sqrt(k/m); stability for explicit damped spring network with several neighbours per node
    var omega = Math.sqrt(kmax / 1);
    this.dt = 1 / (2 * Math.PI * omega) * 0.9;
    this.kmax = kmax;
  };

  OrigamiSolver.prototype.setParams = function (o) {
    for (var k in o) if (k in this.params) this.params[k] = o[k];
    this.computeDt();
  };

  OrigamiSolver.prototype.setFoldPercent = function (p) { this.foldPercent = p; };

  OrigamiSolver.prototype.reset = function () {
    var cx = this.mesh.width / 2, cy = this.mesh.height / 2;
    for (var i = 0; i < this.n; i++) {
      this.x[i * 3] = this.rest2d[i][0] - cx; this.x[i * 3 + 1] = -(this.rest2d[i][1] - cy); this.x[i * 3 + 2] = 0;
    }
    this.v.fill(0); this.hTheta.fill(0); this.time = 0;
    this.syncPositions();
  };

  /** Advance n explicit steps. */
  OrigamiSolver.prototype.step = function (steps) {
    steps = steps || 1;
    var x = this.x, v = this.v, f = this.f, n = this.n, p = this.params, dt = this.dt;
    var bA = this.barA, bB = this.barB, L0 = this.barL0, nb = L0.length;
    var hA = this.hA, hB = this.hB, hC = this.hC, hD = this.hD, nh = hA.length;
    var tgt = this.hTarget, kind = this.hKind, th = this.hTheta, hL = this.hLen;
    var EA = p.axialStiffness, fp = this.foldPercent;
    // 分步折叠：每个 stage 依次折完。maxStage=0 时就是原来的“所有折痕同时折”的行为。
    var stageScale = this.stageScale || (this.stageScale = new Float64Array(this.maxStage + 1));
    var nStage = this.maxStage + 1, fpAbs = Math.abs(fp), fpSign = fp < 0 ? -1 : 1;
    for (var si = 0; si <= this.maxStage; si++) {
      var v0 = fpAbs * nStage - si;
      stageScale[si] = (v0 <= 0 ? 0 : v0 >= 1 ? 1 : v0) * fpSign;
    }
    var zeta = p.damping, gd = p.globalDamping;
    var fixed = this.fixed, grab = this.grab;
    for (var s = 0; s < steps; s++) {
      f.fill(0);
      // ---- axial bars + damping
      for (var i = 0; i < nb; i++) {
        var a = bA[i] * 3, b = bB[i] * 3;
        var dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
        var L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
        var k = EA / L0[i];
        var fm = k * (L - L0[i]) / L;
        var c = 2 * zeta * Math.sqrt(k); // mass 1
        var fx = fm * dx + c * (v[b] - v[a]), fy = fm * dy + c * (v[b + 1] - v[a + 1]), fz = fm * dz + c * (v[b + 2] - v[a + 2]);
        f[a] += fx; f[a + 1] += fy; f[a + 2] += fz;
        f[b] -= fx; f[b + 1] -= fy; f[b + 2] -= fz;
      }
      // ---- hinges
      for (i = 0; i < nh; i++) {
        var ia = hA[i] * 3, ib = hB[i] * 3, ic = hC[i] * 3, id = hD[i] * 3;
        // e = b - a
        var ex = x[ib] - x[ia], ey = x[ib + 1] - x[ia + 1], ez = x[ib + 2] - x[ia + 2];
        var el2 = ex * ex + ey * ey + ez * ez, el = Math.sqrt(el2);
        if (el < 1e-12) continue;
        // N1 = e × (c - a)
        var cx_ = x[ic] - x[ia], cy_ = x[ic + 1] - x[ia + 1], cz_ = x[ic + 2] - x[ia + 2];
        var n1x = ey * cz_ - ez * cy_, n1y = ez * cx_ - ex * cz_, n1z = ex * cy_ - ey * cx_;
        // N2 = (a - b) × (d - b) = -e × (d - b)
        var dx_ = x[id] - x[ib], dy_ = x[id + 1] - x[ib + 1], dz_ = x[id + 2] - x[ib + 2];
        var n2x = -(ey * dz_ - ez * dy_), n2y = -(ez * dx_ - ex * dz_), n2z = -(ex * dy_ - ey * dx_);
        var n1l2 = n1x * n1x + n1y * n1y + n1z * n1z, n2l2 = n2x * n2x + n2y * n2y + n2z * n2z;
        if (n1l2 < 1e-20 || n2l2 < 1e-20) continue;
        var n1l = Math.sqrt(n1l2), n2l = Math.sqrt(n2l2);
        // θ = atan2(ê·(n2×n1), n1·n2), unwrapped against the previous value
        var crx = n2y * n1z - n2z * n1y, cry = n2z * n1x - n2x * n1z, crz = n2x * n1y - n2y * n1x;
        var sn = (crx * ex + cry * ey + crz * ez) / (el * n1l * n2l);
        var cs = (n1x * n2x + n1y * n2y + n1z * n2z) / (n1l * n2l);
        var theta = Math.atan2(sn, cs), prev = th[i];
        var diff = theta - prev;
        if (diff > Math.PI) theta -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
        else if (diff < -Math.PI) theta -= 2 * Math.PI * Math.round(diff / (2 * Math.PI));
        th[i] = theta;
        var kk = kind[i], target, kh;
        if (kk === 1) {
          // 带角度曲线的折痕（例如吉村折的对角折痕）：目标角不是线性缩放，而是随折叠进度沿“可折叠族”变化
          var cv = this.hCurve[i];
          if (cv && this.curves && this.curves[cv]) {
            var tt = Math.abs(stageScale[this.hStage[i]]);
            var full = curveLookup(this.curves[cv], tt);
            target = Math.sign(tgt[i]) * full * Math.PI / 180;
          } else target = tgt[i] * stageScale[this.hStage[i]];
          kh = p.creaseStiffness * hL[i];
        }
        else if (kk === 2) { target = theta; kh = 0; }
        else { target = 0; kh = p.facetStiffness * hL[i]; }
        var torque = -kh * (theta - target);
        if (torque === 0) continue;
        // gradients: dθ/dc = |e| N1/|N1|², dθ/dd = |e| N2/|N2|²
        var gc = el / n1l2, gdd = el / n2l2;
        var gcx = n1x * gc, gcy = n1y * gc, gcz = n1z * gc;
        var gdx = n2x * gdd, gdy = n2y * gdd, gdz = n2z * gdd;
        var tc = (cx_ * ex + cy_ * ey + cz_ * ez) / el2;
        var tdv = ((x[id] - x[ia]) * ex + (x[id + 1] - x[ia + 1]) * ey + (x[id + 2] - x[ia + 2]) * ez) / el2;
        f[ic] += torque * gcx; f[ic + 1] += torque * gcy; f[ic + 2] += torque * gcz;
        f[id] += torque * gdx; f[id + 1] += torque * gdy; f[id + 2] += torque * gdz;
        var wa1 = -(1 - tc), wa2 = -(1 - tdv), wb1 = -tc, wb2 = -tdv;
        f[ia] += torque * (wa1 * gcx + wa2 * gdx); f[ia + 1] += torque * (wa1 * gcy + wa2 * gdy); f[ia + 2] += torque * (wa1 * gcz + wa2 * gdz);
        f[ib] += torque * (wb1 * gcx + wb2 * gdx); f[ib + 1] += torque * (wb1 * gcy + wb2 * gdy); f[ib + 2] += torque * (wb1 * gcz + wb2 * gdz);
      }
      // ---- gravity & user grab spring
      if (grab) {
        var gi = grab.node * 3, gk = 4;
        for (var q = 0; q < 3; q++) f[gi + q] += gk * (grab.target[q] - x[gi + q]) - 2 * Math.sqrt(gk) * v[gi + q];
      }
      // ---- integrate (semi-implicit Euler)
      var keep = 1 - gd;
      for (i = 0; i < n; i++) {
        if (fixed[i]) { v[i * 3] = v[i * 3 + 1] = v[i * 3 + 2] = 0; continue; }
        var j = i * 3;
        v[j] = (v[j] + f[j] * dt) * keep; v[j + 1] = (v[j + 1] + f[j + 1] * dt) * keep; v[j + 2] = (v[j + 2] + f[j + 2] * dt) * keep;
        x[j] += v[j] * dt; x[j + 1] += v[j + 1] * dt; x[j + 2] += v[j + 2] * dt;
      }
      this.time += dt;
    }
    this._stepCount = (this._stepCount || 0) + 1;
    if (this.params.collision && this._stepCount % Math.max(1, this.params.collisionEvery | 0) === 0) {
      this.resolveCollisions(this.params.collisionIter);
    }
    if (!isFinite(x[0])) { this.diverged = true; this.reset(); }
    this.syncPositions();
  };

  /**
   * Static data for self-collision: for every node, the set of graph faces that must NOT be tested
   * (its own faces, faces sharing an edge/vertex with them, and faces that touch it in the flat sheet).
   * Colliding regions are always far apart in paper space, so this removes nearly all false pairs.
   */
  OrigamiSolver.prototype.buildCollisionData = function () {
    var m = this.mesh, g = m.graph, tris = m.tris, faceOf = m.triFace;
    this.faceTris = [];
    tris.forEach(function (t, ti) {
      var f = faceOf[ti];
      (this.faceTris[f] = this.faceTris[f] || []).push(ti);
    }, this);
    // faces adjacent to a face (share a graph edge or a vertex)
    var nf = g.faces.length, adj = [];
    for (var f = 0; f < nf; f++) adj.push({});
    var cornerOwner = {};
    g.faces.forEach(function (loop, f) {
      loop.forEach(function (v) { (cornerOwner[v] = cornerOwner[v] || []).push(f); });
    });
    var self = this;
    g.faces.forEach(function (loop, f) {
      loop.forEach(function (v) {
        (cornerOwner[v] || []).forEach(function (g2) { if (g2 !== f) { adj[f][g2] = 1; } });
      });
      // faces touching in the flat sheet (within ~2 edge lengths) are neighbours too
      var c1 = OG.polyCentroid(loop.map(function (i) { return g.vertices[i]; }));
      g.faces.forEach(function (loop2, f2) {
        if (f2 === f || adj[f][f2]) return;
        var c2 = OG.polyCentroid(loop2.map(function (i) { return g.vertices[i]; }));
        var dx = c1[0] - c2[0], dy = c1[1] - c2[1];
        var scale = Math.max(g.width, g.height) || 1;
        if (Math.sqrt(dx * dx + dy * dy) < 0.22 * scale) adj[f][f2] = 1;
      });
    });
    // node -> blocked face set
    var n = this.n;
    this.nodeBlocked = new Array(n);
    var nodeFaces = new Array(n);
    for (var i = 0; i < n; i++) nodeFaces[i] = [];
    tris.forEach(function (t, ti) { t.forEach(function (v) { if (nodeFaces[v].indexOf(faceOf[ti]) < 0) nodeFaces[v].push(faceOf[ti]); }); });
    for (i = 0; i < n; i++) {
      var block = {};
      nodeFaces[i].forEach(function (f) { block[f] = 1; for (var k in adj[f]) block[k] = 1; });
      this.nodeBlocked[i] = block;
    }
    // spatial hash cell size
    var avg = 0, cnt = 0;
    for (i = 0; i < this.barL0.length; i++) { avg += this.barL0[i]; cnt++; }
    avg = cnt ? avg / cnt : 0.05;
    this.collHashCell = Math.max(0.02, avg * 1.5);
    this.collisions = 0;
    this._hash = {};
  };

  /** Uniform-grid broadphase over triangles (rebuilt each call; cheap for our mesh sizes). */
  OrigamiSolver.prototype._rebuildHash = function () {
    var x = this.x, tris = this.mesh.tris, cell = this.collHashCell, hash = this._hash || (this._hash = {});
    for (var ti = 0; ti < tris.length; ti++) {
      var a = tris[ti][0] * 3, b = tris[ti][1] * 3, c = tris[ti][2] * 3;
      var minx = Math.min(x[a], x[b], x[c]), maxx = Math.max(x[a], x[b], x[c]);
      var miny = Math.min(x[a + 1], x[b + 1], x[c + 1]), maxy = Math.max(x[a + 1], x[b + 1], x[c + 1]);
      var minz = Math.min(x[a + 2], x[b + 2], x[c + 2]), maxz = Math.max(x[a + 2], x[b + 2], x[c + 2]);
      var t = this.params.thickness;
      for (var ix = Math.floor((minx - t) / cell); ix <= Math.floor((maxx + t) / cell); ix++)
        for (var iy = Math.floor((miny - t) / cell); iy <= Math.floor((maxy + t) / cell); iy++)
          for (var iz = Math.floor((minz - t) / cell); iz <= Math.floor((maxz + t) / cell); iz++) {
            var key = (ix * 73856093 ^ iy * 19349663 ^ iz * 83492791) | 0;
            var b0 = hash[key];
            if (b0 === undefined) hash[key] = [ti]; else b0.push(ti);
          }
    }
    // clear stale buckets (keys are stable per cell set, so just reset the object)
    for (var k in hash) delete hash[k];
    // rebuild into it
    for (var t2 = 0; t2 < tris.length; t2++) {
      var a2 = tris[t2][0] * 3, b2 = tris[t2][1] * 3, c2 = tris[t2][2] * 3;
      var t3 = this.params.thickness;
      var xa = x[a2], xb = x[b2], xc = x[c2];
      var ya = x[a2 + 1], yb = x[b2 + 1], yc = x[c2 + 1];
      var za = x[a2 + 2], zb = x[b2 + 2], zc = x[c2 + 2];
      var mnx = Math.min(xa, xb, xc) - t3, mxx = Math.max(xa, xb, xc) + t3;
      var mny = Math.min(ya, yb, yc) - t3, mxy = Math.max(ya, yb, yc) + t3;
      var mnz = Math.min(za, zb, zc) - t3, mxz = Math.max(za, zb, zc) + t3;
      for (var ixx = Math.floor(mnx / cell); ixx <= Math.floor(mxx / cell); ixx++)
        for (var iyy = Math.floor(mny / cell); iyy <= Math.floor(mxy / cell); iyy++)
          for (var izz = Math.floor(mnz / cell); izz <= Math.floor(mxz / cell); izz++) {
            var key2 = (ixx * 73856093 ^ iyy * 19349663 ^ izz * 83492791) | 0;
            var bb = hash[key2];
            if (bb === undefined) hash[key2] = [t2]; else bb.push(t2);
          }
    }
    this._hashBuilt = true;
  };

  /**
   * Self-collision: keep the paper from passing through itself. Positional (PBD-style) correction plus
   * normal-velocity damping, node-vs-triangle with a thickness band. Returns the number of contacts.
   */
  OrigamiSolver.prototype.resolveCollisions = function (iterations) {
    var x = this.x, v = this.v, tris = this.mesh.tris, t = this.params.thickness, cell = this.collHashCell;
    var contacts = 0, it, ti, k;
    for (it = 0; it < Math.max(1, iterations); it++) {
      this._rebuildHash();
      for (k = 0; k < this.n; k++) {
        var kx = x[k * 3], ky = x[k * 3 + 1], kz = x[k * 3 + 2];
        var key = (Math.floor(kx / cell) * 73856093 ^ Math.floor(ky / cell) * 19349663 ^ Math.floor(kz / cell) * 83492791) | 0;
        var bucket = this._hash[key];
        if (!bucket) continue;
        var blocked = this.nodeBlocked[k];
        for (var bi = 0; bi < bucket.length; bi++) {
          ti = bucket[bi];
          var tri = tris[ti];
          if (tri[0] === k || tri[1] === k || tri[2] === k) continue;
          if (blocked[this.mesh.triFace[ti]]) continue;
          var ia = tri[0] * 3, ib = tri[1] * 3, ic = tri[2] * 3;
          var ax = x[ia], ay = x[ia + 1], az = x[ia + 2];
          var ux = x[ib] - ax, uy = x[ib + 1] - ay, uz = x[ib + 2] - az;
          var wx = x[ic] - ax, wy = x[ic + 1] - ay, wz = x[ic + 2] - az;
          var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
          if (nl < 1e-12) continue;
          nx /= nl; ny /= nl; nz /= nl;
          var d = (kx - ax) * nx + (ky - ay) * ny + (kz - az) * nz;
          if (Math.abs(d) >= t) continue;
          // barycentric test (inside the triangle, with a small margin)
          var qx = kx - ax, qy = ky - ay, qz = kz - az;
          var d00 = ux * ux + uy * uy + uz * uz, d01 = ux * wx + uy * wy + uz * wz, d11 = wx * wx + wy * wy + wz * wz;
          var d20 = qx * ux + qy * uy + qz * uz, d21 = qx * wx + qy * wy + qz * wz;
          var den = d00 * d11 - d01 * d01;
          if (Math.abs(den) < 1e-18) continue;
          var s = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
          if (s < -0.02 || w < -0.02 || s + w > 1.02) continue;
          contacts++;
          // positional correction: push the node out along the ▲ normal, the triangle the other way
          var sign = d >= 0 ? 1 : -1;
          var push = (t - Math.abs(d)) * 0.9 * sign;
          var wNode = 0.75, wTri = 0.25 / 3;
          x[k * 3] += nx * push * wNode; x[k * 3 + 1] += ny * push * wNode; x[k * 3 + 2] += nz * push * wNode;
          for (var q = 0; q < 3; q++) { var iv = tri[q] * 3; x[iv] -= nx * push * wTri; x[iv + 1] -= ny * push * wTri; x[iv + 2] -= nz * push * wTri; }
          // damp the relative normal velocity so the paper settles instead of jittering
          var rvx = v[k * 3] - (v[ia] + v[ib] + v[ic]) / 3, rvy = v[k * 3 + 1] - (v[ia + 1] + v[ib + 1] + v[ic + 1]) / 3, rvz = v[k * 3 + 2] - (v[ia + 2] + v[ib + 2] + v[ic + 2]) / 3;
          var rel = rvx * nx + rvy * ny + rvz * nz;
          if (rel * sign < 0) {
            var damp = rel * 0.7;
            v[k * 3] -= nx * damp; v[k * 3 + 1] -= ny * damp; v[k * 3 + 2] -= nz * damp;
            for (q = 0; q < 3; q++) { var jv = tri[q] * 3; v[jv] += nx * damp / 3; v[jv + 1] += ny * damp / 3; v[jv + 2] += nz * damp / 3; }
          }
        }
      }
    }
    // ---- edge-edge pass: catches crossings where no vertex is inside a triangle (paper sliding through a face).
    // It is much more expensive than node-vs-triangle, so it runs at a lower cadence.
    var ed = 0;
    if (!this._edgeCount) this._edgeCount = 0;
    this._edgeCount++;
    if (this._edgeCount % 4 === 0) ed = this.edgeCollision();
    this.collisions = contacts + ed;
    return this.collisions;
  };

  /** Edge-edge (bar-bar) collision: keeps paper edges from sliding through each other. */
  OrigamiSolver.prototype.edgeCollision = function () {
    var x = this.x, v = this.v, m = this.mesh, th = this.params.thickness;
    var nb = this.barL0.length, cell = this.collHashCell * 2, contacts = 0, i;
    // per-bar midpoint + half length, to prune pairs with a cheap Chebyshev test
    var mx = new Float64Array(nb), my = new Float64Array(nb), mz = new Float64Array(nb), rl = new Float64Array(nb);
    var hash = {};
    for (i = 0; i < nb; i++) {
      var a = this.barA[i], b = this.barB[i];
      mx[i] = (x[a * 3] + x[b * 3]) * 0.5; my[i] = (x[a * 3 + 1] + x[b * 3 + 1]) * 0.5; mz[i] = (x[a * 3 + 2] + x[b * 3 + 2]) * 0.5;
      var ex = x[b * 3] - x[a * 3], ey = x[b * 3 + 1] - x[a * 3 + 1], ez = x[b * 3 + 2] - x[a * 3 + 2];
      rl[i] = Math.sqrt(ex * ex + ey * ey + ez * ez) * 0.5;
      var key = (Math.floor(mx[i] / cell) * 73856093 ^ Math.floor(my[i] / cell) * 19349663 ^ Math.floor(mz[i] / cell) * 83492791) | 0;
      var bkt = hash[key];
      if (bkt === undefined) hash[key] = [i]; else bkt.push(i);
    }
    var scale = Math.max(m.graph.width, m.graph.height) || 1;
    var rest = this.rest2d;
    for (i = 0; i < nb; i++) {
      var ia = this.barA[i], ib = this.barB[i];
      var gx = Math.floor(mx[i] / cell), gy = Math.floor(my[i] / cell), gz = Math.floor(mz[i] / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var bucket = hash[((gx + dx) * 73856093 ^ (gy + dy) * 19349663 ^ (gz + dz) * 83492791) | 0];
        if (!bucket) continue;
        for (var bi = 0; bi < bucket.length; bi++) {
          var j = bucket[bi];
          if (j <= i) continue;
          var ja = this.barA[j], jb = this.barB[j];
          if (ia === ja || ia === jb || ib === ja || ib === jb) continue;       // adjacent edges share a node
          var lim = rl[i] + rl[j] + th;
          if (Math.abs(mx[i] - mx[j]) > lim || Math.abs(my[i] - my[j]) > lim || Math.abs(mz[i] - mz[j]) > lim) continue;
          // neighbours in the flat sheet never collide (they are joined by paper)
          var pA = rest[ia], pB = rest[ib], pC = rest[ja], pD = rest[jb];
          var pdx = pA[0] + pB[0] - pC[0] - pD[0], pdy = pA[1] + pB[1] - pC[1] - pD[1];
          if (pdx * pdx + pdy * pdy < 0.09 * scale * scale) continue;
          var p1x = x[ia * 3], p1y = x[ia * 3 + 1], p1z = x[ia * 3 + 2];
          var p2x = x[ib * 3], p2y = x[ib * 3 + 1], p2z = x[ib * 3 + 2];
          var p3x = x[ja * 3], p3y = x[ja * 3 + 1], p3z = x[ja * 3 + 2];
          var p4x = x[jb * 3], p4y = x[jb * 3 + 1], p4z = x[jb * 3 + 2];
          var res = closestSegSeg([p1x, p1y, p1z], [p2x, p2y, p2z], [p3x, p3y, p3z], [p4x, p4y, p4z]);
          if (!res || res.dist >= th || res.dist < 1e-9) continue;
          var nx = res.vec[0] / res.dist, ny = res.vec[1] / res.dist, nz = res.vec[2] / res.dist;
          var push = (th - res.dist) * 0.6;
          var w1 = (1 - res.s) * 0.5, w2 = res.s * 0.5, w3 = (1 - res.t) * 0.5, w4 = res.t * 0.5;
          x[ia * 3] -= nx * push * w1; x[ia * 3 + 1] -= ny * push * w1; x[ia * 3 + 2] -= nz * push * w1;
          x[ib * 3] -= nx * push * w2; x[ib * 3 + 1] -= ny * push * w2; x[ib * 3 + 2] -= nz * push * w2;
          x[ja * 3] += nx * push * w3; x[ja * 3 + 1] += ny * push * w3; x[ja * 3 + 2] += nz * push * w3;
          x[jb * 3] += nx * push * w4; x[jb * 3 + 1] += ny * push * w4; x[jb * 3 + 2] += nz * push * w4;
          var vax = v[ia * 3] * (1 - res.s) + v[ib * 3] * res.s, vay = v[ia * 3 + 1] * (1 - res.s) + v[ib * 3 + 1] * res.s, vaz = v[ia * 3 + 2] * (1 - res.s) + v[ib * 3 + 2] * res.s;
          var vbx = v[ja * 3] * (1 - res.t) + v[jb * 3] * res.t, vby = v[ja * 3 + 1] * (1 - res.t) + v[jb * 3 + 1] * res.t, vbz = v[ja * 3 + 2] * (1 - res.t) + v[jb * 3 + 2] * res.t;
          var closing = (vax - vbx) * nx + (vay - vby) * ny + (vaz - vbz) * nz;
          if (closing > 0) {
            var f = closing * 0.5;
            v[ia * 3] -= nx * f * (1 - res.s); v[ia * 3 + 1] -= ny * f * (1 - res.s); v[ia * 3 + 2] -= nz * f * (1 - res.s);
            v[ib * 3] -= nx * f * res.s; v[ib * 3 + 1] -= ny * f * res.s; v[ib * 3 + 2] -= nz * f * res.s;
            v[ja * 3] += nx * f * (1 - res.t); v[ja * 3 + 1] += ny * f * (1 - res.t); v[ja * 3 + 2] += nz * f * (1 - res.t);
            v[jb * 3] += nx * f * res.t; v[jb * 3 + 1] += ny * f * res.t; v[jb * 3 + 2] += nz * f * res.t;
          }
          contacts++;
        }
      }
    }
    return contacts;
  };

  /** Closest points between segments p1p2 and p3p4 (returns s,t,dist,vec). */
  function closestSegSeg(p1, p2, p3, p4) {
    var ux = p2[0] - p1[0], uy = p2[1] - p1[1], uz = p2[2] - p1[2];
    var vx = p4[0] - p3[0], vy = p4[1] - p3[1], vz = p4[2] - p3[2];
    var wx = p1[0] - p3[0], wy = p1[1] - p3[1], wz = p1[2] - p3[2];
    var a = ux * ux + uy * uy + uz * uz, b = ux * vx + uy * vy + uz * vz, c = vx * vx + vy * vy + vz * vz;
    var d = ux * wx + uy * wy + uz * wz, e = vx * wx + vy * wy + vz * wz;
    var D = a * c - b * b, s, t;
    if (D < 1e-12) { s = 0; t = e / (c || 1); }
    else { s = (b * e - c * d) / D; t = (a * e - b * d) / D; }
    s = Math.max(0, Math.min(1, s));
    t = Math.max(0, Math.min(1, t));
    // clamp t for the clamped s (two passes are enough in practice)
    for (var it = 0; it < 2; it++) {
      var cx = p1[0] + ux * s - p3[0] - vx * t, cy = p1[1] + uy * s - p3[1] - vy * t, cz = p1[2] + uz * s - p3[2] - vz * t;
      t = Math.max(0, Math.min(1, (e + b * s) / (c || 1)));
      s = Math.max(0, Math.min(1, (d + b * t) / (a || 1)));
      void cx; void cy; void cz;
    }
    var px = p1[0] + ux * s - p3[0] - vx * t, py = p1[1] + uy * s - p3[1] - vy * t, pz = p1[2] + uz * s - p3[2] - vz * t;
    var dist = Math.sqrt(px * px + py * py + pz * pz);
    return { s: s, t: t, dist: dist, vec: [px, py, pz] };
  }

  /** Count current node-inside-triangle penetrations (for tests / diagnostics). */
  OrigamiSolver.prototype.countPenetrations = function (tol) {
    var x = this.x, tris = this.mesh.tris, lim = tol === undefined ? this.params.thickness * 0.5 : tol, n = 0;
    for (var k = 0; k < this.n; k++) {
      var blocked = this.nodeBlocked[k];
      for (var ti = 0; ti < tris.length; ti++) {
        var tri = tris[ti];
        if (tri[0] === k || tri[1] === k || tri[2] === k) continue;
        if (blocked[this.mesh.triFace[ti]]) continue;
        var ia = tri[0] * 3, ib = tri[1] * 3, ic = tri[2] * 3;
        var ax = x[ia], ay = x[ia + 1], az = x[ia + 2];
        var ux = x[ib] - ax, uy = x[ib + 1] - ay, uz = x[ib + 2] - az;
        var wx = x[ic] - ax, wy = x[ic + 1] - ay, wz = x[ic + 2] - az;
        var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nl < 1e-12) continue;
        var d = ((x[k * 3] - ax) * nx + (x[k * 3 + 1] - ay) * ny + (x[k * 3 + 2] - az) * nz) / nl;
        if (Math.abs(d) >= lim) continue;
        var qx = x[k * 3] - ax, qy = x[k * 3 + 1] - ay, qz = x[k * 3 + 2] - az;
        var d00 = ux * ux + uy * uy + uz * uz, d01 = ux * wx + uy * wy + uz * wz, d11 = wx * wx + wy * wy + wz * wz;
        var d20 = qx * ux + qy * uy + qz * uz, d21 = qx * wx + qy * wy + qz * wz;
        var den = d00 * d11 - d01 * d01;
        if (Math.abs(den) < 1e-18) continue;
        var s = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
        if (s < 0 || w < 0 || s + w > 1) continue;
        n++;
      }
    }
    return n;
  };

  OrigamiSolver.prototype.syncPositions = function () {
    for (var i = 0; i < this.x.length; i++) this.positions[i] = this.x[i];
  };

  /** Per-node strain (mean |ΔL|/L0 of incident bars) and global mean strain. */
  OrigamiSolver.prototype.strain = function () {
    var n = this.n, acc = new Float64Array(n), cnt = new Float64Array(n), x = this.x, total = 0, maxS = 0;
    for (var i = 0; i < this.barL0.length; i++) {
      var a = this.barA[i] * 3, b = this.barB[i] * 3;
      var dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
      var e = Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - this.barL0[i]) / this.barL0[i];
      acc[this.barA[i]] += e; acc[this.barB[i]] += e; cnt[this.barA[i]]++; cnt[this.barB[i]]++;
      total += e; if (e > maxS) maxS = e;
    }
    for (i = 0; i < n; i++) acc[i] = cnt[i] ? acc[i] / cnt[i] : 0;
    return { node: acc, mean: total / Math.max(1, this.barL0.length), max: maxS };
  };

  /** Kinetic energy, used for "settled" detection. */
  OrigamiSolver.prototype.kinetic = function () {
    var s = 0, v = this.v;
    for (var i = 0; i < v.length; i++) s += v[i] * v[i];
    return s / Math.max(1, this.n);
  };

  /** Mean absolute angle error of creases w.r.t. their (staged) target (degrees). */
  OrigamiSolver.prototype.creaseError = function () {
    var s = 0, c = 0, nStage = (this.maxStage || 0) + 1, fpAbs = Math.abs(this.foldPercent), sgn = this.foldPercent < 0 ? -1 : 1;
    for (var i = 0; i < this.hKind.length; i++) {
      if (this.hKind[i] !== 1) continue;
      var v0 = fpAbs * nStage - (this.hStage[i] || 0);
      var scale = (v0 <= 0 ? 0 : v0 >= 1 ? 1 : v0) * sgn;
      var targetRad = this.hTarget[i] * scale;
      var cv = this.hCurve[i];
      if (cv && this.curves && this.curves[cv]) {
        targetRad = Math.sign(this.hTarget[i]) * curveLookup(this.curves[cv], Math.abs(scale)) * Math.PI / 180;
      }
      s += Math.abs(this.hTheta[i] - targetRad); c++;
    }
    return c ? s / c * 180 / Math.PI : 0;
  };

  OrigamiSolver.prototype.bounds = function () {
    var x = this.x, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < this.n; i++) for (var q = 0; q < 3; q++) { var t = x[i * 3 + q]; if (t < mn[q]) mn[q] = t; if (t > mx[q]) mx[q] = t; }
    return { min: mn, max: mx };
  };

  OrigamiSolver.prototype.setGrab = function (node, target) { this.grab = node === null || node === undefined ? null : { node: node, target: target }; };

  /**
   * Gently rotate the whole model (rigid body) so the area-weighted mean normal of the paper points back to +Z
   * (towards the viewer / up). Keeps one-sided folds from tumbling the sheet out of view.
   * alpha = fraction of the needed correction applied per call (0..1).
   */
  OrigamiSolver.prototype.orient = function (alpha) {
    // 让“大致平整/已折平”的纸慢慢转正面朝观众；真正的立体模型（盒子、立体卡）保持自己的姿态。
    // 用面积加权的「方向张量」的主轴当纸面法向：它对正反面不敏感（折平的多层不会互相抵消），
    // 而且连续、不会像“最大面积面”那样来回跳，所以不会抖。
    var x = this.x, m = this.mesh, tris = m.tris, n = this.n, t, i, j, a, b, c;
    var xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0, area = 0;
    for (t = 0; t < tris.length; t++) {
      a = tris[t][0] * 3; b = tris[t][1] * 3; c = tris[t][2] * 3;
      var ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      var vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var ar = Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5, L = 2 * ar;
      if (L < 1e-12) continue;
      nx /= L; ny /= L; nz /= L;
      xx += ar * nx * nx; xy += ar * nx * ny; xz += ar * nx * nz;
      yy += ar * ny * ny; yz += ar * ny * nz; zz += ar * nz * nz;
      area += ar;
    }
    if (area < 1e-9) { this._orientErr = 0; return; }
    // 幂迭代求主特征向量（初值取 +Z）
    var v0x = 0, v0y = 0, v0z = 1;
    for (var it = 0; it < 12; it++) {
      var wx = xx * v0x + xy * v0y + xz * v0z;
      var wy = xy * v0x + yy * v0y + yz * v0z;
      var wz = xz * v0x + yz * v0y + zz * v0z;
      var wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wl < 1e-12) { this._orientErr = 0; return; }
      v0x = wx / wl; v0y = wy / wl; v0z = wz / wl;
    }
    var nx2 = v0x, ny2 = v0y, nz2 = v0z;
    // 主轴对应的“投影面积占比”：越接近 1 越平整（盒子之类会明显小于 1）
    var wx2 = xx * nx2 + xy * ny2 + xz * nz2, wy2 = xy * nx2 + yy * ny2 + yz * nz2, wz2 = xz * nx2 + yz * ny2 + zz * nz2;
    var flatness = (nx2 * wx2 + ny2 * wy2 + nz2 * wz2) / area;
    this._flatness = flatness;
    if (nz2 < 0) { nx2 = -nx2; ny2 = -ny2; nz2 = -nz2; }     // 取朝观众的一侧
    var err = Math.acos(Math.max(-1, Math.min(1, nz2)));
    this._orientErr = err;
    if (flatness < 0.6) { this._rotEma = null; return; }        // 立体模型：不强行摆平
    if (err < 0.02) { this._rotEma = null; return; }            // 死区 ≈1.1°
    var rvx = ny2, rvy = -nx2, rl = Math.sqrt(rvx * rvx + rvy * rvy);
    if (rl < 1e-9) { this._rotEma = null; return; }
    rvx /= rl; rvy /= rl;
    if (!this._rotEma) this._rotEma = [rvx, rvy];
    else { this._rotEma[0] += (rvx - this._rotEma[0]) * 0.25; this._rotEma[1] += (rvy - this._rotEma[1]) * 0.25; }
    var el = Math.sqrt(this._rotEma[0] * this._rotEma[0] + this._rotEma[1] * this._rotEma[1]);
    if (el < 1e-6) { this._rotEma = [rvx, rvy]; el = 1; }
    var hx = this._rotEma[0] / el, hy = this._rotEma[1] / el;
    var step = Math.min(err * 0.5, 0.09);
    var co = Math.cos(step), si = Math.sin(step), ic = 1 - co;
    var r00 = co + hx * hx * ic, r01 = hx * hy * ic, r02 = hy * si;
    var r10 = hy * hx * ic, r11 = co + hy * hy * ic, r12 = -hx * si;
    var r20 = -hy * si, r21 = hx * si, r22 = co;
    var v = this.v, px, py, pz;
    for (i = 0; i < n; i++) {
      j = i * 3; px = x[j]; py = x[j + 1]; pz = x[j + 2];
      x[j] = r00 * px + r01 * py + r02 * pz;
      x[j + 1] = r10 * px + r11 * py + r12 * pz;
      x[j + 2] = r20 * px + r21 * py + r22 * pz;
    }
    for (i = 0; i < n; i++) {
      j = i * 3; px = v[j]; py = v[j + 1]; pz = v[j + 2];
      v[j] = r00 * px + r01 * py + r02 * pz;
      v[j + 1] = r10 * px + r11 * py + r12 * pz;
      v[j + 2] = r20 * px + r21 * py + r22 * pz;
    }
    this.syncPositions();
  };

  /** Largest nodal speed (used by the app's sleep logic). */
  OrigamiSolver.prototype.maxSpeed = function () {
    var v = this.v, m = 0, n = v.length;
    for (var i = 0; i < n; i++) { var a = v[i] < 0 ? -v[i] : v[i]; if (a > m) m = a; }
    return m;
  };

  /** Rigid-body-free re-centering (translate centroid to origin). */
  OrigamiSolver.prototype.recenter = function () {
    var c = [0, 0, 0], x = this.x, n = this.n;
    for (var i = 0; i < n; i++) { c[0] += x[i * 3]; c[1] += x[i * 3 + 1]; c[2] += x[i * 3 + 2]; }
    c = c.map(function (t) { return t / n; });
    for (i = 0; i < n; i++) { x[i * 3] -= c[0]; x[i * 3 + 1] -= c[1]; x[i * 3 + 2] -= c[2]; }
    this.syncPositions();
  };

  /** Export the folded state as a FOLD object (3D vertices). */
  OrigamiSolver.prototype.toFOLD = function (name) {
    var m = this.mesh, x = this.x, verts = [];
    for (var i = 0; i < this.n; i++) verts.push([x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]);
    return {
      file_spec: 1.1, file_creator: '折纸仿真平台 Origami Studio', file_classes: ['singleModel'],
      frame_title: (name || 'model') + ' (folded ' + Math.round(this.foldPercent * 100) + '%)',
      frame_classes: ['foldedForm'], frame_attributes: ['3D'],
      vertices_coords: verts,
      edges_vertices: m.edges.map(function (e) { return e.n.slice(); }),
      edges_assignment: m.edges.map(function (e) { return e.line ? e.type : 'F'; }),
      faces_vertices: m.tris.map(function (t) { return t.slice(); })
    };
  };

  /** Wavefront OBJ of the folded state (front & back as one double-sided surface). */
  OrigamiSolver.prototype.toOBJ = function (name) {
    var m = this.mesh, x = this.x, out = ['# 折纸仿真平台 Origami Studio', 'o ' + (name || 'origami').replace(/\s+/g, '_')];
    for (var i = 0; i < this.n; i++) out.push('v ' + x[i * 3].toFixed(6) + ' ' + x[i * 3 + 1].toFixed(6) + ' ' + x[i * 3 + 2].toFixed(6));
    for (i = 0; i < this.n; i++) out.push('vt ' + (m.nodes2d[i][0] / m.width).toFixed(6) + ' ' + (1 - m.nodes2d[i][1] / m.height).toFixed(6));
    m.tris.forEach(function (t) { out.push('f ' + (t[0] + 1) + '/' + (t[0] + 1) + ' ' + (t[1] + 1) + '/' + (t[1] + 1) + ' ' + (t[2] + 1) + '/' + (t[2] + 1)); });
    return out.join('\n') + '\n';
  };

  /** Binary STL (thin shell: both faces). Returns ArrayBuffer. */
  OrigamiSolver.prototype.toSTL = function (thickness) {
    var m = this.mesh, x = this.x, tris = m.tris, nt = tris.length * 2;
    var buf = new ArrayBuffer(84 + nt * 50), dv = new DataView(buf);
    var hdr = 'Origami Studio STL';
    for (var i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i));
    dv.setUint32(80, nt, true);
    var off = 84;
    function P(i) { return [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]]; }
    function write(a, b, c) {
      var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      var nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0], l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      [nx / l, ny / l, nz / l].concat(a, b, c).forEach(function (val) { dv.setFloat32(off, val, true); off += 4; });
      dv.setUint16(off, 0, true); off += 2;
    }
    var t = thickness || 0;
    tris.forEach(function (tr) {
      var a = P(tr[0]), b = P(tr[1]), c = P(tr[2]);
      write(a, b, c);
      write(a, c, b);
    });
    return buf;
  };

  OrigamiSolver.curveLookup = curveLookup;
  global.OrigamiSolver = OrigamiSolver;
})(typeof window !== 'undefined' ? window : globalThis);
