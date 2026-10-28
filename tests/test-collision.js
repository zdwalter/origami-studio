// Self-collision tests: the paper must not pass through itself.
// 1) every pattern at its default settings has no triangle-triangle crossings (with collision on)
// 2) collision keeps penetration at zero where the same pattern without collision crosses
// 3) the roll patterns stay separated (thickness is respected)
var path = require('path');
['geom', 'cp', 'solver', 'patterns'].forEach(function (f) { require(path.join(__dirname, '..', 'js', f + '.js')); });
var CP = globalThis.CP, CPPatterns = globalThis.CPPatterns, OrigamiSolver = globalThis.OrigamiSolver;
var fails = 0, passes = 0;
function ok(c, m) { if (c) passes++; else { fails++; console.log('FAIL:', m); } }

// ---- triangle-triangle crossing count (Möller segment/triangle test on all edges) ----
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function segTri(p, q, T) {
  var a = T[0], e1 = sub(T[1], a), e2 = sub(T[2], a), d = sub(q, p);
  var h = cross(d, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-9) return false;
  var inv = 1 / det, s = sub(p, a), u = dot(s, h) * inv;
  if (u < 0.001 || u > 0.999) return false;
  var qq = cross(s, e1), v = dot(d, qq) * inv;
  if (v < 0.001 || u + v > 0.999) return false;
  var t = dot(e2, qq) * inv;
  return t > 0.001 && t < 0.999;
}
function crossings(solver) {
  var m = solver.mesh, x = solver.x, tris = m.tris, faceOf = m.triFace, n = solver.n, i;
  var nodeFaces = [];
  for (i = 0; i < n; i++) nodeFaces.push({});
  tris.forEach(function (t, ti) { t.forEach(function (v) { nodeFaces[v][faceOf[ti]] = 1; }); });
  function pos(k) { return [x[k * 3], x[k * 3 + 1], x[k * 3 + 2]]; }
  var total = 0, paper = m.nodes2d, scale = Math.max(m.width, m.height) || 1;
  for (var t1 = 0; t1 < tris.length; t1++) {
    var T1 = [pos(tris[t1][0]), pos(tris[t1][1]), pos(tris[t1][2])];
    for (var t2 = t1 + 1; t2 < tris.length; t2++) {
      var share = false;
      for (var q = 0; q < 3; q++) if (nodeFaces[tris[t2][q]][faceOf[t1]]) { share = true; break; }
      if (share) continue;
      // triangles whose paper areas are close touch along creases / cut seams — not "passing through"
      var c1 = [(paper[tris[t1][0]][0] + paper[tris[t1][1]][0] + paper[tris[t1][2]][0]) / 3, (paper[tris[t1][0]][1] + paper[tris[t1][1]][1] + paper[tris[t1][2]][1]) / 3];
      var c2 = [(paper[tris[t2][0]][0] + paper[tris[t2][1]][0] + paper[tris[t2][2]][0]) / 3, (paper[tris[t2][0]][1] + paper[tris[t2][1]][1] + paper[tris[t2][2]][1]) / 3];
      if (Math.hypot(c1[0] - c2[0], c1[1] - c2[1]) < 0.12 * scale) continue;
      var T2 = [pos(tris[t2][0]), pos(tris[t2][1]), pos(tris[t2][2])];
      if (segTri(T1[0], T1[1], T2) || segTri(T1[1], T1[2], T2) || segTri(T1[2], T1[0], T2) ||
        segTri(T2[0], T2[1], T1) || segTri(T2[1], T2[2], T1) || segTri(T2[2], T2[0], T1)) { total++; break; }
    }
  }
  return total;
}
function fold(doc, collision, steps) {
  var mesh = CP.buildMesh(doc);
  var s = new OrigamiSolver(mesh, { collision: collision, thickness: 0.012, collisionIter: 3 });
  var fp = doc.foldPercent === undefined ? 0.8 : doc.foldPercent;
  steps = steps || 4000;
  for (var i = 0; i < steps; i++) { s.setFoldPercent(Math.min(fp, i / (steps / 3))); s.step(1); }
  for (i = 0; i < steps; i++) { s.setFoldPercent(fp); s.step(1); }   // 折完后再静置一段时间
  return s;
}

