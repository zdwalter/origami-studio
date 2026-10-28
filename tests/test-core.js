// Node tests for geom.js / cp.js / solver.js
var path = require('path');
var root = path.join(__dirname, '..', 'js');
require(path.join(root, 'geom.js'));
require(path.join(root, 'cp.js'));
require(path.join(root, 'solver.js'));
var CP = globalThis.CP, OrigamiSolver = globalThis.OrigamiSolver;

var fails = 0, passes = 0;
function ok(cond, msg) { if (cond) passes++; else { fails++; console.log('FAIL:', msg); } }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', want ' + b + ')'); }

// ---- normalize
var lines = CP.normalize([{ a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'M' }], { width: 1, height: 1 });
ok(lines.filter(function (l) { return l.type === 'V'; }).length === 2, 'diagonal V split into 2');
ok(lines.filter(function (l) { return l.type === 'M'; }).length === 2, 'diagonal M split into 2');
ok(lines.filter(function (l) { return l.type === 'B'; }).length === 4, '4 boundary edges');
// overlap: later wins
lines = CP.normalize([{ a: [0, 0.5], b: [1, 0.5], type: 'V' }, { a: [0.25, 0.5], b: [0.75, 0.5], type: 'M' }], {});
var ms = lines.filter(function (l) { return l.type === 'M'; }), vs = lines.filter(function (l) { return l.type === 'V'; });
ok(ms.length === 1 && vs.length === 2, 'overlap override: ' + ms.length + 'M ' + vs.length + 'V');
// boundary splits at crease endpoints
ok(lines.filter(function (l) { return l.type === 'B'; }).length === 6, 'boundary split into 6');
// line clipped to sheet
lines = CP.normalize([{ a: [-1, 0.5], b: [2, 0.5], type: 'V' }], {});
ok(lines.some(function (l) { return l.type === 'V' && Math.abs(l.a[0]) < 1e-12 || Math.abs(l.b[0]) < 1e-12; }), 'clipped');

// ---- graph / faces
var g = CP.buildGraph({ width: 1, height: 1, lines: [{ a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'M' }, { a: [0.5, 0], b: [0.5, 1], type: 'M' }, { a: [0, 0.5], b: [1, 0.5], type: 'M' }] });
ok(g.faces.length === 8, 'square base has 8 faces: ' + g.faces.length);
var A = 0; g.faces.forEach(function (f) { A += OG.polyArea(f.map(function (i) { return g.vertices[i]; })); });
near(A, 1, 1e-9, 'faces area sums to 1');
// dangling crease pruned
g = CP.buildGraph({ width: 1, height: 1, lines: [{ a: [0, 0.5], b: [0.5, 0.5], type: 'V' }] });
ok(g.faces.length === 1 && g.warnings.length === 1, 'dangling pruned');

// ---- validate
var v = CP.validate({ width: 1, height: 1, lines: [{ a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'V' }, { a: [0.5, 0], b: [0.5, 1], type: 'M' }, { a: [0, 0.5], b: [1, 0.5], type: 'M' }] });
ok(v.checked === 1 && !v.ok, 'square base wrong MV (4V4M) fails maekawa');
v = CP.validate({ width: 1, height: 1, lines: [{ a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'V' }, { a: [0.5, 0], b: [0.5, 1], type: 'M' }, { a: [0, 0.5], b: [0.5, 0.5], type: 'M' }, { a: [0.5, 0.5], b: [1, 0.5], type: 'V' }] });
ok(v.ok, 'preliminary-like 5V3M ok: ' + v.summary);
v = CP.validate({ width: 1, height: 1, lines: [{ a: [0, 0], b: [0.5, 0.5], type: 'V' }, { a: [0.5, 0.5], b: [1, 0.3], type: 'M' }, { a: [0.5, 0.5], b: [0.5, 1], type: 'M' }, { a: [0.5, 0.5], b: [0, 0.6], type: 'M' }] });
ok(!v.ok && !v.vertices[0].kawasaki, 'kawasaki fails for random');

// ---- FOLD roundtrip
var doc = { name: 't', width: 1, height: 1, lines: [{ a: [0, 0], b: [1, 1], type: 'V', angle: 90 }] };
var fold = CP.toFOLD(doc);
ok(fold.vertices_coords.length === 4 && fold.edges_vertices.length === 5, 'FOLD counts');
var back = CP.fromFOLD(JSON.stringify(fold));
ok(back.lines.length === 5 && back.lines.some(function (l) { return l.type === 'V' && l.angle === 90; }), 'FOLD roundtrip');
ok(CP.colorToType(CP.parseColor('#ff0000')) === 'M' && CP.colorToType(CP.parseColor('blue')) === 'V' && CP.colorToType(CP.parseColor('#000')) === 'B', 'color mapping');

