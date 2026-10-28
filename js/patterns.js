/*
 * patterns.js — parametric crease-pattern library.
 *   CPPatterns.list()            -> [{id,name,category,description,difficulty,params}]
 *   CPPatterns.categories        -> [{id,name}]
 *   CPPatterns.create(id, vals)  -> CP doc {name, description, width, height, lines, flatFoldable, foldPercent}
 * Paper coords y-down, sheet [0,w]x[0,h]. M/V as seen on the front (drawn) side; valley brings front faces together.
 * All geometry is exact (computed) so Maekawa & Kawasaki hold at interior vertices of flat-foldable patterns.
 */
(function (global) {
  'use strict';

  var T225 = Math.SQRT2 - 1; // tan(22.5°)

  function L(a, b, type, angle, stage) {
    return { a: a, b: b, type: type, angle: angle === undefined ? (type === 'M' || type === 'V' ? 180 : 0) : angle, stage: stage || 0 };
  }
  function boundary(w, h) { return [L([0, 0], [w, 0], 'B'), L([w, 0], [w, h], 'B'), L([w, h], [0, h], 'B'), L([0, h], [0, 0], 'B')]; }
  function opp(t) { return t === 'M' ? 'V' : 'M'; }

  // 菱形折（吉村折）的可折叠族：水平折痕折到 α 时，对角折痕必须折到 β(α)，否则纸面只能靠拉伸去凑。
  // 下面这些点是数值扫描出来的等距解（误差 < 1°、拉伸 < 0.4%）。
  // 数值扫描（含自交检查）得到的“无自交且等距”的可折叠族：水平角 → 对角角
  var DIAMOND_FAMILY = [[0, 0], [5, 17.5], [10, 32.5], [15, 37.5], [20, 42.5], [25, 47.5], [30, 50]];
  function diamondBeta(alpha) {
    for (var i = 1; i < DIAMOND_FAMILY.length; i++) {
      if (alpha <= DIAMOND_FAMILY[i][0]) {
        var a = DIAMOND_FAMILY[i - 1], b = DIAMOND_FAMILY[i];
        var f = (alpha - a[0]) / Math.max(1e-9, b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * f;
      }
    }
    return DIAMOND_FAMILY[DIAMOND_FAMILY.length - 1][1];
  }
  // 把“折叠进度 → 对角折角”做成表，交给求解器在中途插值（这样折叠过程本身也是等距的）
  function diamondCurve(alphaFull) {
    var table = [], i, t;
    for (i = 0; i <= 24; i++) { t = i / 24; table.push([t, Math.round(diamondBeta(alphaFull * t) * 10) / 10]); }
    return table;
  }

  // 剪折纸盒的展开图：盒底 (1-2d) 见方、四壁高 d。四角是剪开的废料，靠 removeCutIslands 去掉。
  function boxNetLines(d) {
    var out = [], lo = d, hi = 1 - d;
    // 四条盒壁：沿盒底边缘谷折 90°
    out.push(L([lo, lo], [hi, lo], 'V', 90), L([hi, lo], [hi, hi], 'V', 90),
      L([hi, hi], [lo, hi], 'V', 90), L([lo, hi], [lo, lo], 'V', 90));
    // 从盒底四角向外剪开，把四块废料与盒壁分开
    [[lo, lo], [hi, lo], [hi, hi], [lo, hi]].forEach(function (c) {
      out.push(L([c[0] < 0.5 ? 0 : 1, c[1]], c, 'C'));
      out.push(L([c[0], c[1] < 0.5 ? 0 : 1], c, 'C'));
    });
    return out;
  }

  var categories = [
    { id: 'basic', name: '基础折法' },
    { id: 'bases', name: '传统基本型' },
    { id: 'works', name: '立体器皿' },
    { id: 'tess', name: '镶嵌 / 刚性折' },
    { id: 'curved', name: '曲面 / 非平折' },
    { id: 'kiri', name: '剪纸 / 立体卡' }
  ];

  var defs = [
    // ---------------------------------------------------------------- basic
    {
      id: 'valley-half', name: '对折（谷折）', category: 'basic', difficulty: 1,
      description: '最基础的一次谷折：纸张沿中线对折，正面相合。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) { return { lines: [L([0, 0.5], [1, 0.5], 'V', p.angle)], flatFoldable: true }; }
    },
    {
      id: 'mountain-half', name: '对折（山折）', category: 'basic', difficulty: 1,
      description: '沿中线山折：折痕凸起，背面相合。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) { return { lines: [L([0.5, 0], [0.5, 1], 'M', p.angle)], flatFoldable: true }; }
    },
    {
      id: 'diagonal', name: '对角折', category: 'basic', difficulty: 1,
      description: '沿对角线谷折成三角形。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) { return { lines: [L([0, 1], [1, 0], 'V', p.angle)], flatFoldable: true }; }
    },
    {
      id: 'pleat', name: '阶梯折 / 手风琴折', category: 'basic', difficulty: 1,
      description: '等距平行折痕交替山谷，形成手风琴般的褶皱。',
      params: [{ key: 'n', label: '折痕数', min: 1, max: 15, step: 1, value: 7 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 160 }],
      build: function (p) {
        var out = [], n = Math.round(p.n);
        for (var i = 1; i <= n; i++) { var x = i / (n + 1); out.push(L([x, 0], [x, 1], i % 2 ? 'V' : 'M', p.angle)); }
        return { lines: out, flatFoldable: true };
      }
    },
    {
      id: 'blintz', name: '四角向心折（坐垫折）', category: 'basic', difficulty: 1,
      description: '四个角折向中心点，是许多作品的起手式。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) {
        return { lines: [L([0.5, 0], [1, 0.5], 'V', p.angle), L([1, 0.5], [0.5, 1], 'V', p.angle), L([0.5, 1], [0, 0.5], 'V', p.angle), L([0, 0.5], [0.5, 0], 'V', p.angle),
          L([0, 0], [1, 1], 'F'), L([1, 0], [0, 1], 'F')], flatFoldable: true };
      }
    },
    {
      id: 'letter', name: '三折页（信纸折）', category: 'basic', difficulty: 1,
      description: '两条平行谷折把纸三等分。真实折法是先折左边、再把右边盖上去，所以这里分两步折：滑块 0–50% 折第一道，50–100% 折第二道，两片纸就不会同时往同一个地方扫过去。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) {
        return {
          lines: [L([1 / 3, 0], [1 / 3, 1], 'V', p.angle, 0), L([2 / 3, 0], [2 / 3, 1], 'V', p.angle, 1)],
          flatFoldable: true, foldPercent: 1
        };
      }
    },
    // ---------------------------------------------------------------- bases
    {
      id: 'square-base', name: '正方基本型（预备基）', category: 'bases', difficulty: 2,
      description: '两条中线山折、一条对角线谷折，收拢成四层叠合的小正方形。纸鹤、百合等作品的起点。',
      params: [],
      build: function () {
        // centre vertex degree 6, sectors 45/45/90/45/45/90 → Kawasaki; 4M + 2V → Maekawa
        return {
          lines: [L([0.5, 0], [0.5, 1], 'M'), L([0, 0.5], [1, 0.5], 'M'), L([0, 0], [1, 1], 'V'), L([1, 0], [0, 1], 'F')],
          flatFoldable: true, foldPercent: 0.9
        };
      }
    },
    {
      id: 'waterbomb-base', name: '水雷基本型', category: 'bases', difficulty: 2,
      description: '两条对角线谷折、一条中线山折，收拢成三角形。是正方基本型的“内外翻转”。',
      params: [],
      build: function () {
        return {
          lines: [L([0, 0], [1, 1], 'V'), L([1, 0], [0, 1], 'V'), L([0, 0.5], [1, 0.5], 'M'), L([0.5, 0], [0.5, 1], 'F')],
          flatFoldable: true, foldPercent: 0.9
        };
      }
    },
    {
      id: 'kite-base', name: '风筝基本型', category: 'bases', difficulty: 1,
      description: '两条边折到对角线上（22.5° 角平分线），形成风筝形。',
      params: [{ key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 180 }],
      build: function (p) {
        return { lines: [L([0, 0], [1, 1], 'F'), L([0, 0], [1, T225], 'V', p.angle), L([0, 0], [T225, 1], 'V', p.angle)], flatFoldable: true };
      }
    },
    {
      id: 'fish-base', name: '鱼基本型', category: 'bases', difficulty: 2,
      description: '在对角两端各做一个风筝折，再把两侧压成兔耳。四条 22.5° 折痕两两交于另一条对角线上。',
      params: [],
      build: function () {
        var k = 1 / (1 + T225), R1 = [k, 1 - k], R2 = [1 - k, k], c = [0.5, 0.5];
        return {
          lines: [L([0, 0], R1, 'V'), L([0, 0], R2, 'V'), L([1, 1], R1, 'V'), L([1, 1], R2, 'V'),
            L(R1, [1, 0], 'V'), L(R2, [0, 1], 'V'), L(R1, c, 'M'), L(R2, c, 'M'), L([0, 0], [1, 1], 'F')],
          flatFoldable: true, foldPercent: 0.9
        };
      }
    },
    {
      id: 'bird-base', name: '鹤基本型（鸟基）', category: 'bases', difficulty: 3,
      description: '正方基本型经前后两次花瓣折得到，是传统纸鹤、拍翅鸟的基本型。八条风筝折痕交于中线上 tan(22.5°)/2 处。',
      params: [],
      build: function () {
        var t = 0.5 * T225, c = [0.5, 0.5];
        var P = { top: [0.5, t], bot: [0.5, 1 - t], left: [t, 0.5], right: [1 - t, 0.5] };
        return {
          lines: [
            // petal folds (kite lines) — mountain
            L([0, 0], P.top, 'M'), L([0, 0], P.left, 'M'), L([1, 0], P.top, 'M'), L([1, 0], P.right, 'M'),
            L([1, 1], P.right, 'M'), L([1, 1], P.bot, 'M'), L([0, 1], P.bot, 'M'), L([0, 1], P.left, 'M'),
            // inner midline segments — mountain ; outer midline segments — valley
            L(P.top, c, 'M'), L(P.left, c, 'M'), L(P.right, c, 'M'), L(P.bot, c, 'M'),
            L([0.5, 0], P.top, 'V'), L([0.5, 1], P.bot, 'V'), L([0, 0.5], P.left, 'V'), L([1, 0.5], P.right, 'V'),
            // leg diagonal — valley ; petal diagonal stays flat
            L([0, 0], [1, 1], 'V'), L([1, 0], [0, 1], 'F')
          ],
          flatFoldable: true, foldPercent: 0.75
        };
      }
    },
    // ---------------------------------------------------------------- tessellations
    {
      id: 'miura', name: '三浦折（Miura-ori）', category: 'tess', difficulty: 2,
      description: '平行四边形网格的刚性可折图案，可一拉即开、一推即合，用于太阳能帆板与地图折叠。',
      params: [{ key: 'nx', label: '列数', min: 2, max: 12, step: 1, value: 6 },
        { key: 'ny', label: '行数', min: 2, max: 12, step: 1, value: 6 },
        { key: 'skew', label: '倾斜角 °', min: 0, max: 40, step: 1, value: 20 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 160 }],
      build: function (p) {
        var nx = Math.round(p.nx), ny = Math.round(p.ny), out = [];
        var dx = 1 / nx, dy = 1 / ny, s = Math.min(Math.tan(p.skew * Math.PI / 180) * dy, dx * 0.45);
        function T(i) { return i % 2 ? 'M' : 'V'; }
        function X(i, j) { return i === 0 ? 0 : i === nx ? 1 : i * dx + (j % 2 ? s : 0); }
        // zig-zag lines: one assignment per line, alternating
        for (var i = 1; i < nx; i++) for (var j = 0; j < ny; j++) out.push(L([X(i, j), j * dy], [X(i, j + 1), (j + 1) * dy], T(i), p.angle));
        // straight lines: the segment next to the two acute sectors is the minority crease
        for (j = 1; j < ny; j++) for (i = 0; i < nx; i++) out.push(L([X(i, j), j * dy], [X(i + 1, j), j * dy], j % 2 ? T(i) : T(i + 1), p.angle));
        return { lines: out, flatFoldable: true, foldPercent: 0.7 };
      }
    },
    {
      id: 'yoshimura', name: '吉村折（钻石折）', category: 'tess', difficulty: 3,
      description: '菱形单元的山谷交替褶皱，易拉罐的压溃纹就是它。菱形格里水平折痕与对角折痕的折角并不相同：对角折角要按“可折叠族”跟着水平折角一起变（水平 40° 时对角 65°），这里已经把这条曲线配进去了。这个图案的刚性折叠范围很小：水平折角超过约 20–25°（对角约 43–50°）后，面板就只能靠互相穿过才能满足折角——所以上限卡在 20°，配合自碰撞后滑块 0–100% 全程都等距、不穿插。想看整根“压溃筒”请用“水雷镶嵌”或“三浦折”。',
      params: [{ key: 'nx', label: '列数', min: 2, max: 10, step: 1, value: 5 },
        { key: 'ny', label: '行数', min: 2, max: 10, step: 1, value: 5 },
        { key: 'angle', label: '水平折角', min: 5, max: 20, step: 1, value: 15 }],
      build: function (p) {
        var nx = Math.round(p.nx), ny = Math.round(p.ny), dx = 1 / nx, dy = 1 / ny, out = [], i, j;
        var hAng = p.angle, dAng = Math.round(diamondBeta(p.angle));
        for (j = 1; j < ny; j++) out.push(L([0, j * dy], [1, j * dy], 'V', hAng));
        for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
          var x0 = i * dx, y0 = j * dy, xm = x0 + dx / 2;
          if (j % 2 === 0) out.push(L([x0, y0], [xm, y0 + dy], 'M', dAng), L([xm, y0 + dy], [x0 + dx, y0], 'M', dAng));
          else out.push(L([x0, y0 + dy], [xm, y0], 'M', dAng), L([xm, y0], [x0 + dx, y0 + dy], 'M', dAng));
        }
        // 对角折痕挂上“可折叠族”曲线：折叠中途也跟着曲线走
        out.forEach(function (l) { if (l.type === 'M') l.curve = 'diamond'; });
        return { lines: out, flatFoldable: true, foldPercent: 1, curves: { diamond: diamondCurve(hAng) } };
      }
    },
    {
      id: 'waterbomb-tess', name: '水雷镶嵌（魔法球）', category: 'tess', difficulty: 3,
      description: '交错排列的水雷基本型，收拢时整体弯曲成筒或球形，又称“魔法球”。',
      params: [{ key: 'n', label: '密度', min: 2, max: 8, step: 1, value: 4 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 130 }],
      build: function (p) {
        var n = Math.round(p.n), d = 1 / (2 * n), out = [];
        for (var k = 1; k < 2 * n; k++) out.push(L([0, k * d], [1, k * d], 'V', p.angle));
        for (var m = -2 * n; m <= 2 * n; m++) {
          // x - y = 2 m d   and   x + y = 2 m d
          out.push(L([2 * m * d - 2, -2], [2 * m * d + 3, 3], 'M', p.angle));
          out.push(L([2 * m * d + 2, -2], [2 * m * d - 3, 3], 'M', p.angle));
        }
        return { lines: out, flatFoldable: true, foldPercent: 0.45 };
      }
    },
    {
      id: 'square-twist', name: '方形扭转', category: 'tess', difficulty: 3,
      description: '中央正方形旋转，四组褶向外放射。每个顶点扇区角为 90°/45°/90°/135°，满足川崎定理。',
      params: [{ key: 'size', label: '中心方块', min: 0.1, max: 0.3, step: 0.01, value: 0.18 }],
      build: function (p) {
        var a = p.size / 2, c = 0.5, out = [];
        var A = [c - a, c - a], B = [c + a, c - a], C = [c + a, c + a], D = [c - a, c + a];
        out.push(L(A, B, 'M'), L(B, C, 'M'), L(C, D, 'M'), L(D, A, 'M'));
        function ray(P, deg, type) { var r = deg * Math.PI / 180; out.push(L(P, [P[0] + 3 * Math.cos(r), P[1] + 3 * Math.sin(r)], type)); }
        // at each corner (directions in y-down degrees): l1 opposite of square type, l2 same
        ray(A, 135, 'V'); ray(A, 225, 'M');
        ray(B, 225, 'V'); ray(B, 315, 'M');
        ray(C, 315, 'V'); ray(C, 45, 'M');
        ray(D, 45, 'V'); ray(D, 135, 'M');
        return { lines: out, flatFoldable: true, foldPercent: 0.6 };
      }
    },
    // ---------------------------------------------------------------- curved / non flat
    {
      id: 'hypar', name: '双曲抛物面（Hypar）', category: 'curved', difficulty: 2,
      description: '同心正方形山谷交替加对角线，折叠后自发扭成马鞍形曲面。对角线为自由铰链。',
      params: [{ key: 'rings', label: '环数', min: 2, max: 12, step: 1, value: 6 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 110 }],
      build: function (p) {
        var n = Math.round(p.rings), out = [];
        for (var k = 1; k <= n; k++) {
          var r = 0.5 * k / (n + 1), t = k % 2 ? 'V' : 'M';
          var a = [0.5 - r, 0.5 - r], b = [0.5 + r, 0.5 - r], c = [0.5 + r, 0.5 + r], d = [0.5 - r, 0.5 + r];
          out.push(L(a, b, t, p.angle), L(b, c, t, p.angle), L(c, d, t, p.angle), L(d, a, t, p.angle));
        }
        out.push(L([0, 0], [1, 1], 'U'), L([1, 0], [0, 1], 'U'));
        return { lines: out, flatFoldable: false, foldPercent: 0.6 };
      }
    },
    {
      id: 'circular-pleat', name: '同心圆褶', category: 'curved', difficulty: 3,
      description: '同心圆折痕山谷交替（以多边形近似）。著名的“同心圆双曲面”，折叠后形成鞍形。',
      params: [{ key: 'rings', label: '环数', min: 2, max: 10, step: 1, value: 6 },
        { key: 'seg', label: '分段数', min: 16, max: 96, step: 4, value: 48 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 30 }],
      build: function (p) {
        var n = Math.round(p.rings), seg = Math.round(p.seg), out = [];
        for (var k = 1; k <= n; k++) {
          var r = 0.48 * k / n, t = k % 2 ? 'M' : 'V';
          for (var i = 0; i < seg; i++) {
            var a0 = 2 * Math.PI * i / seg, a1 = 2 * Math.PI * (i + 1) / seg;
            out.push(L([0.5 + r * Math.cos(a0), 0.5 + r * Math.sin(a0)], [0.5 + r * Math.cos(a1), 0.5 + r * Math.sin(a1)], t, p.angle));
          }
        }
        return { lines: out, flatFoldable: false, foldPercent: 0.4, approximate: true, stackedLayers: true };
      }
    },
    {
      id: 'kresling', name: 'Kresling 扭转筒', category: 'curved', difficulty: 3,
      description: '三角形网格的条带，卷成筒后可扭转压缩；常用于可展开结构与机器人。',
      params: [{ key: 'nx', label: '列数', min: 3, max: 10, step: 1, value: 6 },
        { key: 'ny', label: '层数', min: 1, max: 5, step: 1, value: 2 },
        { key: 'angle', label: '目标折角', min: 10, max: 180, step: 1, value: 60 }],
      build: function (p) {
        var nx = Math.round(p.nx), ny = Math.round(p.ny), out = [], w = 1, h = Math.min(1, 0.32 * ny), dx = w / nx, dy = h / ny;
        for (var j = 1; j < ny; j++) out.push(L([0, j * dy], [w, j * dy], 'M', p.angle));
        for (j = 0; j < ny; j++) for (var i = 0; i < nx; i++) {
          var x0 = i * dx, y0 = j * dy;
          out.push(L([x0, y0 + dy], [x0 + dx, y0], 'V', p.angle));
          if (i > 0) out.push(L([x0, y0 + dy], [x0, y0], 'M', p.angle * 0.5));
        }
        return { lines: out, width: w, height: h, flatFoldable: false, foldPercent: 0.6 };
      }
    },
    // ---------------------------------------------------------------- kirigami
    {
      id: 'popup-card', name: '立体贺卡（单阶）', category: 'kiri', difficulty: 2,
      description: '中线谷折的卡片上剪两刀，中间的舌片反向折出，打开卡片时弹出一个台阶。绿色为剪切线。',
      params: [{ key: 'angle', label: '开合角', min: 10, max: 170, step: 1, value: 90 },
        { key: 'depth', label: '台阶深度', min: 0.08, max: 0.22, step: 0.01, value: 0.18 },
        { key: 'width', label: '舌片宽度', min: 0.1, max: 0.6, step: 0.02, value: 0.34 }],
      build: function (p) {
        var d = p.depth, x0 = 0.5 - p.width / 2, x1 = 0.5 + p.width / 2, out = [];
        out.push(L([0, 0.5], [x0, 0.5], 'V', p.angle), L([x1, 0.5], [1, 0.5], 'V', p.angle));
        out.push(L([x0, 0.5 - d], [x0, 0.5 + d], 'C'), L([x1, 0.5 - d], [x1, 0.5 + d], 'C'));
        out.push(L([x0, 0.5 - d], [x1, 0.5 - d], 'V', p.angle), L([x0, 0.5], [x1, 0.5], 'M', p.angle), L([x0, 0.5 + d], [x1, 0.5 + d], 'V', p.angle));
        return { lines: out, flatFoldable: false, foldPercent: 1 };
      }
    },
    {
      id: 'popup-steps', name: '立体贺卡（双台阶）', category: 'kiri', difficulty: 3,
      description: '两组不同深度的舌片，开卡时弹出错落的两个台阶。',
      params: [{ key: 'angle', label: '开合角', min: 10, max: 170, step: 1, value: 90 }],
      build: function (p) {
        var out = [];
        var tabs = [[0.14, 0.40, 0.2], [0.6, 0.86, 0.12]];
        var lastX = 0;
        tabs.forEach(function (t) {
          var x0 = t[0], x1 = t[1], d = t[2];
          out.push(L([lastX, 0.5], [x0, 0.5], 'V', p.angle));
          out.push(L([x0, 0.5 - d], [x0, 0.5 + d], 'C'), L([x1, 0.5 - d], [x1, 0.5 + d], 'C'));
          out.push(L([x0, 0.5 - d], [x1, 0.5 - d], 'V', p.angle), L([x0, 0.5], [x1, 0.5], 'M', p.angle), L([x0, 0.5 + d], [x1, 0.5 + d], 'V', p.angle));
          lastX = x1;
        });
        out.push(L([lastX, 0.5], [1, 0.5], 'V', p.angle));
        return { lines: out, flatFoldable: false, foldPercent: 1 };
      }
    },
    {
      id: 'cube-net', name: '立方体展开图', category: 'kiri', difficulty: 2,
      description: '十字形立方体展开图（多余部分剪开成为翼片），全部 90° 谷折后合成立方体。',
      params: [],
      build: function () {
        // 3 x 4 grid (w = 0.75, h = 1); cross net in column 1 + row 1
        var s = 0.25, out = [], w = 0.75, h = 1;
        // folds between net squares (valley 90)
        out.push(L([s, s], [2 * s, s], 'V', 90), L([s, 2 * s], [2 * s, 2 * s], 'V', 90), L([s, 3 * s], [2 * s, 3 * s], 'V', 90));
        out.push(L([s, s], [s, 2 * s], 'V', 90), L([2 * s, s], [2 * s, 2 * s], 'V', 90));
        // cuts separating the unused corner regions from the net
        out.push(L([0, s], [s, s], 'C'), L([2 * s, s], [w, s], 'C'), L([0, 2 * s], [s, 2 * s], 'C'), L([2 * s, 2 * s], [w, 2 * s], 'C'));
        out.push(L([s, 0], [s, s], 'C'), L([2 * s, 0], [2 * s, s], 'C'), L([s, 2 * s], [s, h], 'C'), L([2 * s, 2 * s], [2 * s, h], 'C'));
        return { lines: out, width: w, height: h, flatFoldable: false, foldPercent: 1, removeCutIslands: true };
      }
    },

    // ================================================================ 立体器皿
    {
      id: 'box-net', name: '剪折纸盒（展开图）', category: 'works', difficulty: 3,
      description: '一张纸上剪出十字展开图，四条壁沿盒底 90° 立起；四个角是剪开的废料，会自动去掉。想要盒壁高一点就把“壁高”调大。',
      params: [{ key: 'depth', label: '壁高', min: 0.08, max: 0.30, step: 0.01, value: 0.18 }],
      build: function (p) { return { lines: boxNetLines(p.depth), flatFoldable: false, foldPercent: 1, removeCutIslands: true }; }
    },
    {
      id: 'tray-net', name: '剪折浅托盘', category: 'works', difficulty: 2,
      description: '同一个展开图，盒壁很矮时就是一只浅托盘；放钥匙、回形针、小零件都合适。',
      params: [{ key: 'depth', label: '壁高', min: 0.05, max: 0.14, step: 0.01, value: 0.08 }],
      build: function (p) { return { lines: boxNetLines(p.depth), flatFoldable: false, foldPercent: 1, removeCutIslands: true }; }
    },
    {
      id: 'z-fold', name: 'Z 形折（三折页）', category: 'works', difficulty: 1,
      description: '一条谷折一条山折交替，纸收成 Z 字形；贺卡、说明书、地图都用它做三折页。',
      params: [{ key: 'angle', label: '目标折角', min: 20, max: 180, step: 1, value: 180 }],
      build: function (p) { return { lines: [L([1 / 3, 0], [1 / 3, 1], 'V', p.angle), L([2 / 3, 0], [2 / 3, 1], 'M', p.angle)], flatFoldable: true, foldPercent: 1 }; }
    },
    {
      id: 'corner-fold', name: '单角折', category: 'works', difficulty: 1,
      description: '把左下角折到纸里，只有一个折痕、一次翻折——用来熟悉折叠程度滑块和翻片动画最合适。',
      params: [{ key: 'x', label: '折口位置', min: 0.3, max: 0.8, step: 0.01, value: 0.55 },
        { key: 'angle', label: '目标折角', min: 20, max: 180, step: 1, value: 180 }],
      build: function (p) { return { lines: [L([0, p.x], [p.x, 0], 'V', p.angle)], flatFoldable: true }; }
    },

    // ================================================================ 镶嵌
    {
      id: 'diagonal-pleat', name: '斜向手风琴折', category: 'tess', difficulty: 1,
      description: '一组 45° 斜向平行折痕，山谷交替。展开时是平的，收拢时沿对角线叠成一束，适合做包装纸的斜纹。',
      params: [{ key: 'n', label: '折痕数', min: 2, max: 14, step: 1, value: 7 },
        { key: 'angle', label: '目标折角', min: 20, max: 180, step: 5, value: 170 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i, c, a, b;
        for (i = 1; i <= n; i++) {
          c = 0.9 * i / (n + 1) - 0.45;           // 直线 x - y = c
          a = c >= 0 ? [c, 0] : [0, -c];
          b = c >= 0 ? [1, 1 - c] : [1 + c, 1];
          out.push(L(a, b, i % 2 ? 'V' : 'M', p.angle));
        }
        return { lines: out, flatFoldable: true };
      }
    },
    {
      id: 'tent-pleat', name: '帐篷折（三棱柱）', category: 'tess', difficulty: 2,
      description: '两条平行谷折各折 60°，纸就立成一个三棱柱帐篷；折角决定帐篷的高度。',
      params: [{ key: 'angle', label: '目标折角', min: 20, max: 170, step: 5, value: 60 },
        { key: 'offset', label: '折痕位置', min: 0.2, max: 0.4, step: 0.01, value: 0.33 }],
      build: function (p) {
        return { lines: [L([p.offset, 0], [p.offset, 1], 'V', p.angle), L([1 - p.offset, 0], [1 - p.offset, 1], 'V', p.angle)],
          flatFoldable: true, foldPercent: 1 };
      }
    },

    {
      id: 'herringbone-band', name: '人字褶带', category: 'tess', difficulty: 2,
      description: '长方形纸带上画一组 45° 平行折痕、山谷交替，折起来就成一条“人”字纹的折带，常用来做包装带与灯罩边。',
      params: [{ key: 'n', label: '折痕数', min: 3, max: 16, step: 1, value: 9 },
        { key: 'angle', label: '目标折角', min: 20, max: 175, step: 5, value: 120 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i, c, h = 0.5;
        for (i = 1; i <= n; i++) {
          c = 1.4 * i / (n + 1) - 0.7;
          out.push(L([c, 0], [c + h, h], i % 2 ? 'V' : 'M', p.angle));
        }
        return { lines: out, width: 1, height: h, flatFoldable: true, foldPercent: 1 };
      }
    },
    // ================================================================ 曲面 / 非平折
    {
      id: 'corrugated', name: '波纹板（瓦楞）', category: 'curved', difficulty: 1,
      description: '一排平行折痕山谷交替，全部折到 90°，平板立刻变成瓦楞纸板。折角越小，波纹越缓。',
      params: [{ key: 'n', label: '折痕数', min: 2, max: 16, step: 1, value: 8 },
        { key: 'angle', label: '目标折角', min: 10, max: 150, step: 5, value: 90 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i;
        for (i = 1; i <= n; i++) out.push(L([i / (n + 1), 0], [i / (n + 1), 1], i % 2 ? 'V' : 'M', p.angle));
        return { lines: out, flatFoldable: true, foldPercent: 1 };
      }
    },
    {
      id: 'spiral-curl', name: '螺旋卷', category: 'curved', difficulty: 2,
      description: '长方形纸上的平行折痕全部同向谷折，纸会自己卷成一条螺旋。折角决定卷得多紧。',
      params: [{ key: 'n', label: '折痕数', min: 3, max: 16, step: 1, value: 8 },
        { key: 'angle', label: '目标折角', min: 10, max: 150, step: 5, value: 45 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], h = 0.42, i;
        for (i = 1; i <= n; i++) out.push(L([i / (n + 1), 0], [i / (n + 1), h], 'V', p.angle));
        return { lines: out, width: 1, height: h, flatFoldable: true, foldPercent: 0.8 };
      }
    },
    {
      id: 'twisted-strip', name: '扭转带', category: 'curved', difficulty: 2,
      description: '斜向平行折痕全部同向谷折，一条纸带会自己扭成螺旋带；折得越多扭得越厉害。',
      params: [{ key: 'n', label: '折痕数', min: 3, max: 14, step: 1, value: 7 },
        { key: 'angle', label: '目标折角', min: 10, max: 150, step: 5, value: 80 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], h = 0.5, i, c;
        for (i = 1; i <= n; i++) {
          c = 1.2 * i / (n + 1) - 0.6;
          out.push(L([c, 0], [c + h, h], 'V', p.angle));
        }
        return { lines: out, width: 1, height: h, flatFoldable: true, foldPercent: 1 };
      }
    },

    {
      id: 'pleated-disk', name: '折扇圆盘（纸盘褶）', category: 'curved', difficulty: 3,
      description: '一圈从中心放射的折痕，山谷交替：平纸立刻变成带褶皱的圆盘，和纸盘、灯罩、伞面的褶法一样。',
      params: [{ key: 'n', label: '褶数', min: 8, max: 40, step: 2, value: 16 },
        { key: 'angle', label: '目标折角', min: 20, max: 120, step: 5, value: 55 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i, a0, c = [0.5, 0.5];
        for (i = 0; i < n; i++) {
          a0 = 2 * Math.PI * i / n;
          out.push(L(c, [c[0] + 1.5 * Math.cos(a0), c[1] + 1.5 * Math.sin(a0)], i % 2 ? 'M' : 'V', p.angle));
        }
        return { lines: out, flatFoldable: false, foldPercent: 1 };
      }
    },

    // ================================================================ 剪纸 / 立体卡
    {
      id: 'popup-tower', name: '立体高塔（多层弹出）', category: 'kiri', difficulty: 3,
      description: '一张卡纸剪出四段不同高度的舌片，全部折 90°：合起来是平面纸，打开就立起一座高低错落的塔。',
      params: [{ key: 'angle', label: '开合角', min: 20, max: 170, step: 5, value: 90 }],
      build: function (p) {
        var out = [], prev = 0;
        [[0.06, 0.22, 0.30], [0.26, 0.44, 0.24], [0.48, 0.64, 0.17], [0.68, 0.86, 0.10]].forEach(function (t) {
          var x0 = t[0], x1 = t[1], d = t[2];
          out.push(L([prev, 0.5], [x0, 0.5], 'V', p.angle));
          out.push(L([x0, 0.5 - d], [x0, 0.5 + d], 'C'), L([x1, 0.5 - d], [x1, 0.5 + d], 'C'));
          out.push(L([x0, 0.5 - d], [x1, 0.5 - d], 'V', p.angle),
            L([x0, 0.5], [x1, 0.5], 'M', p.angle),
            L([x0, 0.5 + d], [x1, 0.5 + d], 'V', p.angle));
          prev = x1;
        });
        out.push(L([prev, 0.5], [1, 0.5], 'V', p.angle));
        return { lines: out, flatFoldable: false, foldPercent: 1 };
      }
    },
    {
      id: 'popup-roof', name: '立体屋顶（小房子）', category: 'kiri', difficulty: 3,
      description: '中缝山折当屋脊、两侧谷折当屋檐，再加上两道剪口：合上是一张卡纸，打开就立起一座小房子。',
      params: [{ key: 'angle', label: '开合角', min: 20, max: 170, step: 5, value: 90 },
        { key: 'width', label: '屋宽', min: 0.2, max: 0.6, step: 0.02, value: 0.4 },
        { key: 'depth', label: '屋檐进深', min: 0.08, max: 0.24, step: 0.01, value: 0.2 }],
      build: function (p) {
        var x0 = 0.5 - p.width / 2, x1 = 0.5 + p.width / 2, d = p.depth, out = [];
        out.push(L([0, 0.5], [x0, 0.5], 'V', p.angle), L([x1, 0.5], [1, 0.5], 'V', p.angle));
        out.push(L([x0, 0.5 - d], [x0, 0.5 + d], 'C'), L([x1, 0.5 - d], [x1, 0.5 + d], 'C'));
        out.push(L([x0, 0.5 - d], [x1, 0.5 - d], 'V', p.angle),
          L([x0, 0.5], [x1, 0.5], 'M', p.angle),
          L([x0, 0.5 + d], [x1, 0.5 + d], 'V', p.angle));
        return { lines: out, flatFoldable: false, foldPercent: 1 };
      }
    },
    {
      id: 'wave-shell', name: '波浪壳', category: 'curved', difficulty: 2,
      description: '一排平行折痕，山谷交替且折角不同（谷折 60°、山折 120°），平纸就变成一片上下起伏的波浪板。',
      params: [{ key: 'n', label: '折痕数', min: 3, max: 16, step: 1, value: 10 },
        { key: 'a0', label: '谷折角', min: 10, max: 90, step: 5, value: 60 },
        { key: 'a1', label: '山折角', min: 60, max: 170, step: 5, value: 120 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i;
        for (i = 1; i <= n; i++) {
          var up = i % 2 === 1;
          out.push(L([i / (n + 1), 0], [i / (n + 1), 1], up ? 'V' : 'M', Math.round(up ? p.a0 : p.a1)));
        }
        return { lines: out, flatFoldable: true, foldPercent: 1 };
      }
    },
    {
      id: 'coil-corner', name: '卷角', category: 'curved', difficulty: 1,
      description: '只在右下角画一组平行谷折、折角逐渐加大，纸张的一角就会自己卷起来，其他部分保持平整。',
      params: [{ key: 'n', label: '折痕数', min: 3, max: 12, step: 1, value: 8 },
        { key: 'angle', label: '最大折角', min: 40, max: 175, step: 5, value: 170 },
        { key: 'size', label: '卷角范围', min: 0.2, max: 0.8, step: 0.02, value: 0.6 }],
      build: function (p) {
        var n = Math.round(p.n), out = [], i, k, ang;
        for (i = 1; i <= n; i++) {
          k = 2 - p.size * i / (n + 0.5);             // 直线 x + y = k，一道道切在右下角
          ang = Math.round(p.angle * i / n);
          out.push(L([k - 1, 1], [1, k - 1], 'V', ang));
        }
        return { lines: out, flatFoldable: true, foldPercent: 1 };
      }
    }
  ];

  function list() {
    return defs.filter(function (d) { return !d.hidden; }).map(function (d) {
      return { id: d.id, name: d.name, category: d.category, description: d.description, difficulty: d.difficulty, params: JSON.parse(JSON.stringify(d.params)) };
    });
  }
  function get(id) { for (var i = 0; i < defs.length; i++) if (defs[i].id === id) return defs[i]; return null; }
  function create(id, vals) {
    var d = get(id);
    if (!d) throw new Error('未知图案: ' + id);
    var p = {};
    d.params.forEach(function (q) { var v = vals && vals[q.key] !== undefined ? +vals[q.key] : q.value; p[q.key] = Math.min(q.max, Math.max(q.min, v)); });
    var r = d.build(p);
    var w = r.width || 1, h = r.height || 1;
    return {
      name: d.name, description: d.description, width: w, height: h, presetId: id, params: p,
      lines: boundary(w, h).concat(r.lines), flatFoldable: !!r.flatFoldable, foldPercent: r.foldPercent === undefined ? 0.8 : r.foldPercent,
      removeCutIslands: !!r.removeCutIslands, approximate: !!r.approximate, stackedLayers: !!r.stackedLayers,
      curves: r.curves || undefined
    };
  }

  global.CPPatterns = { list: list, create: create, categories: categories, get: function (id) { var d = get(id); return d ? list().filter(function (x) { return x.id === id; })[0] : null; } };
})(typeof window !== 'undefined' ? window : globalThis);