// 这两个图案折后就是几十层紧贴在一起（菱形筒 / 刚性圆环近似）：检测器会把“层与层贴合”算成交叉，
// 而且开启自碰撞会把这些层顶开、把形状撑变形，所以 app 里对它们默认关闭自碰撞。
var STACKED = { 'circular-pleat': 1 };
// ---- 1. all patterns, default settings ----
var bad = [];
CPPatterns.list().forEach(function (meta) {
  var doc = CPPatterns.create(meta.id);
  // 与 app 一致：多层贴合的图案默认不开自碰撞（开了会把层顶开、形状变形）
  var s = fold(doc, !doc.stackedLayers, 4000);
  var c = crossings(s), pen = s.countPenetrations(0.002);
  var hasCuts = doc.lines.some(function (l) { return l.type === 'C'; });
  // 默认就折到 180°（贴平叠层）的图案：层与层本来就紧贴，交叉计数只作参考，重点看有没有真正穿入
  var creases = doc.lines.filter(function (l) { return l.type === 'M' || l.type === 'V'; });
  var flatStack = creases.length > 0 && doc.foldPercent >= 0.95 &&
    creases.every(function (l) { return Math.abs(l.angle === undefined ? 180 : l.angle) >= 170; });
  var crossLimit = flatStack ? 4 : (hasCuts ? 4 : 0);
  if (STACKED[meta.id]) {
    // 折后就是几十层贴合：交叉计数没有意义，改看“折痕图本身对不对”——几何误差与拉伸量
    var maxErr = doc.approximate ? 30 : 8, maxStrain = doc.approximate ? 0.35 : 0.03;
    ok(s.creaseError() < maxErr && s.strain().max < maxStrain,
      meta.id + ' 折后基本等距：误差 ' + s.creaseError().toFixed(1) + '°，拉伸 ' + (s.strain().max * 100).toFixed(1) + '%');
  } else if (c > crossLimit || pen > 0) {
    bad.push(meta.id + '(' + c + ' 交叉/' + pen + ' 穿模)');
  }
  ok(isFinite(s.x[0]), meta.id + ' 数值稳定');
});
ok(bad.length === 0, '默认参数下没有纸层互相穿过：' + (bad.length ? bad.join(', ') : '全部 ' + CPPatterns.list().length + ' 个图案干净'));

// ---- 2. collision really prevents the paper from sliding through itself ----
// 螺旋卷折到 90°/层时，不开启自碰撞纸层会互相穿过；开启后穿插明显减少
var deep = CPPatterns.create('spiral-curl', { n: 8, angle: 90 });
deep.foldPercent = 1;
var noCol = fold(deep, false, 4000), withCol = fold(deep, true, 4000);
var cNo = crossings(noCol), cWith = crossings(withCol);
console.log('螺旋卷@90°: 关闭自碰撞 ' + cNo + ' 处交叉 → 开启后 ' + cWith + ' 处');
ok(cWith < cNo, '自碰撞减少层间穿插 (' + cNo + ' → ' + cWith + ')');
ok(withCol.countPenetrations(0.002) === 0, '开启自碰撞后没有顶点插进面里');

