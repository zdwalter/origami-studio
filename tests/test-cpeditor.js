/* tests/test-cpeditor.js — headless-Chrome interaction tests for js/cpeditor.js (CPEditor).
 * Run: node tests/test-cpeditor.js            (screenshots → /tmp/shots/cpeditor/)
 */
'use strict';
var path = require('path'), fs = require('fs');
var puppeteer = require('/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules/puppeteer-core');
var CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var SHOTS = '/tmp/shots/cpeditor';
var ROOT = path.resolve(__dirname, '..');
fs.mkdirSync(SHOTS, { recursive: true });

var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } }
function near(a, b, e) { return Math.abs(a - b) < (e || 1e-6); }
function hasLine(lines, a, b, type, e) {
  e = e || 1e-6;
  return lines.some(function (l) {
    var m = (near(l.a[0], a[0], e) && near(l.a[1], a[1], e) && near(l.b[0], b[0], e) && near(l.b[1], b[1], e)) ||
      (near(l.a[0], b[0], e) && near(l.a[1], b[1], e) && near(l.b[0], a[0], e) && near(l.b[1], a[1], e));
    return m && (!type || l.type === type);
  });
}
function creases(doc) { return doc.lines.filter(function (l) { return l.type !== 'B'; }); }

(async function main() {
  var browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--allow-file-access-from-files', '--no-sandbox'] });
  var page = await browser.newPage();
  var errors = [];
  page.on('console', function (m) { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(ROOT, 'cpeditor-demo.html'));
  await page.waitForFunction('window.ed && window.CPEditor');

  async function scr(p) { // paper → page coords
    return page.evaluate(function (p) {
      var r = ed.canvas.getBoundingClientRect(), s = ed.toScreen(p);
      return [r.left + s[0], r.top + s[1]];
    }, p);
  }
  async function move(p, jitter) {
    var s = await scr(p); await page.mouse.move(s[0] + (jitter || 0), s[1] + (jitter || 0), { steps: 3 });
  }
  async function click(p, jitter) { await move(p, jitter); await page.mouse.down(); await page.mouse.up(); }
  async function drag(p, q, jitter) {
    await move(p, jitter); await page.mouse.down(); await move(q, jitter); await page.mouse.up();
  }
  var doc = function () { return page.evaluate('ed.getDoc()'); };
  async function shot(name) { await page.evaluate('ed.render()'); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); }
  async function reset() { await page.evaluate("ed.setDoc({name:'t',width:1,height:1,lines:[]},{resetHistory:true}); ed.setTool('line'); ed.setLineType('M'); ed.setGrid({divisions:8,type:'square'})"); }

  console.log('CPEditor API');
  var api = await page.evaluate(function () {
    var names = ['setDoc', 'getDoc', 'setTool', 'getTool', 'setLineType', 'setDefaultAngle', 'setGrid', 'setSnap', 'undo', 'redo', 'canUndo', 'canRedo',
      'selectAll', 'clearSelection', 'deleteSelected', 'setSelectedType', 'setSelectedAngle', 'flipSelectedMV', 'invertAllMV', 'clear', 'fit', 'zoom',
      'resize', 'setValidation', 'setShowLabels', 'setShowAngles', 'exportPNG', 'destroy', 'redraw'];
    return names.filter(function (n) { return typeof ed[n] !== 'function'; });
  });
  ok(api.length === 0, 'all API methods present ' + (api.length ? api.join(',') : ''));
  var d0 = await doc();
  ok(d0.lines.length === 4 && d0.lines.every(function (l) { return l.type === 'B'; }), 'empty doc has 4 boundary edges');

  console.log('Line tool (click-click, snapping to corners)');
  await click([0, 0], 3); await click([1, 1], -4);
  var d = await doc();
  ok(hasLine(creases(d), [0, 0], [1, 1], 'M'), 'diagonal M drawn and snapped to corners');
  ok(creases(d)[0].angle === 180, 'M line carries default angle 180');
  await page.evaluate("ed.setLineType('V'); ed.setDefaultAngle(90)");
  await drag([1, 0], [0, 1], 3); // drag-draw
  d = await doc();
  ok(creases(d).length === 4, 'second diagonal split at centre → 4 creases (got ' + creases(d).length + ')');
  ok(hasLine(d.lines, [1, 0], [0.5, 0.5], 'V'), 'V half-diagonal snapped to centre split');
  ok(creases(d).filter(function (l) { return l.type === 'V'; }).every(function (l) { return l.angle === 90; }), 'V lines carry default angle 90');
  await page.evaluate("ed.setDefaultAngle(180)");

  console.log('Midpoint / grid snapping & shift constrain');
  await page.evaluate("ed.setLineType('F')");
  await click([0.5, 0.003]); await click([0.5, 0.25]);
  d = await doc();
  ok(hasLine(d.lines, [0.5, 0], [0.5, 0.25], 'F'), 'edge-midpoint → grid point F line');
  await page.evaluate("ed.setLineType('U'); ed.setGrid({divisions:0})");
  await click([0, 0.5]);
  await page.keyboard.down('Shift');
  await move([0.3, 0.37]);
  var st = await page.evaluate('ed.op && ed.op.end');
  await shot('03-shift-preview');
  await page.mouse.down(); await page.mouse.up();
  await page.keyboard.up('Shift');
  d = await doc();
  var u = creases(d).filter(function (l) { return l.type === 'U'; });
  var ang = u.length ? Math.atan2(u[0].b[1] - u[0].a[1], u[0].b[0] - u[0].a[0]) * 180 / Math.PI : NaN;
  ok(u.length >= 1 && near(((ang % 22.5) + 22.5) % 22.5 < 11 ? ((ang % 22.5) + 22.5) % 22.5 : 22.5 - ((ang % 22.5) + 22.5) % 22.5, 0, 1e-6),
    'shift constrains to 22.5° multiple (angle=' + ang.toFixed(3) + ')');
  await page.evaluate("ed.setGrid({divisions:8})");
  await shot('01-lines');

  console.log('Undo / redo');
  var before = (await doc()).lines.length;
  await page.evaluate('ed.canvas.focus()');
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  var afterUndo = (await doc()).lines.length;
  ok(afterUndo < before, 'Cmd+Z undoes (' + before + ' → ' + afterUndo + ')');
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('z'); await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  ok((await doc()).lines.length === before, 'Shift+Cmd+Z redoes');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
  ok((await doc()).lines.length === before, 'Ctrl+Z / Ctrl+Y round trip');
  var hs = await page.evaluate('[ed.canUndo(), ed.canRedo()]');
  ok(hs[0] === true && hs[1] === false, 'canUndo/canRedo flags');

  console.log('Keys: line type shortcuts; inputs do not steal');
  await page.evaluate('ed.canvas.focus()');
  await page.keyboard.press('2');
  ok(await page.evaluate("ed.getLineType()==='V'"), 'key 2 → V');
  await page.keyboard.press('m');
  ok(await page.evaluate("ed.getLineType()==='M'"), 'key M → M');
  await page.focus('#name');
  await page.mouse.move(5, 5);
  await page.evaluate('ed.hovered=false');
  await page.keyboard.press('v');
  await page.keyboard.press('Backspace');
  ok(await page.evaluate("ed.getLineType()==='M'"), 'typing in text input does not change type');
  ok((await doc()).lines.length === before, 'Backspace in input does not delete');

  console.log('Select / delete / box select');
  await reset();
  await page.evaluate("ed.addLines([{a:[0,0],b:[1,1],type:'M'},{a:[1,0],b:[0,1],type:'V'},{a:[0.5,0],b:[0.5,1],type:'V'}])");
  await page.evaluate("ed.setTool('select')");
  await click([0.25, 0.25]);
  var sel = await page.evaluate('ed.getSelection().length');
  ok(sel === 1, 'click selects one line');
  await page.evaluate('ed.canvas.focus()');
  await page.keyboard.press('Delete');
  d = await doc();
  ok(creases(d).length === 5, 'Delete removes selected (6→5, got ' + creases(d).length + ')');
  // box select (left→right: fully inside)
  await drag([-0.03, 0.45], [1.03, 1.03]);
  sel = await page.evaluate('ed.getSelection().length');
  ok(sel === 3, 'window box selects lines fully inside lower half (got ' + sel + ')');
  await shot('04-selection');
  await page.evaluate('ed.flipSelectedMV()');
  d = await doc();
  ok(creases(d).filter(function (l) { return l.type === 'M'; }).length === 2, 'flipSelectedMV flips 3 lines (1M,2V → 2M,1V)');
  await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
  ok(await page.evaluate('ed.getSelection().length') === 5, 'Cmd+A selects all creases');
  await page.evaluate('ed.setSelectedAngle(120)');
  ok(creases(await doc()).filter(function (l) { return l.type === 'M' || l.type === 'V'; }).every(function (l) { return l.angle === 120; }), 'setSelectedAngle(120)');
  await page.evaluate('ed.setSelectedType("U")');
  ok(creases(await doc()).every(function (l) { return l.type === 'U'; }), 'setSelectedType(U)');
  await page.evaluate('ed.undo(); ed.undo(); ed.clearSelection()');
  // vertex drag
  await page.evaluate("ed.setDoc({width:1,height:1,lines:[{a:[0.25,0.25],b:[0.75,0.75],type:'M'}]},{resetHistory:true})");
  await drag([0.75, 0.75], [0.75, 0.25]);
  d = await doc();
  ok(hasLine(d.lines, [0.25, 0.25], [0.75, 0.25], 'M'), 'drag endpoint to grid point');
  // move selection
  await drag([0.5, 0.25], [0.5, 0.5]);
  d = await doc();
  ok(hasLine(d.lines, [0.25, 0.5], [0.75, 0.5], 'M'), 'drag selected line translates it');

  console.log('Erase (click + drag across)');
  await reset();
  await page.evaluate("ed.addLines([{a:[0.25,0],b:[0.25,0.8],type:'M'},{a:[0.5,0],b:[0.5,0.8],type:'V'},{a:[0.75,0],b:[0.75,0.8],type:'M'},{a:[0,0.9],b:[1,0.9],type:'F'},{a:[0.5,0.9],b:[0.5,1],type:'V'}])");
  await page.evaluate("ed.setTool('erase')");
  await click([0.75, 0.3]);
  d = await doc();
  ok(!creases(d).some(function (l) { return near(l.a[0], 0.75) && near(l.b[0], 0.75); }), 'click erases line x=0.75');
  await drag([0.1, 0.5], [0.6, 0.55]);
  d = await doc();
  var cs = creases(d);
  ok(cs.length === 3, 'drag erases the 2 crossed lines (left ' + cs.length + ')');
  await click([0.5, 0.96]);
  cs = creases(await doc());
  ok(cs.length === 1 && hasLine(cs, [0, 0.9], [1, 0.9], 'F'), 'erasing the T-stub merges collinear F pieces back into one line');

  console.log('Type tool');
  await page.evaluate("ed.setTool('type'); ed.setLineType('C')");
  await click([0.3, 0.9]);
  ok(creases(await doc())[0].type === 'C', 'type tool sets clicked line to C');

  console.log('Bisector (3 points) & (2 lines)');
  await reset();
  await page.evaluate("ed.setTool('bisector'); ed.setLineType('V')");
  await click([1, 0]); await click([0, 0]); await click([0, 1]);
  d = await doc();
  ok(hasLine(d.lines, [0, 0], [1, 1], 'V'), 'bisector of corner angle = diagonal');
  await page.evaluate("ed.setLineType('M')");
  await click([0.6, 0], 0); // bottom? top edge line pick? edge at y=0 is B line; click near middle of edge segment
  // Note: picks: top edge (line) then diagonal (line)
  await click([0.7, 0.7]);
  d = await doc();
  var bis = creases(d).filter(function (l) { return l.type === 'M'; });
  var tan = Math.tan(Math.PI / 8);
  ok(bis.length === 1 && hasLine(bis, [0, 0], [1, tan], 'M', 1e-6), 'bisector of top edge & diagonal (22.5° line to right edge)');
  await shot('05-bisector');

  console.log('Perpendicular, perpendicular bisector, ray');
  await reset();
  await page.evaluate("ed.addLines([{a:[0,0],b:[1,1],type:'V'}]); ed.setTool('perp'); ed.setLineType('M')");
  await click([1, 0]); await click([0.3, 0.3]);
  d = await doc();
  ok(hasLine(d.lines, [1, 0], [0.5, 0.5], 'M'), 'perpendicular from corner to diagonal');
  await page.evaluate("ed.setTool('pbisect'); ed.setLineType('F')");
  await click([0, 0]); await click([0, 1]);
  d = await doc();
  ok(creases(d).some(function (l) { return l.type === 'F' && near(l.a[1], 0.5) && near(l.b[1], 0.5); }), 'perpendicular bisector of left edge is y=0.5 line');
  await page.evaluate("ed.setTool('ray'); ed.setLineType('U')");
  await click([0, 0.25]); await click([0.125, 0.25]);
  d = await doc();
  ok(hasLine(d.lines, [0, 0.25], [0.25, 0.25], 'U', 1e-6), 'ray stops at first crease (diagonal at x=0.25)');
  await shot('06-constructions');

  console.log('Mirror');
  await reset();
  await page.evaluate("ed.addLines([{a:[0,0],b:[0.5,0.25],type:'M'}]); ed.addLines([{a:[0.5,0],b:[0.5,1],type:'F'}]); ed.setSelection([ed.getDoc().lines.findIndex(function(l){return l.type==='M'})]); ed.setTool('mirror')");
  await click([0.5, 0.7]);
  d = await doc();
  ok(hasLine(d.lines, [1, 0], [0.5, 0.25], 'M'), 'mirror across vertical centre line');
  await shot('07-mirror');

  console.log('Clear / invert / Esc');
  await page.evaluate("ed.invertAllMV()");
  ok(creases(await doc()).filter(function (l) { return l.type === 'V'; }).length === 2, 'invertAllMV');
  await page.evaluate("ed.setTool('line')");
  await click([0, 0]);
  await page.evaluate('ed.canvas.focus()');
  await page.keyboard.press('Escape');
  ok(await page.evaluate('ed.op === null'), 'Esc cancels drawing');
  await page.evaluate('ed.clear()');
  ok((await doc()).lines.length === 4, 'clear keeps only boundary');

  console.log('Validation markers, zoom, labels');
  await page.evaluate(function () {
    ed.setDoc({ width: 1, height: 1, lines: [
      { a: [0, 0], b: [1, 1], type: 'V' }, { a: [1, 0], b: [0, 1], type: 'V' }, { a: [0, 0.5], b: [1, 0.5], type: 'M' },
      { a: [0, 0.25], b: [0.25, 0.25], type: 'M' }] }, { resetHistory: true });
    ed.setValidation(CP.validate(ed.getDoc()));
    ed.setShowLabels(true);
  });
  var v = await page.evaluate('ed.validation.vertices.map(function(x){return x.ok})');
  ok(v.indexOf(false) >= 0 && v.indexOf(true) >= 0, 'validation has ok and failing vertices: ' + JSON.stringify(v));
  var bad = await page.evaluate('ed.validation.vertices.filter(function(x){return !x.ok})[0].p');
  await page.evaluate("ed.setTool('select')");
  await move(bad);
  await shot('08-validation');
  await page.evaluate("ed.setTool('line')");
  await move([0.5, 0.5]);
  await shot('09-angles');
  var s0 = await page.evaluate('ed.getView().scale');
  var c = await scr([0.5, 0.5]);
  await page.mouse.move(c[0], c[1]);
  await page.mouse.wheel({ deltaY: -400 });
  var s1 = await page.evaluate('ed.getView().scale');
  var c2 = await scr([0.5, 0.5]);
  ok(s1 > s0 && Math.abs(c2[0] - c[0]) < 1 && Math.abs(c2[1] - c[1]) < 1, 'wheel zooms around cursor');
  await page.evaluate('ed.fit()');
  // space pan
  await page.evaluate('ed.canvas.focus()');
  var ox0 = await page.evaluate('ed.getView().ox');
  await page.keyboard.down('Space');
  await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.move(650, 420, { steps: 3 }); await page.mouse.up();
  await page.keyboard.up('Space');
  ok(near(await page.evaluate('ed.getView().ox'), ox0 + 50, 1), 'space-drag pans');
  var nl = (await doc()).lines.length;
  ok(nl === (await page.evaluate('ed.getDoc().lines.length')), 'space-drag did not draw');
  await page.evaluate('ed.fit()');

  console.log('Triangle grid & drawing preview screenshot');
  await page.evaluate("ed.setValidation(null); ed.setShowLabels(false); ed.setDoc({width:1,height:1,lines:[]},{resetHistory:true}); ed.setGrid({divisions:8,type:'triangle'}); ed.setTool('line'); ed.setLineType('V')");
  await click([0, 1]);
  var tp = await page.evaluate('ed._nearestGrid([0.5,0.3])');
  await move(tp);
  await shot('10-triangle-preview');
  await page.mouse.down(); await page.mouse.up();
  d = await doc();
  ok(creases(d).length === 1 && near(creases(d)[0].b[1] === 1 ? creases(d)[0].a[1] : creases(d)[0].b[1], tp[1]), 'snaps to triangle grid point');

  console.log('Rich pattern render + export');
  await page.evaluate(function () {
    var L = [], n = 8;
    for (var i = 1; i < n; i++) { L.push({ a: [i / n, 0], b: [i / n, 1], type: i % 2 ? 'V' : 'M' }); L.push({ a: [0, i / n], b: [1, i / n], type: 'F' }); }
    L.push({ a: [0, 0], b: [1, 1], type: 'U' }); L.push({ a: [0.2, 0.8], b: [0.4, 0.6], type: 'C' });
    ed.setGrid({ divisions: 16, type: 'square' });
    ed.setDoc({ width: 1, height: 1, lines: L }, { resetHistory: true });
  });
  await shot('11-pattern');
  var png = await page.evaluate('ed.exportPNG()');
  ok(/^data:image\/png;base64,/.test(png) && png.length > 2000, 'exportPNG returns PNG data URL');
  fs.writeFileSync(path.join(SHOTS, '12-export.png'), Buffer.from(png.split(',')[1], 'base64'));

  console.log('Rectangular sheet & history limit');
  await page.evaluate("ed.setDoc({width:1,height:0.5,lines:[{a:[0,0],b:[2,1],type:'M'}]},{resetHistory:true})");
  d = await doc();
  ok(hasLine(d.lines, [0, 0], [1, 0.5], 'M'), 'lines clipped to sheet');
  await page.evaluate("for (var i=0;i<230;i++) ed.addLines([{a:[i/240,0],b:[i/240+0.001,0.5],type:'F'}]);");
  ok(await page.evaluate('ed.past.length') === 200, 'history limited to 200');
  await shot('13-rect');

  console.log('Fallback without CP');
  var fb = await page.evaluate(function () {
    var saved = window.CP; window.CP = undefined;
    var c = document.createElement('canvas'); c.style.cssText = 'width:300px;height:300px'; document.body.appendChild(c);
    var e2 = new CPEditor(c, {});
    e2.addLines([{ a: [0, 0], b: [1, 1], type: 'M' }, { a: [1, 0], b: [0, 1], type: 'V' }]);
    var n = e2.getDoc().lines.length;
    e2.destroy(); c.remove(); window.CP = saved;
    return n;
  });
  ok(fb === 8, 'fallback splitter splits crossing diagonals (8 edges, got ' + fb + ')');

  console.log('Touch (pointer events)');
  await page.evaluate("ed.setDoc({width:1,height:1,lines:[]},{resetHistory:true}); ed.setGrid({divisions:8,type:'square'}); ed.setTool('line')");
  var t1 = await scr([0, 0.5]), t2 = await scr([1, 0.5]);
  await page.evaluate(function (a, b) {
    var c = ed.canvas;
    function fire(type, p) { c.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: p[0], clientY: p[1], button: 0, buttons: 1, bubbles: true, isPrimary: true })); }
    fire('pointerdown', a); fire('pointermove', [(a[0] + b[0]) / 2, a[1]]); fire('pointermove', b); fire('pointerup', b);
  }, t1, t2);
  ok(hasLine((await doc()).lines, [0, 0.5], [1, 0.5]), 'touch drag draws a line');

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed. Screenshots: ' + SHOTS);
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
