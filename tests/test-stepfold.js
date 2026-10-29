// Node tests for the step-fold engine and every tutorial model.
var path = require('path');
['geom', 'cp', 'stepfold', 'stepmodels'].forEach(function (f) { require(path.join(__dirname, '..', 'js', f + '.js')); });
var SF = globalThis.StepFold, SM = globalThis.StepModels, CP = globalThis.CP;
var fails = 0, passes = 0;
function ok(c, m) { if (c) passes++; else { fails++; console.log('FAIL:', m); } }
function near(a, b, t, m) { ok(Math.abs(a - b) <= t, m + ' (' + a + ' vs ' + b + ')'); }

// half fold (valley): bottom half up onto the top half
var s = SF.create();
var r = SF.fold(s, { a: [0, 0.5], b: [1, 0.5], side: [0.5, 0.9], kind: 'valley' });
ok(!r.error, 'half fold ok');
var b = SF.bounds(r.state);
near(b.height, 0.5, 1e-9, 'outline height 0.5'); near(b.width, 1, 1e-9, 'outline width 1');
ok(r.state.facets.length === 2, 'two layers');
var top = r.state.facets.slice().sort(function (x, y) { return y.layer - x.layer; })[0];
ok(SF.affine.det(top.T) < 0, 'valley: moved flap shows its back on top');
ok(r.creases.length === 1 && r.creases[0].type === 'V', 'valley recorded as V on front');
near(SF.totalArea(r.state), 1, 1e-12, 'area conserved');
// mountain → flap goes below
var r2 = SF.fold(s, { a: [0, 0.5], b: [1, 0.5], side: [0.5, 0.9], kind: 'mountain' });
var bottom = r2.state.facets.slice().sort(function (x, y) { return x.layer - y.layer; })[0];
ok(SF.affine.det(bottom.T) < 0, 'mountain: moved flap is underneath');
ok(r2.creases[0].type === 'M', 'mountain recorded as M');
// flip then valley → recorded as mountain on the paper front
var f = SF.flip(s);
var r3 = SF.fold(f, { a: [0.5, 0], b: [0.5, 1], side: [0.9, 0.5], kind: 'valley' });
ok(r3.creases[0].type === 'M', 'valley on flipped paper = M on front');
// fold through two layers: second fold on folded state, crease types differ per layer
var r4 = SF.fold(r.state, { a: [0.5, 0], b: [0.5, 1], side: [0.9, 0.25], kind: 'valley' });
ok(r4.state.facets.length === 4 && r4.creases.length === 2, 'fold through 2 layers');
var types = r4.creases.map(function (c) { return c.type; }).sort().join('');
ok(types === 'MV', 'two-layer fold creates one M and one V on the front: ' + types);
// valley layer ordering: formerly bottom moving layer ends on top
var lay = r4.state.facets.map(function (x) { return x.layer; }).sort();
ok(lay.join(',') === '0,1,2,3', 'compact layers');
// 'top' scope folds only the top layer
// (open edge is at y = 0; near the closed fold at y = 0.5 the layers are joined and must move together)
var r5 = SF.fold(r.state, { a: [0, 0.1], b: [1, 0.1], side: [0.5, 0.05], kind: 'valley', scope: 'top' });
ok(!r5.error && r5.moved.length === 1, 'top scope at open edge moves only top layer: ' + (r5.error || r5.moved.length));
var r6 = SF.fold(r.state, { a: [0, 0.4], b: [1, 0.4], side: [0.5, 0.45], kind: 'valley', scope: 'top' });
ok(!r6.error && r6.moved.length === 2, 'top scope near closed edge moves joined layers: ' + (r6.error || r6.moved.length));
// constructions
var l = SF.pointToPoint([0, 0], [1, 1]);
near(OG.orient(l.a, l.b, [0, 1]), 0, 1e-12, 'p2p bisector through (0,1)');
var e = SF.edgeToEdge([[0, 0], [1, 0]], [[0, 0], [0, 1]]);
near(Math.abs(OG.norm(OG.sub(e.b, e.a))[0]), Math.SQRT1_2, 1e-9, 'e2e bisector 45°');
// serialize roundtrip
var ser = SF.deserialize(SF.serialize(r4.state));
ok(ser.facets.length === 4 && ser.creases.length === r4.state.creases.length, 'serialize roundtrip');
// crease pattern of a 2-layer fold is flat-foldable
var cp = SF.creasePattern(r4.state);
ok(CP.validate(cp).ok, 'CP from step fold is valid: ' + CP.validate(cp).summary);