// ---- mesh
var mesh = CP.buildMesh({ width: 1, height: 1, lines: [{ a: [0.5, 0], b: [0.5, 1], type: 'V', angle: 90 }] });
ok(mesh.tris.length === 4, 'two quads → 4 tris: ' + mesh.tris.length);
ok(mesh.hinges.filter(function (h) { return h.type === 'V'; }).length === 1, 'one V hinge');
// winding: all triangles' normal +Z in 3D (Y=-y)
var allUp = mesh.tris.every(function (t) {
  var P = t.map(function (i) { return [mesh.nodes2d[i][0], -mesh.nodes2d[i][1]]; });
  return OG.orient(P[0], P[1], P[2]) > 0;
});
ok(allUp, 'tris wind CCW in 3D (front +Z)');
// cut duplicates nodes
var cm = CP.buildMesh({ width: 1, height: 1, lines: [{ a: [0.5, 0], b: [0.5, 0.5], type: 'C' }, { a: [0, 0.5], b: [1, 0.5], type: 'V' }] });
ok(cm.nodes2d.length > CP.buildGraph({ width: 1, height: 1, lines: [{ a: [0.5, 0], b: [0.5, 0.5], type: 'C' }, { a: [0, 0.5], b: [1, 0.5], type: 'V' }] }).vertices.length, 'cut duplicates nodes');

// ---- solver: single valley fold 90°
function runFold(lines, pct, steps) {
  var m = CP.buildMesh({ width: 1, height: 1, lines: lines });
  var s = new OrigamiSolver(m);
  s.setFoldPercent(pct);
  for (var i = 0; i < steps; i++) s.step(10);
  return s;
}
var s = runFold([{ a: [0.5, 0], b: [0.5, 1], type: 'V', angle: 90 }], 1, 600);
var ci = s.hKind.indexOf(1);
near(s.hTheta[ci] * 180 / Math.PI, 90, 3, 'valley converges to +90');
// both halves should rise toward +Z relative to the crease (valley: front faces approach → z of outer edge > crease z)
var bb = s.bounds();
var zCrease = 0, zEdge = 0, ne = 0, nc = 0;
for (var i = 0; i < s.n; i++) {
  var x2 = s.rest2d[i][0];
  if (Math.abs(x2 - 0.5) < 1e-9) { zCrease += s.x[i * 3 + 2]; nc++; } else { zEdge += s.x[i * 3 + 2]; ne++; }
}
ok(zEdge / ne > zCrease / nc + 0.1, 'valley lifts flaps toward +Z (front): edge z ' + (zEdge / ne).toFixed(3) + ' crease z ' + (zCrease / nc).toFixed(3));
var st = s.strain();
ok(st.max < 0.02, 'strain small: ' + st.max);
s = runFold([{ a: [0.5, 0], b: [0.5, 1], type: 'M', angle: 120 }], 1, 600);
ci = s.hKind.indexOf(1);
near(s.hTheta[ci] * 180 / Math.PI, -120, 4, 'mountain converges to -120');
// fold flat (180) — should approach ~ 170+
s = runFold([{ a: [0.5, 0], b: [0.5, 1], type: 'V', angle: 180 }], 1, 1500);
ci = s.hKind.indexOf(1);
ok(s.hTheta[ci] * 180 / Math.PI > 165, 'valley 180 nearly flat: ' + (s.hTheta[ci] * 180 / Math.PI).toFixed(1));
// square base (preliminary) 5V3M collapses
var sb = [{ a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'V' }, { a: [0.5, 0], b: [0.5, 1], type: 'M' }, { a: [0, 0.5], b: [0.5, 0.5], type: 'M' }, { a: [0.5, 0.5], b: [1, 0.5], type: 'V' }];
s = runFold(sb, 0.9, 3000);
console.log('square base err', s.creaseError().toFixed(2), 'strain', s.strain().max.toFixed(4), 'dt', s.dt.toFixed(4));
ok(s.creaseError() < 15, 'square base (4V4M) folds reasonably: err ' + s.creaseError().toFixed(2));
// export
ok(s.toOBJ('x').indexOf('f ') > 0, 'OBJ');
ok(s.toSTL().byteLength === 84 + 50 * s.mesh.tris.length * 2, 'STL size');

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
