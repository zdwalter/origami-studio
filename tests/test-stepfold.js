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
    var pose = SF.threeDPose(m.steps, { width: m.width, height: m.height });
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
  var flat = SF.threeDPose(g.steps, { width: g.width, height: g.height });
  ok(Math.abs((flat.max[2] - flat.min[2])) < 1e-6, '3D 展示姿态：不展开时仍是平的');
})();
console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
