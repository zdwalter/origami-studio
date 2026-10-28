var puppeteer = require('/Users/dw.zheng/Documents/work/dsh/games/.tools/node_modules/puppeteer-core');
var path = require('path'), fs = require('fs'), OUT = '/tmp/shots/resp';
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
(async function () {
  fs.mkdirSync(OUT, { recursive: true });
  var b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, protocolTimeout: 120000, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  var p = await b.newPage(), logs = [];
  p.on('pageerror', function (e) { logs.push(e.message); });
  await p.setViewport({ width: 400, height: 860, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await p.goto('file://' + path.resolve(__dirname, '../index.html')); await p.evaluate(function () { localStorage.clear(); }); await p.reload(); await sleep(1500);
  for (var w of [400, 1000]) {
    await p.setViewport({ width: w, height: w < 500 ? 860 : 900, deviceScaleFactor: 1, isMobile: w < 500, hasTouch: w < 500 });
    for (var m of ['sim', 'design', 'step']) {
      await p.evaluate(function (m) { document.querySelector('.mode-tab[data-mode="' + m + '"]').click(); }, m); await sleep(1200);
      var ov = await p.evaluate(function () { return document.documentElement.scrollWidth - window.innerWidth; });
      console.log(w, m, 'horizontal overflow px:', ov);
      await p.screenshot({ path: OUT + '/' + w + '-' + m + '.png', fullPage: false });
    }
  }
  console.log('errors', logs);
  await b.close();
})().catch(function (e) { console.error(e); process.exit(1); });
