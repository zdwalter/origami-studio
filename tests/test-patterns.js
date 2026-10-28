// Node test: every crease-pattern preset is well formed; flat-foldable ones satisfy Maekawa & Kawasaki;
// every preset builds a mesh and the solver stays finite and low-strain.
var path = require('path');
['geom', 'cp', 'solver', 'patterns'].forEach(function (f) { require(path.join(__dirname, '..', 'js', f + '.js')); });
var CP = globalThis.CP, CPPatterns = globalThis.CPPatterns, OrigamiSolver = globalThis.OrigamiSolver;
var fails = 0;
function ok(c, m) { if (!c) { fails++; console.log('  FAIL:', m); } }

CPPatterns.list().forEach(function (meta) {
  var doc = CPPatterns.create(meta.id);
  var w = doc.width, h = doc.height;
  ok(doc.lines.every(function (l) { return CP.TYPES.indexOf(l.type) >= 0; }), meta.id + ' types');
  ok(doc.lines.every(function (l) { return [l.a, l.b].every(function (p) { return isFinite(p[0]) && isFinite(p[1]); }); }), meta.id + ' finite');
  var st = CP.stats(doc), v = CP.validate(doc);
  var mesh = CP.buildMesh(doc);
  var s = new OrigamiSolver(mesh);
  s.setFoldPercent(doc.foldPercent);
  var t0 = Date.now();
  for (var i = 0; i < 1500; i++) s.step(1);
  var strain = s.strain().max, err = s.creaseError();
  var line = meta.id.padEnd(18) + ' V' + String(st.vertices).padStart(4) + ' E' + String(st.edges).padStart(4) + ' F' + String(st.faces).padStart(4) +
    ' tris ' + String(mesh.tris.length).padStart(4) + '  ' + (doc.flatFoldable ? (v.ok ? 'flat-ok ' : 'FLAT-BAD') : 'non-flat') +
    (doc.approximate ? ' approximate' : '') + ' (' + v.bad + '/' + v.checked + ')  strain ' + strain.toFixed(4) + ' err ' + err.toFixed(1) + '° ' + (Date.now() - t0) + 'ms' +
    (mesh.warnings.length ? '  ⚠ ' + mesh.warnings.join(';') : '');
  console.log(line);
  if (doc.flatFoldable) {
    ok(v.ok, meta.id + ' flat-foldable check: ' + v.summary);
    if (!v.ok) v.vertices.filter(function (x) { return !x.ok; }).slice(0, 4).forEach(function (x) {
      console.log('    bad vertex', x.p.map(function (q) { return q.toFixed(4); }).join(','), 'M/V', x.mv.join('/'), 'kaw', (x.kawasakiError * 180 / Math.PI).toFixed(3) + '°', 'deg', x.degree);
    });
  }
  ok(isFinite(s.x[0]) && !s.diverged, meta.id + ' solver finite');
  // 同心环之类的图案用刚性多边形环逼近圆弧，纸面必须靠拉伸才能贴合，标记为 approximate 的放宽阈值
  ok(strain < (doc.approximate ? 0.45 : 0.08), meta.id + ' strain ' + strain);
  ok(!mesh.warnings.some(function (w) { return w.indexOf('悬空') >= 0; }), meta.id + ' warnings');
});
console.log(fails ? fails + ' failures' : 'all patterns OK');
process.exit(fails ? 1 : 0);