// every model
SM.list().forEach(function (meta) {
  var m = SM.get(meta.id), st = SF.create({ width: m.width, height: m.height }), A = m.width * m.height, good = true;
  m.steps.forEach(function (step, i) {
    if (!good) return;
    var rr = SF.applyOp(st, step.op);
    if (rr.error) { good = false; ok(false, meta.id + ' step ' + i + ': ' + rr.error); return; }
    st = rr.state;
    near(SF.totalArea(st), A, 1e-9, meta.id + ' step ' + i + ' area');
  });
  if (good) {
    // 含「折出折痕再展开 / 打开」的图纸里，有些折痕在成品中是 0°（根本没折），
    // 它们不该参与前川定理判定，所以这类图纸跳过整体平折检查，只查面积与步骤可执行性。
    var hasZeroCrease = m.steps.some(function (s2) { return s2.op.type === 'crease' || s2.op.type === 'unfold'; });
    var v = CP.validate(SF.creasePattern(st));
    if (hasZeroCrease) console.log('model', meta.id.padEnd(10), m.steps.length + ' steps', st.facets.length + ' facets', '（含 0° 折痕，跳过整体平折检查）');
    else ok(v.ok, meta.id + ' final CP flat-foldable: ' + v.summary);
    console.log('model', meta.id.padEnd(10), m.steps.length + ' steps', st.facets.length + ' facets', v.summary);
  }
});

// ---- 「仅最上层」(topSheet)：捏起最上面那层 + 沿折痕相连的层 + 挡在翻转路径上的层 ----
(function () {
  function foldCount(st, op, sc) { var o = JSON.parse(JSON.stringify(op)); o.scope = sc; var r = SF.fold(st, o); return r.error ? -1 : r.moved.length; }
  // 1) 对折后在角上折小三角：只该带最上面那一片
  var s1 = SF.create({ width: 1, height: 1 });
  s1 = SF.fold(s1, { a: [0, 0.5], b: [1, 0.5], side: [0.5, 0.9], kind: 'valley' }).state;
  var corner = { type: 'fold', a: [0.7, 0], b: [1, 0.3], side: [0.95, 0.05], kind: 'valley' };
  ok(foldCount(s1, corner, 'all') === 2 && foldCount(s1, corner, 'topSheet') === 1, 'topSheet：对折后折角只折最上层（all=2, top=' + foldCount(s1, corner, 'topSheet') + '）');
  // 2) 滑翔机第 9 步：整片机翼靠折痕连在一起 / 互相挡路，仅最上层 = 所有层
  var g = SM.get('glider'), s2 = SF.create({ width: g.width, height: g.height });
  for (var i = 0; i < 8; i++) s2 = SF.applyOp(s2, g.steps[i].op).state;
  ok(foldCount(s2, g.steps[8].op, 'topSheet') === foldCount(s2, g.steps[8].op, 'all'), 'topSheet：滑翔机机翼与所有层一致');
  // 3) 纸飞机前翼：后翼是另一侧的翻片，不该被带上
  var pl = SM.get('plane'), s3 = SF.create({ width: pl.width, height: pl.height });
  for (i = 0; i < 5; i++) s3 = SF.applyOp(s3, pl.steps[i].op).state;
  var nAll = foldCount(s3, pl.steps[5].op, 'all'), nTop = foldCount(s3, pl.steps[5].op, 'topSheet');
  ok(nTop > 0 && nTop < nAll, 'topSheet：纸飞机前翼只折前面那半（all=' + nAll + ', top=' + nTop + '）');
})();

