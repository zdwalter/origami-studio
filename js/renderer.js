/*
 * renderer.js — WebGL paper renderer with orbit camera.
 *   var r = new PaperRenderer(canvas, { onPick })
 *   r.setMesh(mesh); r.updatePositions(f32); r.render();
 * Features: double-sided paper (front/back colours, optional paper texture/pattern), soft lighting, crease lines
 * coloured by type, wireframe, strain heat map, ground shadow, orbit/pan/zoom, ray picking, PNG export.
 */
(function (global) {
  'use strict';
  var M4 = global.OG.M4, V3 = global.OG.V3;

  var VS = [
    'attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV; attribute vec3 aCol; attribute float aBias;',
    'uniform mat4 uMVP; uniform mat4 uModel;',
    'varying vec3 vNrm; varying vec2 vUV; varying vec3 vCol; varying vec3 vWorld;',
    'void main(){ vec4 w = uModel*vec4(aPos,1.0); vWorld=w.xyz; vNrm=mat3(uModel)*aNrm; vUV=aUV; vCol=aCol;',
    '  gl_Position=uMVP*vec4(aPos,1.0); gl_Position.z += aBias * gl_Position.w; }'
  ].join('\n');
  var FS = [
    'precision highp float;',
    'varying vec3 vNrm; varying vec2 vUV; varying vec3 vCol; varying vec3 vWorld;',
    'uniform vec3 uFront; uniform vec3 uBack; uniform vec3 uEye; uniform vec3 uLight;',
    'uniform float uUseCol; uniform float uPattern; uniform float uTexture; uniform float uAlpha; uniform float uAmbient; uniform float uFixed;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }',
    'float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }',
    'void main(){',
    '  vec3 n = normalize(vNrm); vec3 v = normalize(uEye - vWorld);',
    '  bool front = gl_FrontFacing;',
    '  if(!front) n = -n;',
    '  vec3 base = front ? uFront : uBack;',
    '  if(uPattern > 0.5 && front){',
    '    vec2 g = vUV*8.0; float c = mod(floor(g.x)+floor(g.y), 2.0);',
    '    if(uPattern < 1.5) base *= mix(0.86, 1.0, c);',
    '    else { float d = length(fract(g)-0.5); base = mix(base, base*0.78, smoothstep(0.22,0.18,d)); }',
    '  }',
    '  if(uTexture > 0.5){ float fib = noise(vUV*vec2(900.0,120.0))*0.5 + noise(vUV*260.0)*0.5; base *= 0.95 + 0.07*fib; }',
    '  if(uUseCol > 0.5) base = vCol;',
    '  if(uFixed > 0.5) base = vCol;',
    '  vec3 L = normalize(uLight);',
    '  float diff = max(dot(n, L), 0.0); float fill = max(dot(n, normalize(vec3(-0.4,0.3,-0.6))), 0.0);',
    '  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);',
    '  vec3 h = normalize(L + v); float spec = pow(max(dot(n,h),0.0), 40.0)*0.08;',
    '  float shade = clamp(uAmbient + (1.0 - uAmbient)*(diff + 0.14*fill), 0.0, 1.0);',
    '  vec3 col = base*shade + (spec + rim*0.05)*(1.0 - uAmbient);',
    '  gl_FragColor = vec4(col, uAlpha);',
    '}'
  ].join('\n');
  var LVS = 'attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uMVP; varying vec3 vCol; void main(){ vCol=aCol; vec4 p=uMVP*vec4(aPos,1.0); p.z -= 0.0015*p.w; gl_Position=p; }';
  var LFS = 'precision mediump float; varying vec3 vCol; uniform float uAlpha; void main(){ gl_FragColor=vec4(vCol,uAlpha); }';
  var GVS = 'attribute vec3 aPos; uniform mat4 uMVP; varying vec2 vP; void main(){ vP=aPos.xz; gl_Position=uMVP*vec4(aPos,1.0); }';
  var GFS = ['precision mediump float; varying vec2 vP; uniform vec3 uColor; uniform float uGrid;',
    'void main(){ float r=length(vP); float a = smoothstep(3.2, 0.4, r);',
    ' vec2 g = abs(fract(vP*4.0-0.5)-0.5)/fwidth(vP*4.0); float line = 1.0-min(min(g.x,g.y),1.0);',
    ' vec2 g2 = abs(fract(vP-0.5)-0.5)/fwidth(vP); float line2 = 1.0-min(min(g2.x,g2.y),1.0);',
    ' float l = max(line*0.35, line2*0.7)*uGrid;',
    ' gl_FragColor = vec4(uColor, l*a*0.35); }'].join('\n');
  var SVS = 'attribute vec3 aPos; uniform mat4 uMVP; uniform float uY; void main(){ gl_Position=uMVP*vec4(aPos.x, uY, aPos.z, 1.0); }';
  var SFS = 'precision mediump float; uniform float uAlpha; void main(){ gl_FragColor=vec4(0.0,0.0,0.0,uAlpha); }';

  function hex(c) {
    c = c.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    return [parseInt(c.slice(0, 2), 16) / 255, parseInt(c.slice(2, 4), 16) / 255, parseInt(c.slice(4, 6), 16) / 255];
  }
  var LINE_COLORS = { B: '#2a2a2a', M: '#e5484d', V: '#3e7bfa', F: '#9a9a9a', U: '#e0a526', C: '#2fb36d', W: '#555555' };

  function PaperRenderer(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    var gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true, alpha: true }) ||
      canvas.getContext('experimental-webgl', { antialias: true, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('浏览器不支持 WebGL');
    this.gl = gl;
    this.uint = !!gl.getExtension('OES_element_index_uint');
    gl.getExtension('OES_standard_derivatives');
    this.progPaper = this._program(VS, FS);
    this.progLine = this._program(LVS, LFS);
    this.progShadow = this._program(SVS, SFS);
    var gfs = '#extension GL_OES_standard_derivatives : enable\n' + GFS;
    try { this.progGround = this._program(GVS, gfs); } catch (e) { this.progGround = null; }
    this.buf = {};
    ['pos', 'nrm', 'uv', 'col', 'idx', 'lpos', 'lcol', 'wpos', 'wcol', 'ground'].forEach(function (k) { this.buf[k] = gl.createBuffer(); }, this);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.ground);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, -4, 4, 0, 4, -4, 0, 4]), gl.STATIC_DRAW);
    this.opts = {
      front: '#e8553d', back: '#f6f1e7', showCreases: true, showBoundary: true, showFacets: false, showWire: false,
      showStrain: false, showGround: true, showShadow: true, pattern: 0, texture: true, lineWidth: 1, creaseOpacity: 0.9,
      background: null, projection: 'perspective'
    };
    this.cam = { yaw: -0.55, pitch: 0.75, dist: 2.6, target: [0, 0, 0], fov: 40 * Math.PI / 180 };
    this.camGoal = null;
    this.mesh = null;
    this.onPick = opts.onPick || null;
    this.onCamera = opts.onCamera || null;
    this.onDragNode = opts.onDragNode || null;
    this.interactive = true;
    this._bindEvents();
    this.resize();
  }

  PaperRenderer.prototype._program = function (vs, fs) {
    var gl = this.gl;
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.loc = {};
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES), nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < na; i++) { var a = gl.getActiveAttrib(p, i).name; p.loc[a] = gl.getAttribLocation(p, a); }
    for (i = 0; i < nu; i++) { var u = gl.getActiveUniform(p, i).name; p.loc[u] = gl.getUniformLocation(p, u); }
    return p;
  };

  PaperRenderer.prototype.set = function (o) {
    for (var k in o) this.opts[k] = o[k];
    if (this.mesh && ('showCreases' in o || 'showBoundary' in o || 'showFacets' in o)) this._uploadLines();
    this.dirty = true;
  };

  /** mesh: {positions, uvs, indices, colors?, lineIdx:[[i,j,type]]} — lines reference vertex indices so they follow the surface. */
  PaperRenderer.prototype.setMesh = function (mesh) {
    var gl = this.gl;
    this.mesh = mesh;
    this.ambient = (mesh && mesh.ambient !== undefined) ? mesh.ambient : 0.42;
    this.fPos = null;
    var nv = mesh.positions.length / 3;
    if (!this.uint && nv > 65535) throw new Error('网格过大');
    this.nrm = new Float32Array(nv * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.uv); gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
    this.colors = mesh.colors || new Float32Array(nv * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.col); gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
    // 每顶点的深度偏置：叠在一起的层靠它分出前后，几何本身不动
    this.nBias = nv;
    this.biasArr = mesh.bias && mesh.bias.length === nv ? mesh.bias : new Float32Array(nv);
    this.buf.bias = this.buf.bias || gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.bias); gl.bufferData(gl.ARRAY_BUFFER, this.biasArr, gl.STATIC_DRAW);
    this.fBias = null;
    var idx = this.uint ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.nIdx = idx.length;
    // wireframe edges (unique)
    var seen = {}, w = [];
    for (var t = 0; t < mesh.indices.length; t += 3) for (var e = 0; e < 3; e++) {
      var a = mesh.indices[t + e], b = mesh.indices[t + (e + 1) % 3], k = a < b ? a + '_' + b : b + '_' + a;
      if (!seen[k]) { seen[k] = 1; w.push(a, b); }
    }
    this.wireIdx = w;
    this._uploadLines();
    this.updatePositions(mesh.positions);
  };

  PaperRenderer.prototype._uploadLines = function () {
    var m = this.mesh, o = this.opts, list = [];
    (m.lineIdx || []).forEach(function (l) {
      var t = l[2];
      if (t === 'B' && !o.showBoundary) return;
      if ((t === 'M' || t === 'V' || t === 'U' || t === 'C') && !o.showCreases) return;
      if (t === 'F' && !o.showFacets) return;
      list.push(l);
    });
    this.lineList = list;
    var col = new Float32Array(list.length * 6);
    list.forEach(function (l, i) { var c = hex(LINE_COLORS[l[2]] || '#000'); col.set(c, i * 6); col.set(c, i * 6 + 3); });
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lcol); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    var wc = new Float32Array(this.wireIdx.length * 3), wcol = hex('#444444');
    for (var i = 0; i < this.wireIdx.length; i++) wc.set(wcol, i * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.wcol); gl.bufferData(gl.ARRAY_BUFFER, wc, gl.STATIC_DRAW);
    this.lpos = new Float32Array(list.length * 6);
    this.wpos = new Float32Array(this.wireIdx.length * 3);
    if (this.pos) this._updateLinePos();
  };

  PaperRenderer.prototype.updatePositions = function (pos) {
    var gl = this.gl, m = this.mesh;
    this.pos = pos;
    // smooth-free flat-ish normals: accumulate face normals per vertex (vertices are shared only within crease-free
    // regions? no — shared across creases, so use area-weighted average but creases still look crisp due to lines)
    var nrm = this.nrm; nrm.fill(0);
    var I = m.indices;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (var q = 0; q < 3; q++) { var j = I[t + q] * 3; nrm[j] += nx; nrm[j + 1] += ny; nrm[j + 2] += nz; }
    }
    if (this.flatShading) this._flatten(pos);
    else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.nrm); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.DYNAMIC_DRAW);
    }
    this._updateLinePos();
    this.dirty = true;
  };

  // Flat shading: draw an unindexed copy so creases look sharp (paper is piecewise flat).
  PaperRenderer.prototype._flatten = function (pos) {
    var gl = this.gl, I = this.mesh.indices, n = I.length;
    if (!this.fPos || this.fPos.length !== n * 3) {
      this.fPos = new Float32Array(n * 3); this.fNrm = new Float32Array(n * 3); this.fUV = new Float32Array(n * 2); this.fCol = new Float32Array(n * 3);
      var uv = this.mesh.uvs;
      this.fBias = new Float32Array(n);
      var biasSrc = this.biasArr || [];
      for (var i = 0; i < n; i++) {
        this.fUV[i * 2] = uv[I[i] * 2]; this.fUV[i * 2 + 1] = uv[I[i] * 2 + 1];
        this.fBias[i] = biasSrc[I[i]] || 0;
      }
      this.fBuf = this.fBuf || { pos: gl.createBuffer(), nrm: gl.createBuffer(), uv: gl.createBuffer(), col: gl.createBuffer(), bias: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.uv); gl.bufferData(gl.ARRAY_BUFFER, this.fUV, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.bias); gl.bufferData(gl.ARRAY_BUFFER, this.fBias, gl.STATIC_DRAW);
      this._flatColors();
    }
    var P = this.fPos, N = this.fNrm;
    for (var t = 0; t < n; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (var q = 0; q < 3; q++) {
        var s = I[t + q] * 3, d = (t + q) * 3;
        P[d] = pos[s]; P[d + 1] = pos[s + 1]; P[d + 2] = pos[s + 2];
        N[d] = nx; N[d + 1] = ny; N[d + 2] = nz;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.pos); gl.bufferData(gl.ARRAY_BUFFER, P, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.nrm); gl.bufferData(gl.ARRAY_BUFFER, N, gl.DYNAMIC_DRAW);
  };
  PaperRenderer.prototype._flatColors = function () {
    if (!this.fCol) return;
    var I = this.mesh.indices, C = this.colors, F = this.fCol;
    for (var i = 0; i < I.length; i++) { F[i * 3] = C[I[i] * 3]; F[i * 3 + 1] = C[I[i] * 3 + 1]; F[i * 3 + 2] = C[I[i] * 3 + 2]; }
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.col); gl.bufferData(gl.ARRAY_BUFFER, F, gl.DYNAMIC_DRAW);
  };

  PaperRenderer.prototype.setColors = function (colors) {
    this.colors.set(colors);
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.col); gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.DYNAMIC_DRAW);
    this._flatColors();
    this.dirty = true;
  };

  PaperRenderer.prototype._updateLinePos = function () {
    var p = this.pos, L = this.lineList || [], lp = this.lpos, gl = this.gl;
    if (!lp) return;
    // offset lines slightly along the vertex normal on both sides is done in shader via depth bias
    for (var i = 0; i < L.length; i++) {
      var a = L[i][0] * 3, b = L[i][1] * 3;
      lp[i * 6] = p[a]; lp[i * 6 + 1] = p[a + 1]; lp[i * 6 + 2] = p[a + 2];
      lp[i * 6 + 3] = p[b]; lp[i * 6 + 4] = p[b + 1]; lp[i * 6 + 5] = p[b + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lpos); gl.bufferData(gl.ARRAY_BUFFER, lp, gl.DYNAMIC_DRAW);
    if (this.opts.showWire) {
      var W = this.wireIdx, wp = this.wpos;
      for (i = 0; i < W.length; i++) { var s = W[i] * 3; wp[i * 3] = p[s]; wp[i * 3 + 1] = p[s + 1]; wp[i * 3 + 2] = p[s + 2]; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.wpos); gl.bufferData(gl.ARRAY_BUFFER, wp, gl.DYNAMIC_DRAW);
    }
  };

  PaperRenderer.prototype.resize = function () {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dirty = true;
  };

  PaperRenderer.prototype._matrices = function () {
    var c = this.cam, aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var eye = [c.target[0] + c.dist * Math.cos(c.pitch) * Math.sin(c.yaw), c.target[1] + c.dist * Math.sin(c.pitch), c.target[2] + c.dist * Math.cos(c.pitch) * Math.cos(c.yaw)];
    var view = M4.lookAt(eye, c.target, [0, 1, 0]);
    var proj;
    if (this.opts.projection === 'ortho') {
      var hh = c.dist * Math.tan(c.fov / 2);
      proj = M4.ortho(-hh * aspect, hh * aspect, -hh, hh, 0.01, 100);
    } else proj = M4.perspective(c.fov, aspect, 0.01, 100);
    // model: paper XY plane → world with paper lying "up" (rotate -90° about X so front faces +Y? keep XY upright)
    // paper lies on the table: model X→X, Y→-Z, Z(front)→+Y (up)
    var model = this.model || [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
    return { eye: eye, view: view, proj: proj, model: model, vp: M4.multiply(proj, view), mvp: M4.multiply(M4.multiply(proj, view), model) };
  };

  PaperRenderer.prototype.render = function () {
    var gl = this.gl, o = this.opts;
    if (this.camGoal) this._animateCam();
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh) return;
    var m = this._matrices();
    this.lastMatrices = m;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // compute ground height from mesh bounds (in world after model transform)
    var p = this.pos, minY = Infinity;
    for (var i = 1; i < p.length; i += 3) {
      var wy = (m.model[1] * p[i - 1] + m.model[5] * p[i] + m.model[9] * p[i + 1] + m.model[13]);
      if (wy < minY) minY = wy;
    }
    var gy = Math.min(minY, 0) - 0.12;
    if (o.showGround && this.progGround) {
      var pg = this.progGround;
      gl.useProgram(pg);
      var gm = M4.multiply(m.vp, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, gy, 0, 1]);
      gl.uniformMatrix4fv(pg.loc.uMVP, false, gm);
      gl.uniform3fv(pg.loc.uColor, [0.25, 0.27, 0.32]); gl.uniform1f(pg.loc.uGrid, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.ground);
      this._attr(pg, 'aPos', 3);
      gl.depthMask(false); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.depthMask(true);
      this._disable(pg);
    }
    if (o.showShadow) {
      var ps = this.progShadow;
      gl.useProgram(ps);
      // project mesh onto ground plane (vertical light) — draw as flat dark silhouette, with stencil-free alpha by depthMask
      gl.uniformMatrix4fv(ps.loc.uMVP, false, m.vp);
      gl.uniform1f(ps.loc.uY, gy + 0.001);
      gl.uniform1f(ps.loc.uAlpha, 0.08);
      // shadow uses world positions: we need model applied; build temp buffer
      if (!this.shadowPos || this.shadowPos.length !== p.length) this.shadowPos = new Float32Array(p.length);
      var sp = this.shadowPos, mm = m.model;
      for (i = 0; i < p.length; i += 3) {
        sp[i] = mm[0] * p[i] + mm[4] * p[i + 1] + mm[8] * p[i + 2] + mm[12];
        sp[i + 1] = 0;
        sp[i + 2] = mm[2] * p[i] + mm[6] * p[i + 1] + mm[10] * p[i + 2] + mm[14];
      }
      if (!this.buf.shadow) this.buf.shadow = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.shadow); gl.bufferData(gl.ARRAY_BUFFER, sp, gl.DYNAMIC_DRAW);
      this._attr(ps, 'aPos', 3);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, this.nIdx, this.uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true);
      this._disable(ps);
    }
    // paper
    var pp = this.progPaper;
    gl.useProgram(pp);
    gl.uniformMatrix4fv(pp.loc.uMVP, false, m.mvp);
    gl.uniformMatrix4fv(pp.loc.uModel, false, m.model);
    gl.uniform3fv(pp.loc.uFront, hex(o.front)); gl.uniform3fv(pp.loc.uBack, hex(o.back));
    gl.uniform3fv(pp.loc.uEye, m.eye);
    gl.uniform3fv(pp.loc.uLight, V3.norm([0.5, 0.9, 0.7]));
    gl.uniform1f(pp.loc.uUseCol, o.showStrain ? 1 : 0);
    gl.uniform1f(pp.loc.uPattern, o.pattern || 0);
    gl.uniform1f(pp.loc.uTexture, o.texture ? 1 : 0);
    gl.uniform1f(pp.loc.uAlpha, 1);
    gl.uniform1f(pp.loc.uAmbient, this.ambient === undefined ? 0.42 : this.ambient);
    gl.uniform1f(pp.loc.uFixed, this.fixedColors ? 1 : 0);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
    if (this.flatShading && this.fBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.pos); this._attr(pp, 'aPos', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.nrm); this._attr(pp, 'aNrm', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.uv); this._attr(pp, 'aUV', 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.col); this._attr(pp, 'aCol', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf.bias); this._attr(pp, 'aBias', 1);
      gl.drawArrays(gl.TRIANGLES, 0, this.nIdx);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos); this._attr(pp, 'aPos', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.nrm); this._attr(pp, 'aNrm', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.uv); this._attr(pp, 'aUV', 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.col); this._attr(pp, 'aCol', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.bias); this._attr(pp, 'aBias', 1);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.drawElements(gl.TRIANGLES, this.nIdx, this.uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    this._disable(pp);
    // lines
    var pl = this.progLine;
    gl.useProgram(pl);
    gl.uniformMatrix4fv(pl.loc.uMVP, false, m.mvp);
    if (o.showWire && this.wireIdx.length) {
      gl.uniform1f(pl.loc.uAlpha, 0.35);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.wpos); this._attr(pl, 'aPos', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.wcol); this._attr(pl, 'aCol', 3);
      gl.drawArrays(gl.LINES, 0, this.wireIdx.length);
    }
    if (this.lineList && this.lineList.length) {
      gl.uniform1f(pl.loc.uAlpha, o.creaseOpacity);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lpos); this._attr(pl, 'aPos', 3);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.lcol); this._attr(pl, 'aCol', 3);
      gl.lineWidth(o.lineWidth);
      gl.drawArrays(gl.LINES, 0, this.lineList.length * 2);
    }
    this._disable(pl);
    this.dirty = false;
  };

  PaperRenderer.prototype._attr = function (p, name, size) {
    var gl = this.gl, loc = p.loc[name];
    if (loc === undefined || loc < 0) return;
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    (this._enabled = this._enabled || []).push(loc);
  };
  PaperRenderer.prototype._disable = function () {
    var gl = this.gl;
    (this._enabled || []).forEach(function (l) { gl.disableVertexAttribArray(l); });
    this._enabled = [];
  };

  // ---------------- camera ----------------
  PaperRenderer.prototype.setView = function (name, animate) {
    var views = {
      persp: { yaw: -0.55, pitch: 0.75 }, front: { yaw: 0, pitch: 0.02 }, back: { yaw: Math.PI, pitch: 0.02 },
      top: { yaw: 0, pitch: Math.PI / 2 - 0.001 }, bottom: { yaw: 0, pitch: -Math.PI / 2 + 0.001 },
      left: { yaw: -Math.PI / 2, pitch: 0 }, right: { yaw: Math.PI / 2, pitch: 0 }
    };
    var v = views[name] || views.persp;
    var goal = { yaw: v.yaw, pitch: v.pitch, dist: this.cam.dist, target: [0, 0, 0] };
    if (animate === false) { this.cam.yaw = goal.yaw; this.cam.pitch = goal.pitch; this.cam.target = goal.target; this.camGoal = null; }
    else {
      // shortest yaw path
      var dy = global.OG.wrapAngle(goal.yaw - this.cam.yaw); goal.yaw = this.cam.yaw + dy;
      this.camGoal = goal;
    }
    this.dirty = true;
  };
  PaperRenderer.prototype.fit = function (animate) {
    if (!this.pos) return;
    var p = this.pos, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < p.length; i += 3) for (var q = 0; q < 3; q++) { mn[q] = Math.min(mn[q], p[i + q]); mx[q] = Math.max(mx[q], p[i + q]); }
    var cm = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    var c = [cm[0], cm[2], -cm[1]]; // model → world
    var r = Math.max(0.2, V3.len(V3.sub(mx, mn)) / 2);
    var aspect = this.canvas.width / Math.max(1, this.canvas.height);
    var fov = Math.min(this.cam.fov, 2 * Math.atan(Math.tan(this.cam.fov / 2) * aspect));
    var dist = r / Math.sin(fov / 2) * 1.05;
    var goal = { yaw: this.cam.yaw, pitch: this.cam.pitch, dist: dist, target: c };
    if (animate === false) { this.cam.dist = dist; this.cam.target = c; } else this.camGoal = goal;
    this.dirty = true;
  };
  PaperRenderer.prototype._animateCam = function () {
    var c = this.cam, g = this.camGoal, k = 0.18, done = true;
    ['yaw', 'pitch', 'dist'].forEach(function (key) { var d = g[key] - c[key]; if (Math.abs(d) > 1e-4) done = false; c[key] += d * k; });
    for (var i = 0; i < 3; i++) { var d = g.target[i] - c.target[i]; if (Math.abs(d) > 1e-4) done = false; c.target[i] += d * k; }
    if (done) this.camGoal = null;
    this.dirty = true;
    if (this.onCamera) this.onCamera(c);
  };
  PaperRenderer.prototype.zoom = function (f) { this.camGoal = null; this.cam.dist = Math.max(0.3, Math.min(20, this.cam.dist * f)); this.dirty = true; };

  // Ray from screen point (css px) → nearest triangle hit (returns {tri, point, node})
  PaperRenderer.prototype.pick = function (sx, sy) {
    if (!this.mesh || !this.lastMatrices) return null;
    var rect = this.canvas.getBoundingClientRect(), m = this.lastMatrices;
    var nx = (sx / rect.width) * 2 - 1, ny = 1 - (sy / rect.height) * 2;
    var inv = invert(M4.multiply(m.vp, m.model));
    if (!inv) return null;
    var p0 = M4.transformPoint(inv, [nx, ny, -1]), p1 = M4.transformPoint(inv, [nx, ny, 1]);
    var d = V3.norm(V3.sub(p1, p0)), o = p0.slice(0, 3);
    var P = this.pos, I = this.mesh.indices, best = Infinity, bt = -1;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      var hit = rayTri(o, d, [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]], [P[c], P[c + 1], P[c + 2]]);
      if (hit !== null && hit < best) { best = hit; bt = t / 3; }
    }
    if (bt < 0) return null;
    var pt = V3.add(o, V3.scale(d, best));
    var nodes = [I[bt * 3], I[bt * 3 + 1], I[bt * 3 + 2]], nb = nodes[0], nd = Infinity;
    nodes.forEach(function (n) { var dd = V3.len(V3.sub([P[n * 3], P[n * 3 + 1], P[n * 3 + 2]], pt)); if (dd < nd) { nd = dd; nb = n; } });
    return { tri: bt, point: pt, node: nb, depth: best, rayO: o, rayD: d };
  };
  // Unproject a screen point onto the plane through `pt` facing the camera (for dragging)
  PaperRenderer.prototype.screenToPlane = function (sx, sy, pt) {
    var rect = this.canvas.getBoundingClientRect(), m = this.lastMatrices;
    var nx = (sx / rect.width) * 2 - 1, ny = 1 - (sy / rect.height) * 2;
    var inv = invert(M4.multiply(m.vp, m.model));
    var p0 = M4.transformPoint(inv, [nx, ny, -1]), p1 = M4.transformPoint(inv, [nx, ny, 1]);
    var d = V3.norm(V3.sub(p1, p0)), o = p0.slice(0, 3);
    var im = invert(m.model);
    var eyeM = M4.transformPoint(im, m.eye), tgM = M4.transformPoint(im, this.cam.target);
    var n = V3.norm(V3.sub(eyeM.slice(0, 3), tgM.slice(0, 3)));
    var den = V3.dot(n, d);
    if (Math.abs(den) < 1e-9) return pt;
    var t = V3.dot(n, V3.sub(pt, o)) / den;
    return V3.add(o, V3.scale(d, t));
  };

  function rayTri(o, d, a, b, c) {
    var e1 = V3.sub(b, a), e2 = V3.sub(c, a), p = V3.cross(d, e2), det = V3.dot(e1, p);
    if (Math.abs(det) < 1e-12) return null;
    var inv = 1 / det, s = V3.sub(o, a), u = V3.dot(s, p) * inv;
    if (u < 0 || u > 1) return null;
    var q = V3.cross(s, e1), v = V3.dot(d, q) * inv;
    if (v < 0 || u + v > 1) return null;
    var t = V3.dot(e2, q) * inv;
    return t > 1e-6 ? t : null;
  }
  function invert(m) {
    var inv = new Array(16), det;
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (Math.abs(det) < 1e-20) return null;
    det = 1 / det;
    for (var i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  }

  // ---------------- input ----------------
  PaperRenderer.prototype._bindEvents = function () {
    var self = this, cv = this.canvas, drag = null, pointers = {};
    cv.style.touchAction = 'none';
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('pointerdown', function (e) {
      if (!self.interactive) return;
      cv.setPointerCapture(e.pointerId);
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) { var a = pointers[ids[0]], b = pointers[ids[1]]; drag = { mode: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: self.cam.dist, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] }; return; }
      var rect = cv.getBoundingClientRect();
      var grabMode = self.grabEnabled && e.button === 0 && !e.shiftKey;
      if (grabMode) {
        var hit = self.pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit && self.onDragNode) {
          drag = { mode: 'grab', node: hit.node, point: hit.point };
          self.onDragNode('start', hit.node, hit.point);
          return;
        }
      }
      drag = { mode: (e.button === 2 || e.button === 1 || e.shiftKey) ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, moved: 0 };
      self.camGoal = null;
    });
    cv.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (!drag) return;
      if (drag.mode === 'pinch') {
        var ids = Object.keys(pointers); if (ids.length < 2) return;
        var a = pointers[ids[0]], b = pointers[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y);
        self.cam.dist = Math.max(0.3, Math.min(20, drag.dist0 * drag.d0 / Math.max(d, 1)));
        self.dirty = true; return;
      }
      if (drag.mode === 'grab') {
        var rect = cv.getBoundingClientRect();
        var p = self.screenToPlane(e.clientX - rect.left, e.clientY - rect.top, drag.point);
        self.onDragNode('move', drag.node, p);
        return;
      }
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.mode === 'orbit') {
        self.cam.yaw -= dx * 0.008;
        self.cam.pitch = Math.max(-1.55, Math.min(1.55, self.cam.pitch + dy * 0.008));
      } else {
        var c = self.cam, s = c.dist * Math.tan(c.fov / 2) * 2 / cv.clientHeight;
        var right = [Math.cos(c.yaw), 0, -Math.sin(c.yaw)];
        var up = V3.cross([Math.cos(c.pitch) * Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch) * Math.cos(c.yaw)], right);
        c.target = V3.add(c.target, V3.add(V3.scale(right, -dx * s), V3.scale(up, -dy * s)));
      }
      self.dirty = true;
      if (self.onCamera) self.onCamera(self.cam);
    });
    function end(e) {
      delete pointers[e.pointerId];
      if (drag && drag.mode === 'grab' && self.onDragNode) self.onDragNode('end', drag.node, null);
      if (drag && drag.mode === 'orbit' && drag.moved < 4 && self.onPick) {
        var rect = cv.getBoundingClientRect();
        self.onPick(self.pick(e.clientX - rect.left, e.clientY - rect.top));
      }
      drag = null;
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', function (e) {
      if (!self.interactive) return;
      e.preventDefault();
      self.camGoal = null;
      self.zoom(Math.exp(e.deltaY * 0.0012));
      if (self.onCamera) self.onCamera(self.cam);
    }, { passive: false });
  };

  PaperRenderer.prototype.exportPNG = function (bg) {
    this.render();
    if (!bg) return this.canvas.toDataURL('image/png');
    var c = document.createElement('canvas'); c.width = this.canvas.width; c.height = this.canvas.height;
    var ctx = c.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(this.canvas, 0, 0);
    return c.toDataURL('image/png');
  };

  PaperRenderer.LINE_COLORS = LINE_COLORS;
  PaperRenderer.hex = hex;
  global.PaperRenderer = PaperRenderer;
})(typeof window !== 'undefined' ? window : globalThis);
