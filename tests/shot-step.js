// Headless test of the step-fold mode inside the app.
var puppeteer = require('/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules/puppeteer-core');
var path = require('path'), fs = require('fs');
var OUT = '/tmp/shots/step';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 240000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  var page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  var logs = [];
  page.on('console', function (m) { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', function (e) { logs.push('[pageerror] ' + e.message); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.evaluate(function () { localStorage.clear(); });
  await page.reload(); await sleep(1500);
  await page.click('.mode-tab[data-mode="step"]'); await sleep(600);
  // free fold by mouse: drag diagonal then click lower-left side
  var box = await page.evaluate(function () { var r = document.getElementById('stepCanvas').getBoundingClientRect(); var v = window.OrigamiStudio.stepView; var a = v.toScreen([0, 1]), b = v.toScreen([1, 0]), c = v.toScreen([0.2, 0.9]); return { x: r.left, y: r.top, a: a, b: b, c: c }; });
  await page.mouse.move(box.x + box.a[0], box.y + box.a[1]); await page.mouse.down();
  await page.mouse.move(box.x + (box.a[0] + box.b[0]) / 2, box.y + (box.a[1] + box.b[1]) / 2, { steps: 5 });
  await page.mouse.move(box.x + box.b[0], box.y + box.b[1], { steps: 5 }); await page.mouse.up();
  await page.mouse.move(box.x + box.c[0], box.y + box.c[1], { steps: 3 }); await sleep(200);
  await page.screenshot({ path: OUT + '/01-preview.png' });
  await page.mouse.down(); await page.mouse.up();
  await sleep(330); await page.screenshot({ path: OUT + '/02-anim.png' });
  await sleep(700); await page.screenshot({ path: OUT + '/03-folded.png' });
  var st = await page.evaluate(function () { var v = window.OrigamiStudio.stepView; return { pos: v.pos, facets: v.state().facets.length, steps: document.querySelectorAll('#stSteps li').length }; });
  console.log('free fold', JSON.stringify(st));
  var models = ['plane', 'hat', 'cup', 'dog', 'fortune', 'fan'];
  for (var i = 0; i < models.length; i++) {
    await page.select('#stepModelSel', models[i]); await sleep(300);
    var n = await page.evaluate(function () { return window.OrigamiStudio.stepView.getInfo().modelSteps; });
    for (var k = 0; k < n; k++) { await page.click('#stNext'); await sleep(k === n - 1 ? 900 : 760); }
    console.log("model", models[i], Date.now()); await page.screenshot({ path: OUT + "/10-" + models[i] + ".png" });
  }
  await page.click('#stTo3D'); await sleep(3000);
  await page.screenshot({ path: OUT + '/20-to3d.png' });
  console.log('LOGS', logs.join('\n'));
  await browser.close();
})().catch(function (e) { console.error(e); process.exit(1); });