// ---- 3D 展开展示姿态：默认 180° 时投影应与平面成品完全一致
(function () {
  function sig(pts) { return pts.map(function (p) { return p.join(';'); }).sort().join('|'); }
  var allOk = true, list = SM.list().map(function (m) { return m.id; });
  list.forEach(function (id) {
    var m = SM.get(id), st = SF.create({ width: m.width, height: m.height });
    m.steps.forEach(function (s) { var r = SF.applyOp(st, s.op); if (!r.error) st = r.state; });
    var flatAngles = {}; m.steps.forEach(function (_, i) { flatAngles[i] = 180; });
    var pose = SF.threeDPose(m.steps, { width: m.width, height: m.height, angles: flatAngles });
    var a = sig(pose.polys.map(function (p) {
      return p.pts.map(function (q) { return [q[0], q[1], 0].map(function (v) { return v.toFixed(3); }).join(','); }).sort();
    }));
    var b = sig(st.facets.map(function (f) {
      return f.poly.map(function (q) { var p = SF.affine.apply(f.T, q); return [p[0], p[1], 0].map(function (v) { return v.toFixed(3); }).join(','); }).sort();
    }));
    if (a !== b) { allOk = false; console.log('  3D pose 与平面不一致:', id); }
  });
  ok(allOk, '3D 展示姿态：180° 时与平面成品一致（' + list.length + ' 个教程）');
  // 打开机翼后应当出现厚度（z 不再为 0）
  var g = SM.get('glider'), pg = SF.threeDPose(g.steps, { width: g.width, height: g.height, angles: g.displayAngles || {} });
  var zSpan = pg.max[2] - pg.min[2];
  ok(zSpan > 0.02, '3D 展示姿态：滑翔机展开后有机翼高度（z 跨度 ' + zSpan.toFixed(3) + '）');
  var flatAngles2 = {}; g.steps.forEach(function (_, i) { flatAngles2[i] = 180; });
  var flat = SF.threeDPose(g.steps, { width: g.width, height: g.height, angles: flatAngles2 });
  ok(Math.abs((flat.max[2] - flat.min[2])) < 1e-6, '3D 展示姿态：全部按 180° 时仍是平的');
  // 折角写在 fold 操作里（op.angle）也生效
  // 展开展示：沿机身线对称对开 90°（两翼各 45°）
  ok(!!g.displayOpen && g.displayOpen.angle === 90, '滑翔机配置对称对开展示（两翼之间 90°）');
  var pg2 = SF.threeDPose(g.steps, { width: g.width, height: g.height, angles: (function () { var a2 = {}; g.steps.forEach(function (_, i2) { a2[i2] = 180; }); return a2; })(), openByLine: g.displayOpen });
  ok(Math.abs((pg2.max[2] - pg2.min[2]) - 0.5) < 0.08, '滑翔机对称对开后两翼张开（z 跨度 ' + (pg2.max[2] - pg2.min[2]).toFixed(3) + '）');
  // 左右两半应基本对称
  var semi = 0;
  pg2.polys.forEach(function (p) {
    var a3 = p.pts[0], b3 = p.pts[1], c3 = p.pts[2];
    var u3 = [b3[0] - a3[0], b3[1] - a3[1], b3[2] - a3[2]], v3 = [c3[0] - a3[0], c3[1] - a3[1], c3[2] - a3[2]];
    var n3 = [u3[1] * v3[2] - u3[2] * v3[1], u3[2] * v3[0] - u3[0] * v3[2], u3[0] * v3[1] - u3[1] * v3[0]];
    var L3 = Math.hypot(n3[0], n3[1], n3[2]) || 1;
    if (Math.abs(n3[2] / L3) > 0.3) semi++;
  });
  ok(semi > 20, '滑翔机对开后两侧都有立起来的翼面（' + semi + ' 片）');
})();

// ---- 展开复原：几何回到整张纸，折痕全部留下
(function () {
  var g = SM.get('glider'), st = SF.create({ width: g.width, height: g.height });
  for (var i = 0; i < 6; i++) st = SF.applyOp(st, g.steps[i].op).state;
  ok(st.facets.length > 1, '展开复原：先折出多层（' + st.facets.length + ' 片）');
  var nCrease = st.creases.length;
  var r = SF.applyOp(st, { type: 'unfoldAll' });
  ok(!r.error && r.state.facets.length === 1, '展开复原：几何回到整张纸');
  ok(r.state.creases.length === nCrease, '展开复原：折痕数量不变（' + nCrease + ' 条）');
  ok(r.state.creases.every(function (c) { return c.angle === 0; }), '展开复原：折痕角度归 0（只是折痕，不是折起的角）');
  var cp = SF.creasePattern(r.state, 't');
  ok(cp.lines.filter(function (l) { return l.type === 'M' || l.type === 'V'; }).length === nCrease, '展开复原：折痕图里能看到全部折痕');
  ok(Math.abs(SF.bounds(r.state).width - g.width) < 1e-9, '展开复原：纸张尺寸回到原样');
  // 打开上一折
  var st2 = SF.create({ width: 1, height: 1 });
  st2 = SF.applyOp(st2, { type: 'fold', a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], kind: 'valley' }).state;
  ok(st2.facets.length === 2, '打开上一折：先折一次得到两层');
  var r2 = SF.applyOp(st2, { type: 'unfold' });
  ok(!r2.error && r2.state.facets.length === 1 && r2.state.creases.length === 1, '打开上一折：几何复原但折痕保留');
})();

