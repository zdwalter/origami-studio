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

  // 9. step editing: adjust a fold step's angle
  await page.evaluate(function () {
    document.querySelector('.mode-tab[data-mode="step"]').click();
    var items = Array.from(document.querySelectorAll('#tutList .lib-item'));
    items.filter(function (b) { return b.dataset.tut === 'glider'; })[0].click();
  });
  await sleep(1200);
  var edit = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView;
    v.gotoStep(12);
    var before = v.getSteps()[11].op.angle;
    v.setStepAngle(11, 120);
    var at120 = v.getSteps()[11].op.angle;
    var cp = v.getCreasePattern();
    var n120 = cp.lines.filter(function (l) { return l.type !== 'B' && l.foldAngle === 120; }).length;
    v.setStepAngle(11, 180);
    var after180 = v.getSteps()[11].op.angle;
    return { before: before, at120: at120, n120: n120, after180: after180 === undefined ? 'undefined' : after180, steps: v.getSteps().length };
  });
  ok(edit.before === 90, '第 12 步初始折角 90°');
  ok(edit.at120 === 120, '把第 12 步折角改成 120° 生效');
  ok(edit.n120 > 0, '折痕记录随之更新为 foldAngle=120（' + edit.n120 + ' 条）');
  ok(edit.after180 === 'undefined', '折角设回 180° 时恢复默认折平');
  ok(edit.steps === 12, '改折角不会丢步骤（' + edit.steps + ' 步）');

  // 改前面的步骤不能影响后面已有步骤
  var surgical = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView;
    v.gotoStep(12);
    function snap() {
      return {
        steps: v.getSteps().map(function (s) { return JSON.stringify([s.title, s.op.type, s.op.angle === undefined ? null : s.op.angle]); }),
        creases: v.state().creases.map(function (c) { return c.stage + ':' + c.foldAngle; }),
        histLen: v.history.length, pos: v.pos
      };
    }
    var before = snap();
    v.setStepAngle(4, 100);            // 第 5 步 折右边 → 100°
    var after = snap();
    var changedSteps = [];
    before.steps.forEach(function (s, i) { if (s !== after.steps[i]) changedSteps.push(i + 1); });
    var changedCreases = 0;
    before.creases.forEach(function (c, i) { if (c !== after.creases[i]) changedCreases++; });
    return {
      changedSteps: changedSteps, changedCreases: changedCreases,
      histLenSame: before.histLen === after.histLen && before.pos === after.pos,
      laterIntact: after.steps.slice(5).join('|') === before.steps.slice(5).join('|'),
      ang5: v.getSteps()[4].op.angle
    };
  });
  ok(surgical.ang5 === 100, '改第 5 步折角为 100° 生效');
  ok(surgical.changedSteps.join(',') === '5', '只有第 5 步的数据被改（其它步骤原样）');
  ok(surgical.laterIntact, '后续已有步骤完全不受影响');
  ok(surgical.histLenSame, '历史长度与当前位置不变');
  ok(surgical.changedCreases > 0 && surgical.changedCreases <= 4, '只更新这一步自己的折痕（' + surgical.changedCreases + ' 条）');

  // 10. project export is identical no matter which mode you export from
  var exports = await page.evaluate(async function () {
    var S = window.OrigamiStudio;
    var items = Array.from(document.querySelectorAll('#tutList .lib-item')).filter(function (b) { return b.dataset.tut === 'glider2'; });
    document.querySelector('.mode-tab[data-mode="step"]').click();
    if (items[0]) items[0].click();
    await new Promise(function (r) { setTimeout(r, 900); });
    function build() {
      var sv = S.stepView, doc = S.doc, svSteps = sv && sv.getSteps ? sv.getSteps() : [];
      var out = { app: 'origami-studio', version: 1, doc: doc, front: S.front, back: S.back, sim: S.sim, target: S.target };
      if (svSteps.length) {
        var scp = sv.getCreasePattern();
        if (scp && scp.lines && scp.lines.length) { scp.name = 'x'; scp.description = 'y'; out.doc = scp; }
        var sz = sv.state(); out.width = sz.width; out.height = sz.height;
        out.steps = svSteps.map(function (st) { return { title: st.title, description: st.description, op: st.op }; });
      }
      return JSON.stringify(out);
    }
    var inStep = build();
    document.querySelector('.mode-tab[data-mode="sim"]').click();
    await new Promise(function (r) { setTimeout(r, 900); });
    var inSim = build();
    return { same: inStep === inSim, steps: JSON.parse(inStep).steps.length, w: JSON.parse(inSim).width };
  });
  ok(exports.steps === 11, '工程文件始终带 11 步（' + exports.steps + ' 步）');
  ok(exports.same, '分步折叠 / 3D 仿真 两种模式导出的工程文件内容一致');
  ok(Math.abs(exports.w - Math.SQRT1_2) < 1e-9, '导出纸张尺寸取分步折叠的纸（' + exports.w.toFixed(3) + '）');

  // 11. GitHub source entry points
  var gh = await page.evaluate(function () {
    var btn = document.getElementById('btnGithub');
    var inHelp = document.querySelector('#helpModal a[href*="github.com/zdwalter/origami-studio"]');
    return {
      btn: btn ? btn.getAttribute('href') : null,
      btnTarget: btn ? btn.getAttribute('target') : null,
      btnVisible: btn ? btn.getBoundingClientRect().width > 0 : false,
      helpLink: inHelp ? inHelp.getAttribute('href') : null
    };
  });
  ok(gh.btn === 'https://github.com/zdwalter/origami-studio' && gh.btnVisible, '顶栏有 GitHub 源码按钮（新窗口打开）');
  ok(gh.btnTarget === '_blank', 'GitHub 按钮在新标签页打开');
  ok(gh.helpLink === gh.btn, '帮助面板里也有源码地址');

  // 12. 「压痕」：一步折了再展开，只留折痕
  var crease = await page.evaluate(function () {
    document.querySelector('.mode-tab[data-mode="step"]').click();
    var v = window.OrigamiStudio.stepView;
    v.reset(1, 1);
    document.getElementById('stCreaseOnly').click();
    v.setCreaseOnly(true);
    v.ui = { mode: 'side', line: { a: [0.5, 0], b: [0.5, 1] } };
    v._updatePreview([0.2, 0.5]);
    v._commit();
    var st = v.state(), step = v.getSteps()[0];
    var out = { type: step && step.op.type, facets: st.facets.length, creases: st.creases.length, creaseOnly: v.creaseOnly };
    document.getElementById('stCreaseOnly').click();
    return out;
  });
  ok(crease.type === 'crease', '「压痕」按钮折一下再展开，记成压痕步骤');
  ok(crease.facets === 1 && crease.creases === 1, '压痕后纸保持平面、留下 1 条折痕');

  // 13. 「打开某层」按钮：点纸面打开那一层所在的折
  var peel = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView, SF = window.StepFold;
    v.reset(1, 1); v.setCreaseOnly(false); v.setTool('line');
    v._userOp({ type: 'fold', a: [0.5, 0], b: [0, 0.5], side: [0.08, 0.08], kind: 'valley', scope: 'all' }, '折左上角', '');
    v._userOp({ type: 'fold', a: [0.5, 0], b: [0.5, 1], side: [0.2, 0.5], kind: 'valley', scope: 'all' }, '沿中线折', '');
    var st0 = v.state(), before = st0.facets.length, creases0 = st0.creases.length;
    document.getElementById('stPeel').click();
    var tool = v.tool;
    // 找一个有纸的平面点并掀开
    var pt = null;
    for (var y = 0.15; y < 0.95 && !pt; y += 0.1) {
      for (var x = 0.05; x < 0.95 && !pt; x += 0.1) if (SF.facetAt(st0, [x, y])) pt = [x, y];
    }
    var ok = v.unfoldLayerAt(pt);
    var st = v.state(), last = v.getSteps()[v.getSteps().length - 1];
    document.getElementById('stPeel').click();
    return { tool: tool, ok: ok, before: before, after: st.facets.length, creases: st.creases.length, creases0: creases0,
             title: last && last.title, type: last && last.op.type };
  });
  ok(peel.tool === 'peel', '「打开某层」按钮切到点选模式');
  ok(peel.ok && /打开第/.test(peel.title || ''), '点一下打开了该处最上面那一层所在的折（' + (peel.title || '') + '）');
  ok(peel.type === 'unfoldLayer', '「打开某层」记成一步（type=' + peel.type + '）');
  ok(peel.creases >= peel.creases0, '打开某层后折痕保留（' + peel.creases0 + ' → ' + peel.creases + '）');
  ok(peel.after < peel.before, '打开这一层所在的折后纸片回到折之前（' + peel.before + ' → ' + peel.after + ' 片）');

  // 14. 「点到对称线」：Canard 第 7 步的三角形 → 点顶上那层 → 点它的斜边，得到第 8 步「折前鸭翼」
  await page.evaluate(function () {
    document.querySelector('.mode-tab[data-mode="step"]').click();
    var it = Array.from(document.querySelectorAll('#tutList .lib-item')).filter(function (x) { return x.dataset.tut === 'canard'; })[0];
    it.click();
  });
  await sleep(1200);
  var ptAxis = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView, SF = window.StepFold, OG = window.OG;
    v.gotoStep(7);
    var model = v.model, target = SF.applyOp(v.state(), model.steps[7].op).state;
    v.history.length = 8; v.steps.length = 7; v.meta.length = 7; v.pos = 7; v.model = null; v._changed();
    document.querySelector('[data-stool="linefold"]').click();
    var tool = v.tool;
    var C = Math.SQRT1_2 / 2, edgeMid = [(C + 0.5) / 2, Math.SQRT1_2 / 4];
    function click(p) {
      var r = v.canvas.getBoundingClientRect(), s = v.toScreen(p);
      ['pointerdown', 'pointerup'].forEach(function (t) {
        v.canvas.dispatchEvent(new PointerEvent(t, { clientX: r.left + s[0], clientY: r.top + s[1], button: 0, bubbles: true, pointerId: 1 }));
      });
    }
    click([0.40, 0.25]);
    var picked = v.ui.mode === 'pt2axis';
    v.canvas.dispatchEvent(new PointerEvent('pointermove', (function () { var r = v.canvas.getBoundingClientRect(), s = v.toScreen(edgeMid); return { clientX: r.left + s[0], clientY: r.top + s[1], bubbles: true, pointerId: 1 }; })()));
    var hover = !!v.ui.hoverCrease;
    click(edgeMid);
    if (v.anim) v._finishAnim();
    var st = v.state();
    function view(s, p) {
      var top = null;
      s.facets.forEach(function (f) {
        var Q = f.poly.map(function (q) { return SF.affine.apply(f.T, q); });
        if (OG.pointInPoly(p, Q) && (!top || f.layer > top.layer)) top = f;
      });
      return top ? (SF.affine.det(top.T) > 0 ? 'F' : 'B') : '-';
    }
    var n = 0, bad = 0;
    for (var x = 0.005; x < Math.SQRT1_2; x += 0.01) for (var y = 0.005; y < 1; y += 0.01) {
      var a = view(target, [x, y]), b = view(st, [x, y]);
      if (a === '-' && b === '-') continue; n++; if (a !== b) bad++;
    }
    document.querySelector('[data-stool="line"]').click();
    return { tool: tool, picked: picked, hover: hover, steps: v.getSteps().length, n: n, bad: bad };
  });
  ok(ptAxis.tool === 'linefold' && ptAxis.picked, '「点到对称线」第一下选中了那一层上的点');
  ok(ptAxis.hover, '第二下靠近斜边时会高亮这条对称线');
  ok(ptAxis.steps === 8, '点完线就折好，记成第 8 步（共 ' + ptAxis.steps + ' 步）');
  ok(ptAxis.n > 1000 && ptAxis.bad === 0, '结果与教程第 8 步「折前鸭翼」逐点一致（' + ptAxis.bad + '/' + ptAxis.n + ' 点不同）');

  // 15. 翻面要有动画（整张纸绕竖直轴翻过去，中途立起来）
  var flip = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView, SF = window.StepFold;
    v.reset(1, 1); v.setTool('line');
    v._userOp({ type: 'fold', a: [0.5, 0], b: [0, 0.5], side: [0.08, 0.08], kind: 'valley', scope: 'all' }, '折左上角', '');
    if (v.anim) v._finishAnim();
    var before = v.state();
    v._userOp({ type: 'flip' }, '翻面', '');
    var a = v.anim;
    if (!a) return { anim: false };
    var metaType = a.meta.type, t0 = a.t0, widths = [];
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      a.t0 = performance.now() - t * 700;
      var ds = v._drawables(), xs = [];
      ds.forEach(function (d) { d.pts.forEach(function (q) { xs.push(q[0]); }); });
      widths.push(Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)));
    });
    a.t0 = t0;
    if (v.anim) v._finishAnim();
    var after = v.state();
    var same = SF.totalArea(before) === SF.totalArea(after);
    return { anim: true, metaType: metaType, widths: widths, area: same };
  });
  ok(flip.anim && flip.metaType === 'flip', '翻面会启动动画（meta=' + flip.metaType + '）');
  ok(flip.widths[2] < flip.widths[0] * 0.4, '翻面动画中途整张纸立起来（宽度 ' + flip.widths[0] + ' → ' + flip.widths[2] + ' px）');
  ok(flip.area, '翻面后纸张面积不变');

  // 16. 压痕可以当「边到边」的边，也可以当「点到对称线」的对称轴
  var creaseAs = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView, SF = window.StepFold, OG = window.OG;
    v.reset(1, 1); v.setTool('line'); v.setCreaseOnly(true);
    v.ui = { mode: 'side', line: { a: [0.2, 0.15], b: [0.8, 0.55] } };
    v._updatePreview([0.2, 0.6]); v._commit();
    v.setCreaseOnly(false);
    if (v.anim) v._finishAnim();
    var creases = v.state().creases.length;
    // (a) 边到边：最近“边”应该就是这条压痕
    var mid = [0.5, 0.35], near = v._nearestEdge(mid);
    var nIsCrease = !!near && Math.abs(OG.orient(near[0], near[1], mid)) / OG.dist(near[0], near[1]) < 0.02;
    // (b) 点到对称线：拿这条压痕当轴
    v.setTool('linefold');
    v.ui = { mode: 'pt2axis', p: [0.5, 0.8] };
    v._updatePreview([0.5, 0.35]);
    var hover = !!v.ui.hoverCrease, pv = v.ui.preview, pvOk = !!pv && !pv.res.error;
    if (pvOk) v._commit();
    if (v.anim) v._finishAnim();
    v.setTool('line');
    return { creases: creases, edgeOk: nIsCrease, axisOk: hover && pvOk, steps: v.getSteps().length };
  });
  ok(creaseAs.creases === 1 && creaseAs.edgeOk, '压痕可以当「边到边」的边被选中');
  ok(creaseAs.axisOk, '压痕可以当「点到对称线」的对称轴');
  ok(creaseAs.steps === 2, '用压痕当轴折完记成一步（共 ' + creaseAs.steps + ' 步）');

  // 17. 点到点 / 画线 会主动吸附到纸边和折痕
  var snapCrease = await page.evaluate(function () {
    var v = window.OrigamiStudio.stepView, OG = window.OG;
    v.reset(1, 1); v.setTool('line'); v.setCreaseOnly(true);
    v.ui = { mode: 'side', line: { a: [0.2, 0.15], b: [0.8, 0.55] } };
    v._updatePreview([0.2, 0.6]); v._commit();
    v.setCreaseOnly(false);
    if (v.anim) v._finishAnim();
    var c = v.state().creases[0];
    function distToCrease(p) { return Math.abs(OG.orient(c.a, c.b, p)) / OG.dist(c.a, c.b); }
    // 在折痕中点上方 8 像素处点（屏幕距离，和真实使用一致）
    var mid = OG.lerp(c.a, c.b, 0.5);
    var nx = -(c.b[1] - c.a[1]), ny = (c.b[0] - c.a[0]);
    var L = Math.hypot(nx, ny); nx /= L; ny /= L;
    var near = [mid[0] + nx * 8 / v.view.s, mid[1] + ny * 8 / v.view.s];
    var before = distToCrease(near), s = v._snap(near), after = distToCrease(s.p);
    // 纸边：离上边 8 像素、且远离顶点/中点的地方
    var edgePt = v._snap([0.36, 8 / v.view.s]);
    v.setTool('line');
    return { before: before, after: after, kind: s.kind, edgeKind: edgePt.kind, edgeY: edgePt.p[1] };
  });
  ok(snapCrease.kind === 'edge' && snapCrease.after < 1e-6, '点到点会吸附到折痕上（离折痕 ' + snapCrease.before.toFixed(4) + ' → ' + snapCrease.after.toFixed(6) + '）');
  ok(snapCrease.edgeKind === 'edge' && Math.abs(snapCrease.edgeY) < 1e-6, '点到点也会吸附到纸边（kind=' + snapCrease.edgeKind + ', y=' + snapCrease.edgeY.toFixed(6) + '）');

  ok(!logs.length, 'no console errors ' + logs.join(' | '));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL OK');
  process.exit(fails ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