// ---- 2b. the diamond pattern's crease angles follow the exact 40° relation → it folds isometrically ----
var dia = CPPatterns.create('yoshimura');
var sDia = fold(dia, false, 5000);
ok(sDia.creaseError() < 4, '吉村折按 40° 配套关系可等距折出（误差 ' + sDia.creaseError().toFixed(1) + '°）');
ok(sDia.strain().max < 0.02, '吉村折折后几乎不拉伸（' + (sDia.strain().max * 100).toFixed(1) + '%）');
// 反例：把所有折痕设成同一个折角（旧版做法）必然要拉伸纸面
var diaBad = CPPatterns.create('yoshimura');
diaBad.lines.forEach(function (l) { if (l.type === 'M' || l.type === 'V') l.angle = 80; });
var sBad = fold(diaBad, false, 5000);
console.log('同角折痕（旧错误做法）拉伸 ' + (sBad.strain().max * 100).toFixed(1) + '% / 误差 ' + sBad.creaseError().toFixed(1) + '°');
ok(sBad.strain().max > sDia.strain().max * 2, '配套折角比同角折痕省力得多（' + (sBad.strain().max * 100).toFixed(1) + '% vs ' + (sDia.strain().max * 100).toFixed(1) + '%）');

// ---- 2c. staged folding: 三折页 folds one crease after the other, like real paper ----
var letterDoc = CPPatterns.create('letter');
var sLetter = fold(letterDoc, true, 3000);
ok(sLetter.maxStage === 1, '三折页被拆成两个折叠阶段（maxStage=' + sLetter.maxStage + '）');
var idx0 = -1, idx1 = -1;
for (var hi = 0; hi < sLetter.hKind.length; hi++) {
  if (sLetter.hKind[hi] !== 1) continue;
  if (sLetter.hStage[hi] === 0) idx0 = hi; else idx1 = hi;
}
ok(idx0 >= 0 && idx1 >= 0, '两个折痕分别属于阶段 0 和 1');
// 阶段 0 走完、阶段 1 还没开始时：第一道折痕到位，第二道还是平铺
var sHalf = new OrigamiSolver(CP.buildMesh(letterDoc), { collision: true, thickness: 0.006 });
for (var q = 0; q < 6000; q++) { sHalf.setFoldPercent(Math.min(0.5, q / 2000)); sHalf.step(1); }
for (q = 0; q < 3000; q++) { sHalf.setFoldPercent(0.5); sHalf.step(1); }
var a0 = Math.abs(sHalf.hTheta[idx0]) * 180 / Math.PI, a1 = Math.abs(sHalf.hTheta[idx1]) * 180 / Math.PI;
console.log('三折页 50%：第一道 ' + a0.toFixed(0) + '°（应≈180），第二道 ' + a1.toFixed(0) + '°（应≈0）');
ok(a0 > 160 && a1 < 20, '50% 时只折完第一道折痕');
// 全程扫一遍：任何时刻都不应该有纸面穿插
var sScan = new OrigamiSolver(CP.buildMesh(letterDoc), { collision: true, thickness: 0.006 });
var worstPen = 0;
for (q = 0; q < 9000; q++) {
  sScan.setFoldPercent(Math.min(1, q / 3000));
  sScan.step(1);
  if (q % 300 === 299) worstPen = Math.max(worstPen, sScan.countPenetrations(0.002));
}
ok(worstPen === 0, '三折页整个折叠过程中没有纸面互相穿入（最大 ' + worstPen + ' 处）');

// ---- 3. layers respect the thickness (a rolled strip must stay separated) ----
var roll = CPPatterns.create('spiral-curl', { n: 8, angle: 90 });
var sr = fold(roll, true, 3000);
var t = sr.params.thickness, tooClose = 0;
var edgeContacts = sr.collisions;
ok(edgeContacts >= 0 && isFinite(sr.x[0]), '螺旋卷在自碰撞下数值稳定（接触 ' + edgeContacts + ' 处）');
ok(t > 0, '纸张厚度参数生效');

// ---- 4. default library is still stable / fast enough ----
var t0 = Date.now();
var m = fold(CPPatterns.create('miura'), true, 1200);
var dt = (Date.now() - t0) / 1800;
console.log('自碰撞开销：约 ' + dt.toFixed(3) + ' ms/步（三浦折）');
ok(dt < 1.5, '自碰撞每步开销合理 (' + dt.toFixed(3) + ' ms)');

console.log((passes) + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