// ---- 折痕带 stage（第几步折的）与 foldAngle（当时折多少度）
(function () {
  var s = SF.create({ width: 1, height: 1 });
  var r1 = SF.fold(s, { a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], kind: 'valley', angle: 90 });
  ok(r1.creases.every(function (c) { return c.stage === 1; }), '折痕记录 stage=1（第一次折）');
  ok(r1.creases.every(function (c) { return c.foldAngle === 90; }), '折角 90° 的折痕记录 foldAngle=90');
  var r2 = SF.fold(r1.state, { a: [0, 0.5], b: [1, 0.5], side: [0.5, 0.8], kind: 'valley' });
  ok(r2.creases.every(function (c) { return c.stage === 2; }), '第二次折记录 stage=2');
  ok(r2.creases.every(function (c) { return c.foldAngle === 180; }), '没指定折角时 foldAngle=180');
  var cp = SF.creasePattern(r2.state, 't');
  var lines = cp.lines.filter(function (l) { return l.type === 'M' || l.type === 'V'; });
  ok(lines.some(function (l) { return l.stage === 1 && l.foldAngle === 90; }), '折痕图保留 stage 与 foldAngle');
  // 展开复原后信息不丢
  var u = SF.applyOp(r2.state, { type: 'unfoldAll' }).state;
  ok(u.creases.some(function (c) { return c.stage === 1 && c.foldAngle === 90; }), '展开复原后 stage / foldAngle 仍在');
  // 折叠再展开（crease 操作）也保留
  var c2 = SF.applyOp(SF.create({ width: 1, height: 1 }), { type: 'crease', a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], angle: 90 });
  ok(c2.state.creases.length === 1 && c2.state.creases[0].foldAngle === 90, '折出折痕再展开：foldAngle 仍为 90');
  // 教程模型：每一步的折痕 stage 单调、且 3D 网格能按 stage 分阶段
  if (global.CP) {
    var g = SM.get('glider'), stg = SF.create({ width: g.width, height: g.height });
    g.steps.forEach(function (sp) { var rr = SF.applyOp(stg, sp.op); if (!rr.error) stg = rr.state; });
    var norm = CP.normalize(SF.creasePattern(stg, 'g').lines, { width: g.width, height: g.height });
    var mesh = CP.buildMesh({ lines: norm, width: g.width, height: g.height });
    var mx = 0; mesh.hinges.forEach(function (h) { mx = Math.max(mx, h.stage || 0); });
    ok(mx >= 5, '滑翔机折痕带多个 stage（最大 ' + mx + '），3D 仿真可按顺序折');
  }
})();

// ---- 3D 目标角度直接采用 foldAngle
(function () {
  var s = SF.create({ width: 1, height: 1 });
  var r = SF.fold(s, { a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], kind: 'valley', angle: 90 });
  var lines = SF.creasePattern(r.state, 't').lines;
  var norm = CP.normalize(lines, { width: 1, height: 1 });
  var mesh = CP.buildMesh({ lines: norm, width: 1, height: 1 });
  var cre = mesh.hinges.filter(function (h) { return h.type === 'V' || h.type === 'M'; });
  ok(cre.length >= 1 && cre.every(function (h) { return Math.abs(Math.abs(h.target) - 90) < 1e-6; }), '3D 折痕目标角 = foldAngle（90°）');
  // 只是压痕（angle 0）的折痕，即使记录过折角，目标仍是 0
  var c2 = SF.applyOp(SF.create({ width: 1, height: 1 }), { type: 'crease', a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], angle: 90 });
  var n2 = CP.normalize(SF.creasePattern(c2.state, 't').lines, { width: 1, height: 1 });
  var m2 = CP.buildMesh({ lines: n2, width: 1, height: 1 });
  var cr2 = m2.hinges.filter(function (h) { return h.type === 'V' || h.type === 'M'; });
  ok(cr2.every(function (h) { return Math.abs(h.target) < 1e-6; }), '压痕（展开）的折痕目标角保持 0');
})();

// ---- 折叠树直接生成 3D 模型（绕开折痕图重建）
(function () {
  var g = SM.get('glider');
  var pm = SF.buildPoseModel(g.steps, { width: g.width, height: g.height });
  ok(pm.isPose === true && pm.n > 50, '折叠树模型：顶点数 ' + pm.n);
  ok(pm.mesh.tris.length > 20, '折叠树模型：三角形 ' + pm.mesh.tris.length + ' 个');
  ok(pm.maxStage >= 5, '折叠树模型：分阶段数 ' + pm.maxStage);
  pm.setFoldPercent(0);
  var b0 = pm.bounds(), s0 = [b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]];
  ok(Math.abs(b0.max[2] - b0.min[2]) < 1e-6, '折叠树模型：0% 时是整张平纸');
  pm.setFoldPercent(1);
  var b1 = pm.bounds(), s1 = [b1.max[0] - b1.min[0], b1.max[1] - b1.min[1], b1.max[2] - b1.min[2]];
  ok(s1[2] > 0.2, '折叠树模型：100% 时折出立体形状（z 跨度 ' + s1[2].toFixed(3) + '）');
  ok(s0[0] > s1[0] * 2, '折叠树模型：折完后尺寸明显变小（' + s0[0].toFixed(2) + ' → ' + s1[0].toFixed(2) + '）');
  ok(typeof pm.toOBJ('x') === 'string' && pm.toOBJ('x').indexOf('v ') > 0, '折叠树模型：可导出 OBJ');
})();
console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
