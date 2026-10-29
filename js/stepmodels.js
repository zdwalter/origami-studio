/*
 * stepmodels.js — step-by-step tutorials for the "分步折叠" mode.
 * Coordinates of each op are in the folded-plane frame at that step (y down, initial sheet [0,w]x[0,h]).
 * op: {type:'fold', a, b, side:[x,y] (a point on the flap that moves), kind:'valley'|'mountain', scope:'all'|'top'|'bottom'}
 *     {type:'flip'} | {type:'rotate', deg}
 */
(function (global) {
  'use strict';
  var S2 = Math.SQRT1_2, T225 = Math.tan(Math.PI / 8);
  function F(title, description, a, b, side, kind, scope) { return { title: title, description: description, op: { type: 'fold', a: a, b: b, side: side, kind: kind || 'valley', scope: scope || 'all' } }; }
  function flip(title, d) { return { title: title || '翻面', description: d || '把纸整个翻过来。', op: { type: 'flip' } }; }
  function rot(deg, title, d) { return { title: title || '旋转', description: d || '把纸在桌面上旋转摆正。', op: { type: 'rotate', deg: deg } }; }

  var models = [];

  // ---------------------------------------------------------------- 纸飞机（经典飞镖）
  (function () {
    var bx = 0.5 - T225; // where the 22.5° folds meet the bottom edge
    models.push({
      id: 'plane', name: '纸飞机（经典飞镖）', difficulty: 1, frontColor: '#3e7bfa',
      displayAngles: { 4: 174, 5: 150, 6: 150 },
      description: '最经典的尖头纸飞机：两次把斜边折到中线，再对折并折出机翼。',
      width: 1, height: 1,
      steps: [
        F('折左上角', '将左上方的上边沿谷折到竖直中线上，左上角落在纸的中心。', [0.5, 0], [0, 0.5], [0.08, 0.08]),
        F('折右上角', '同样把右上方的上边沿折到中线上，形成尖尖的“屋顶”。', [0.5, 0], [1, 0.5], [0.92, 0.08]),
        F('再折左斜边', '把左侧新的斜边再次折到中线上，机头变得更尖。', [0.5, 0], [bx, 1], [0.04, 0.6]),
        F('再折右斜边', '右侧同理，斜边对齐中线。', [0.5, 0], [1 - bx, 1], [0.96, 0.6]),
        F('沿中线对折', '沿中线山折，左半边折到背后，折好的翻片都留在外侧。', [0.5, 0], [0.5, 1], [0.3, 0.7], 'mountain'),
        F('折下前机翼', '只取最上面一层，沿平行于机身的线向下折出机翼。', [0.62, 0], [0.62, 1], [0.8, 0.9], 'valley', 'top'),
        F('折下后机翼', '背面的一层向后折出另一侧机翼，与前翼对称。完成！', [0.62, 0], [0.62, 1], [0.8, 0.9], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 报纸帽
  (function () {
    var w = S2, c = w / 2, y1 = 0.5 + c; // corners land at (c, y1)
    models.push({
      id: 'hat', name: '报纸帽（头盔）', difficulty: 1, frontColor: '#f2b632',
      description: '用一张长方形纸（1:√2）折一顶可以戴的帽子。',
      width: w, height: 1,
      steps: [
        F('上下对折', '把上半张纸向下谷折，与下边对齐。折痕在上方。', [0, 0.5], [w, 0.5], [c, 0.2]),
        F('折左角', '把左上角向下折到中线上，斜边从顶部中点出发。', [c, 0.5], [0, y1], [0.03, 0.53]),
        F('折右角', '右上角同样折到中线，形成三角形帽顶。', [c, 0.5], [w, y1], [w - 0.03, 0.53]),
        F('折起前帽檐', '只把最上面一层的下边条向上折，盖住两个三角形的下缘。', [0, y1], [w, y1], [c, 0.95], 'valley', 'top'),
        F('折起后帽檐', '背面的一层下边条向后折。撑开下口就可以戴上啦！', [0, y1], [w, y1], [c, 0.95], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 纸杯
  (function () {
    // After the diagonal fold + rotation: base y = 0.5 from x = 0.5-√½ to 0.5+√½, apex (0.5, 0.5-√½).
    // Corner fold line makes 67.5° with the base so the flap's top edge ends horizontal at y = 1.5-√2
    // and the corner lands exactly on the opposite slanted edge.
    var yTop = 1.5 - Math.SQRT2, xa = S2 - 0.5, xb = 2.5 - 3 * S2;
    models.push({
      id: 'cup', name: '纸杯', difficulty: 2, frontColor: '#1f9d72',
      description: '一只真的可以装水（一小会儿）的纸杯：三角形、两角交叉、两片尖角向下。',
      width: 1, height: 1,
      steps: [
        F('对角对折', '沿对角线谷折，把左上半张折到右下半张上，得到三角形。', [1, 0], [0, 1], [0.1, 0.1]),
        rot(-135, '摆正三角形', '旋转纸张，使折边在下、直角尖朝上。'),
        F('左角折向右边', '把左下角折到右侧斜边上，让翻片的上边保持水平。', [xa, yTop], [xb, 0.5], [0.5 - S2 + 0.03, 0.49]),
        F('右角折向左边', '同样把右下角折到左侧斜边上，与刚才的翻片交叉。', [1 - xa, yTop], [1 - xb, 0.5], [0.5 + S2 - 0.03, 0.49]),
        F('前片尖角向下', '只把最前面一层的尖角向下折（真实折法中把它塞进前面的口袋）。', [-0.3, yTop], [1.3, yTop], [0.5, 0.5 - S2 + 0.03], 'valley', 'top'),
        F('后片尖角向后', '背面一层的尖角向后折。从上方撑开杯口，纸杯完成！', [-0.3, yTop], [1.3, yTop], [0.5, 0.5 - S2 + 0.03], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 小狗脸
  (function () {
    var apex = 0.5 + S2, L = 0.5 - S2, R = 0.5 + S2;
    models.push({
      id: 'dog', name: '小狗脸', difficulty: 1, frontColor: '#b07a4f',
      description: '幼儿园经典：一个三角形折出耷拉的耳朵和鼻子，画上眼睛就是小狗。',
      width: 1, height: 1,
      steps: [
        F('对角对折', '沿对角线把左下半张向上谷折，得到三角形。', [0, 0], [1, 1], [0.1, 0.9]),
        rot(135, '尖角朝下', '旋转纸张，长边在上、尖角朝下。'),
        F('折左耳', '把左边的角斜着向下折，形成一只耷拉的耳朵。', [0.30, 0.5], [L + 0.15, 0.65], [L + 0.03, 0.51]),
        F('折右耳', '右边的角同样向下折出另一只耳朵。', [0.70, 0.5], [R - 0.15, 0.65], [R - 0.03, 0.51]),
        F('折鼻子', '把最上一层的下尖角向上折一小段，做成鼻子。', [-0.2, apex - 0.16], [1.2, apex - 0.16], [0.5, apex - 0.03], 'valley', 'top'),
        F('折下巴', '背面那层的尖角向后折，让脸型更圆。画上眼睛就完成了！', [-0.2, apex - 0.1], [1.2, apex - 0.1], [0.5, apex - 0.02], 'mountain', 'bottom')
      ]
    });
  })();

  // ---------------------------------------------------------------- 东南西北
  (function () {
    var steps = [
      F('左上角折向中心', '把四个角依次折到纸的中心点。先折左上角。', [0.5, 0], [0, 0.5], [0.05, 0.05]),
      F('右上角折向中心', '右上角折到中心。', [0.5, 0], [1, 0.5], [0.95, 0.05]),
      F('右下角折向中心', '右下角折到中心。', [1, 0.5], [0.5, 1], [0.95, 0.95]),
      F('左下角折向中心', '左下角折到中心，得到一个小一圈的正方形（坐垫基本型）。', [0.5, 1], [0, 0.5], [0.05, 0.95]),
      flip('翻面', '把整张纸翻过来，光滑的一面朝上。'),
      F('上角折向中心', '再次把四个角折向中心。先折上角。', [0, 0.25], [1, 0.25], [0.5, 0.03]),
      F('下角折向中心', '下角折到中心。', [0, 0.75], [1, 0.75], [0.5, 0.97]),
      F('左角折向中心', '左角折到中心。', [0.25, 0], [0.25, 1], [0.03, 0.5]),
      F('右角折向中心', '右角折到中心，得到四个小正方形。', [0.75, 0], [0.75, 1], [0.97, 0.5]),
      flip('再翻面', '翻过来，可以看到四个可以翻开的方块，在里面写上“东南西北”吧！')
    ];
    models.push({ id: 'fortune', name: '东南西北（平面阶段）', difficulty: 2, frontColor: '#d94f8a', description: '童年游戏“东南西北”的折法：两轮四角向心折。最后撑开四个口袋即可玩耍（立体撑开步骤未模拟）。', width: 1, height: 1, steps: steps });
  })();

  // ---------------------------------------------------------------- 折扇
  (function () {
    var n = 8, steps = [];
    for (var k = n - 1; k >= 1; k--) {
      var x = k / n, valley = (n - 1 - k) % 2 === 0;
      steps.push(F((valley ? '谷折' : '山折') + ' 第 ' + (n - k) + ' 折', valley ? '把右侧所有层向前（朝你）折过来。' : '把右侧所有层向后折过去。', [x, 0], [x, 0.5], [x + 0.06, 0.25], valley ? 'valley' : 'mountain'));
    }
    steps[steps.length - 1].description += ' 把一端捏紧，展开另一端就是一把扇子！';
    models.push({ id: 'fan', name: '折扇（手风琴折）', difficulty: 1, frontColor: '#7a4bd1', description: '一前一后来回折叠的手风琴褶，是扇子、灯笼、弹簧的基础。', width: 1, height: 0.5, steps: steps });
  })();

  // ---------------------------------------------------------------- 正方形分割练习
  models.push({
    id: 'quarters', name: '四等分练习', difficulty: 1, frontColor: '#e8553d',
    description: '练习“仅顶层”折法：两次对折成四层后，只翻折最上面一层的散开角。',
    width: 1, height: 1,
    steps: [
      F('左右对折', '把右半边谷折到左半边上。', [0.5, 0], [0.5, 1], [0.8, 0.5]),
      F('上下对折', '再把下半边向上折，得到四层的小正方形。', [0, 0.5], [0.5, 0.5], [0.25, 0.8]),
      F('折顶层的角', '左上角是四层纸的散开角。只把最上一层折向对角（封闭的角无法单独折一层）。', [0, 0.5], [0.5, 0], [0.05, 0.05], 'valley', 'top'),
      flip('翻面', '翻过来看看背面。'),
      F('折背面的角', '同样只折最上一层的散开角。', [0, 0], [0.5, 0.5], [0.45, 0.05], 'valley', 'top')
    ]
  });

  // ---------------------------------------------------------------- 滑翔机（长方形纸）
  (function () {
    models.push({
      id: 'glider', name: '滑翔机（长方形纸）', difficulty: 3, frontColor: '#63a83a',
      displayAngles: { 5: 168, 8: 172, 9: 90, 11: 90 },
      description: '用一张长方形纸（1:√2，A4 比例）折的滑翔机：中折痕 → 两个上角折到中线 → 两条斜边折到中线 → 机头折下 → 对折 → 两侧机翼分别沿斜线折下（只折连通的整叠翻片）。',
      width: Math.SQRT1_2, height: 1,
      steps: [
        { title: '折出中折痕', description: '沿中线下折压出折痕再展开。', op: { type: 'crease', a: [0.354, 0], b: [0.354, 1], side: [0.274, 0.25] } },
        { title: '折左上角', description: '左上角沿 45° 折线折到中线上。', op: { type: 'fold', a: [0.354, 0], b: [0, 0.354], side: [0.02, 0.02] } },
        { title: '折右上角', description: '右上角同样折到中线，顶部变成尖三角。', op: { type: 'fold', a: [0.354, 0], b: [0.707, 0.354], side: [0.687, 0.02] } },
        { title: '折左边', description: '把左侧斜边沿角平分线折到中线上，机身变窄。', op: { type: 'fold', a: [0.354, 0], b: [-0.794, 2.772], side: [0.02, 0.5] } },
        { title: '折右边', description: '右侧同样折到中线。', op: { type: 'fold', a: [0.354, 0], b: [1.502, 2.772], side: [0.687, 0.5] } },
        { title: '折下机头', description: '把尖头向下折，尖端落在两侧折角的底边交点上。', op: { type: 'fold', a: [0, 0.25], b: [0.707, 0.25], side: [0.354, 0.005] } },
        { title: '翻面', description: '把纸整个翻过来。', op: { type: 'flip' } },
        { title: '翻面', description: '再翻一次，回到原来那一面。', op: { type: 'flip' } },
        { title: '沿中线对折', description: '沿中折痕把纸对折，成为窄窄的一条。', op: { type: 'fold', a: [0.354, 0], b: [0.354, 1], side: [0.125, 0.552], scope: 'topSheet' } },
        { title: '折下右侧机翼', description: '从机头斜向尾缘折下右侧机翼（自动选中连通的整叠翻片）。', op: { type: 'fold', a: [0.354, 0], b: [0.549, 0.981], side: [0.582, 0.551], scope: 'topSheet' } },
        { title: '翻面', description: '翻到另一面。', op: { type: 'flip' } },
        { title: '折下左侧机翼', description: '同样折下左侧机翼，滑翔机完成。', op: { type: 'fold', a: [0.707, 0], b: [0.512, 0.981], side: [0.479, 0.551], scope: 'topSheet' } },
      ]
    });
  })();

  function list() { return models.map(function (m) { return { id: m.id, name: m.name, difficulty: m.difficulty, description: m.description, steps: m.steps.length }; }); }
  function get(id) { for (var i = 0; i < models.length; i++) if (models[i].id === id) return JSON.parse(JSON.stringify(models[i])); return null; }
  global.StepModels = { list: list, get: get };
})(typeof window !== 'undefined' ? window : globalThis);
