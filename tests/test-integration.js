// Integration test: editor ↔ simulator, import/export, library, share link, persistence.
var puppeteer = require('/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules/puppeteer-core');
var path = require('path'), fs = require('fs');
var OUT = '/tmp/shots/integ', DL = '/tmp/shots/integ-dl';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
var fails = 0; function ok(c, m) { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; }
(async function () {
  [OUT, DL].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });
  fs.readdirSync(DL).forEach(function (f) { fs.unlinkSync(path.join(DL, f)); });
  var browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 120000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  var page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960 });
  var logs = [];
  page.on('console', function (m) { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', function (e) { logs.push('[pageerror] ' + e.message); });
  page.on('dialog', async function (d) { await d.accept(d.type() === 'prompt' ? '测试作品' : undefined); });
  var cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  var url = 'file://' + path.resolve(__dirname, '../index.html');
  await page.goto(url); await page.evaluate(function () { localStorage.clear(); }); await page.reload(); await sleep(1200);

  // 1. new square sheet in design mode, draw a valley line across the middle by mouse
  await page.click('.mode-tab[data-mode="design"]'); await sleep(500);
  await page.evaluate(function () { document.querySelector('[data-ed="newSquare"]').click(); });
  await sleep(300);
  await page.click('.ltype[data-type="V"]');
  var pts = await page.evaluate(function () {
    var ed = window.OrigamiStudio.editor, r = document.getElementById('cpCanvas').getBoundingClientRect();
    var a = ed.toScreen([0, 0.5]), b = ed.toScreen([1, 0.5]);
    return { a: [r.left + a[0], r.top + a[1]], b: [r.left + b[0], r.top + b[1]] };
  });
  await page.mouse.move(pts.a[0], pts.a[1]); await page.mouse.down();
  await page.mouse.move((pts.a[0] + pts.b[0]) / 2, pts.a[1], { steps: 6 }); await page.mouse.move(pts.b[0], pts.b[1], { steps: 6 }); await page.mouse.up();
  await sleep(600);
  var st = await page.evaluate(function () { var S = window.OrigamiStudio; return { lines: S.doc.lines.filter(function (l) { return l.type === 'V'; }).length, hinges: S.mesh.hinges.filter(function (h) { return h.type === 'V'; }).length }; });
  ok(st.lines >= 1 && st.hinges >= 1, 'drawn valley line reaches the simulator ' + JSON.stringify(st));
  await page.evaluate(function () { document.querySelector('[data-fold="100"]').click(); }); await sleep(2500);
  var ang = await page.evaluate(function () { var s = window.OrigamiStudio.solver; var i = s.hKind.indexOf(1); return s.hTheta[i] * 180 / Math.PI; });
  ok(ang > 150, 'valley folds toward 180°: ' + ang.toFixed(1));
  await page.screenshot({ path: OUT + '/01-drawn.png' });
  // undo via toolbar
  await page.click('#edUndo'); await sleep(500);
  var after = await page.evaluate(function () { return window.OrigamiStudio.doc.lines.filter(function (l) { return l.type === 'V'; }).length; });
  ok(after === 0, 'undo removes line');
  await page.click('#edRedo'); await sleep(300);

  // 2. exports
  await page.click('.mode-tab[data-mode="sim"]'); await sleep(300);
  var kinds = ['svg', 'fold', 'cp-png', 'obj', 'stl', 'fold3d', 'png', 'project'];
  for (var i = 0; i < kinds.length; i++) { await page.evaluate(function (k) { document.querySelector('[data-export="' + k + '"]').click(); }, kinds[i]); await sleep(400); }
  await sleep(1500);
  var files = fs.readdirSync(DL);
  ok(files.length === kinds.length, 'downloads: ' + files.join(', '));
  var svgFile = files.filter(function (f) { return /\.svg$/.test(f); })[0];

  // 3. import the exported SVG back through the file input
  var input = await page.$('#fileInput');
  await input.uploadFile(path.join(DL, svgFile)); await sleep(1200);
  var imp = await page.evaluate(function () { var S = window.OrigamiStudio; return { name: S.doc.name, v: S.doc.lines.filter(function (l) { return l.type === 'V'; }).length }; });
  ok(imp.v >= 1, 'SVG re-import keeps valley crease ' + JSON.stringify(imp));
  var foldFile = files.filter(function (f) { return /\.fold$/.test(f) && f.indexOf('folded') < 0; })[0];
  await input.uploadFile(path.join(DL, foldFile)); await sleep(1000);
  imp = await page.evaluate(function () { var S = window.OrigamiStudio; return S.doc.lines.filter(function (l) { return l.type === 'V'; }).length; });
  ok(imp >= 1, 'FOLD re-import');

  // 4. save to library (prompt auto-answered) and share link
  await page.click('#btnSaveLib'); await sleep(400);
  var mine = await page.evaluate(function () { return JSON.parse(localStorage.getItem('origami-studio.mine.v1') || '[]').length; });
  ok(mine === 1, 'saved to 我的作品');
  await page.evaluate(function () { document.querySelector('.lib-item[data-id="square-twist"]').click(); }); await sleep(500);
  await page.evaluate(function () { document.querySelector('[data-export="link"]').click(); }); await sleep(300);
  var link = await page.evaluate(function () { return location.href; });
  ok(/#cp=/.test(link), 'share link in URL');
  var p2 = await browser.newPage(); await p2.setViewport({ width: 1200, height: 800 });
  await p2.goto(link); await sleep(1500);
  var n2 = await p2.evaluate(function () { return document.getElementById('modelName').textContent; });
  ok(n2 === '方形扭转', 'share link opens pattern: ' + n2);
  await p2.close();

  // 5. parameters rebuild
  await page.evaluate(function () { document.querySelector('.lib-item[data-id="miura"]').click(); }); await sleep(500);
  await page.evaluate(function () { var r = document.querySelector('#paramList input'); r.value = 9; r.dispatchEvent(new Event('input')); });
  await sleep(800);
  var nx = await page.evaluate(function () { return window.OrigamiStudio.doc.params.nx; });
  ok(nx === 9, 'pattern param slider rebuilds (nx=' + nx + ')');
  // 6. grab interaction
  await page.click('#togGrab'); await sleep(200);
  var gp = await page.evaluate(function () { var r = document.getElementById('glCanvas').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(gp[0], gp[1]); await page.mouse.down(); await page.mouse.move(gp[0] + 60, gp[1] - 80, { steps: 8 }); await sleep(300);
  var grabbing = await page.evaluate(function () { return !!window.OrigamiStudio.solver.grab; });
  await page.mouse.up();
  ok(grabbing, 'grab mode drags a node');
  // 7. persistence across reload
  await page.reload(); await sleep(1500);
  var name = await page.evaluate(function () { return document.getElementById('modelName').textContent; });
  ok(name.indexOf('三浦') >= 0, 'current doc restored after reload: ' + name);

  // 8. paper selection: square / A4 in step mode
  await page.evaluate(function () { document.querySelector('.mode-tab[data-mode="step"]').click(); });
  await sleep(500);
  var papers = await page.evaluate(function () {
    var el = document.getElementById('stPaper');
    var v = window.OrigamiStudio.stepView;
    el.value = 'a4'; el.dispatchEvent(new Event('change'));
    var s = v.state(), a4 = [Math.round(s.width * 1000) / 1000, s.height];
    el.value = 'square'; el.dispatchEvent(new Event('change'));
    s = v.state();
    return { a4: a4, square: [s.width, s.height], opts: Array.from(el.options).map(function (o) { return o.value; }) };
  });
  ok(papers.opts.join(',') === 'square,a4', '纸张选择有 正方形 / A4 两种');
  ok(Math.abs(papers.a4[0] - Math.SQRT1_2) < 2e-3 && Math.abs(papers.a4[1] - 1) < 1e-9, '选 A4 后纸张为 1:√2（' + papers.a4.join(' × ') + '）');
  ok(papers.square[0] === 1 && papers.square[1] === 1, '选正方形后纸张为 1:1');

  ok(!logs.length, 'no console errors ' + logs.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
