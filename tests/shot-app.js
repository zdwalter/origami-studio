// Headless Chrome smoke test of the full app. Usage: node tests/shot-app.js [outDir]
var puppeteer = require('/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules/puppeteer-core');
var path = require('path'), fs = require('fs');
var OUT = process.argv[2] || '/tmp/shots/app';
var URL = 'file://' + path.resolve(__dirname, '..', process.env.PAGE || 'index.html');
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 240000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--allow-file-access-from-files']
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 960, deviceScaleFactor: 1 });
  var logs = [];
  page.on('console', function (m) { if (m.type() === 'error' || m.type() === 'warning') logs.push('[' + m.type() + '] ' + m.text()); });
  page.on('pageerror', function (e) { logs.push('[pageerror] ' + e.message); });
  await page.goto(URL, { waitUntil: 'load' });
  await page.evaluate(function () { localStorage.clear(); });
  await page.reload({ waitUntil: 'load' });
  await sleep(3500);
  await page.screenshot({ path: OUT + '/01-sim-bird.png' });
  var info = await page.evaluate(function () {
    var S = window.OrigamiStudio;
    return { name: document.getElementById('modelName').textContent, err: S.solver.creaseError(), fp: S.fp, target: S.target, lib: document.querySelectorAll('#libList .lib-item').length };
  });
  console.log(JSON.stringify(info));
  var shots = (process.env.PRESETS || 'miura,hypar,waterbomb-tess,square-twist,popup-card,cube-net,circular-pleat,kresling').split(',');
  for (var i = 0; i < shots.length; i++) {
    await page.evaluate(function (id) { document.querySelector('.lib-item[data-id="' + id + '"]').click(); }, shots[i]);
    await sleep(3200);
    await page.screenshot({ path: OUT + '/02-' + shots[i] + '.png' });
    var r = await page.evaluate(function () { var S = window.OrigamiStudio; return { err: +S.solver.creaseError().toFixed(2), strain: +S.solver.strain().max.toFixed(4), fp: +S.fp.toFixed(2) }; });
    console.log(shots[i], JSON.stringify(r));
  }
  if (process.env.FULL) {
    // modes
    await page.evaluate(function () { document.querySelector('.mode-tab[data-mode="design"]').click(); });
    await sleep(1500);
    await page.screenshot({ path: OUT + '/03-design.png' });
    await page.evaluate(function () { document.querySelector('.mode-tab[data-mode="step"]').click(); });
    await sleep(1200);
    await page.screenshot({ path: OUT + '/04-step.png' });
    await page.evaluate(function () { document.querySelector('.mode-tab[data-mode="sim"]').click(); });
    await page.evaluate(function () { document.getElementById('btnHelp').click(); });
    await sleep(300);
    await page.screenshot({ path: OUT + '/05-help.png' });
    await page.evaluate(function () { document.querySelector('#helpModal .modal-close').click(); document.getElementById('togStrain').click(); document.getElementById('btnTheme').click(); });
    await sleep(1200);
    await page.screenshot({ path: OUT + '/06-dark-strain.png' });
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
    await sleep(800);
    await page.screenshot({ path: OUT + '/07-mobile.png' });
  }
  console.log('LOGS:\n' + logs.join('\n'));
  await browser.close();
})().catch(function (e) { console.error('TEST FAILED', e); process.exit(1); });
